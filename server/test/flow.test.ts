import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, uuid } from './helpers';

let env: Awaited<ReturnType<typeof setup>>;
let pos1: string, pos2: string, manager: string;
const ids: Record<string, number> = {};

async function sell(token: string, lines: { sku: string; qty: number }[], extra: any = {}) {
  const body: any = { lines: lines.map((l, i) => ({ lineId: 'l' + i, productId: ids[l.sku], qty: l.qty })), couponCodes: extra.couponCodes ?? [], memberId: extra.memberId ?? null };
  const priced = await env.api('POST', '/api/pos/price', body, token);
  expect(priced.status).toBe(200);
  const total = priced.body.total;
  const cartId = extra.cartId ?? uuid();
  const res = await env.api('POST', '/api/pos/checkout', {
    ...body, idempotencyKey: extra.idempotencyKey ?? uuid(), cartId, billNo: extra.billNo ?? 'B' + Math.floor(Math.random() * 1e9),
    payments: [{ method: 'cash', amount: total, received: Math.ceil(total / 10000) * 10000 }], expectedTotal: total,
  }, token);
  return { ...res, total, cartId };
}

beforeAll(async () => {
  env = await setup();
  const rows = (await env.pool.query('SELECT id, sku FROM products')).rows;
  for (const r of rows) ids[r.sku] = r.id;
  pos1 = await env.login('4001', '1357', 'POS01');
  pos2 = await env.login('4002', '2468', 'POS02');
  manager = await env.login('2000', '246802', 'POS01');
  for (const t of [pos1, pos2]) expect((await env.api('POST', '/api/shifts/open', { openingFloat: 100000 }, t)).status).toBe(200);
});
afterAll(async () => env.close());

describe('end-to-end checkout', () => {
  it('records sale, deducts stock, issues one unique coupon (650 ฿ → 50 ฿ coupon) and is idempotent', async () => {
    const before = Number((await env.pool.query('SELECT qty FROM stock_levels WHERE branch_id=1 AND product_id=$1', [ids['RC-001']])).rows[0].qty);
    const key = uuid();
    const r = await sell(pos1, [{ sku: 'RC-001', qty: 2 }, { sku: 'HM-002', qty: 3 }], { idempotencyKey: key, billNo: 'P01-000001' });
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(false);
    const rc = r.body.receipt;
    expect(rc.sale.total).toBe(r.total);
    expect(rc.coupons).toHaveLength(1);
    expect(rc.coupons[0].code).toMatch(/^CPN-[A-Z0-9]{8}$/);
    expect(rc.coupons[0].reward).toEqual({ type: 'amount', value: 5000 });
    const after = Number((await env.pool.query('SELECT qty FROM stock_levels WHERE branch_id=1 AND product_id=$1', [ids['RC-001']])).rows[0].qty);
    expect(after).toBe(before - 2);

    // retry with the same idempotency key → same sale, no double stock cut, no second coupon
    const again = await env.api('POST', '/api/pos/checkout', {
      idempotencyKey: key, cartId: 'retry-cart', billNo: 'P01-000001', lines: [{ lineId: 'a', productId: ids['RC-001'], qty: 2 }], payments: [{ method: 'cash', amount: r.total, received: r.total }],
    }, pos1);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.receipt.sale.id).toBe(rc.sale.id);
    const after2 = Number((await env.pool.query('SELECT qty FROM stock_levels WHERE branch_id=1 AND product_id=$1', [ids['RC-001']])).rows[0].qty);
    expect(after2).toBe(after);
    const n = await env.pool.query('SELECT COUNT(*)::int n FROM coupons WHERE issued_sale_id=$1', [rc.sale.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('every coupon gets a different code', async () => {
    const a = await sell(pos1, [{ sku: 'RC-001', qty: 3 }]);
    const b = await sell(pos1, [{ sku: 'RC-001', qty: 3 }]);
    expect(a.body.receipt.coupons[0].code).not.toBe(b.body.receipt.coupons[0].code);
  });

  it('coupon: validate → reserve → only one of two concurrent POS can redeem → USED message', async () => {
    const issued = await sell(pos1, [{ sku: 'RC-001', qty: 3 }]);
    const code = issued.body.receipt.coupons[0].code;
    const v = await env.api('POST', '/api/pos/coupons/validate', { code }, pos2);
    expect(v.body.valid).toBe(true);

    // concurrent reservations from two carts: exactly one wins
    const [r1, r2] = await Promise.all([
      env.api('POST', '/api/pos/coupons/reserve', { code, cartId: 'cart-A' }, pos1),
      env.api('POST', '/api/pos/coupons/reserve', { code, cartId: 'cart-B' }, pos2),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const winner = r1.status === 200 ? { token: pos1, cart: 'cart-A' } : { token: pos2, cart: 'cart-B' };
    const loser = r1.status === 200 ? { token: pos2, cart: 'cart-B' } : { token: pos1, cart: 'cart-A' };

    // concurrent checkouts using the same coupon: loser's cart is not the reserver → rejected; winner succeeds
    const [c1, c2] = await Promise.all([
      sell(winner.token, [{ sku: 'RC-001', qty: 2 }], { couponCodes: [code], cartId: winner.cart }),
      sell(loser.token, [{ sku: 'RC-001', qty: 2 }], { couponCodes: [code], cartId: loser.cart }).catch((e) => e),
    ]);
    expect(c1.status).toBe(200);
    expect(c1.body.receipt.sale.couponDiscount).toBe(5000);
    expect(c2.status).not.toBe(200);

    const used = await env.api('POST', '/api/pos/coupons/validate', { code }, pos2);
    expect(used.body.valid).toBe(false);
    expect(used.body.reason).toBe('USED');
    expect(used.body.message).toContain('คูปองนี้ถูกใช้ไปแล้ว');
    const row = (await env.pool.query('SELECT * FROM coupons WHERE code=$1', [code])).rows[0];
    expect(row.status).toBe('USED');
    expect(row.redeemed_sale_id).toBe(c1.body.receipt.sale.id);
    expect(row.redeemed_terminal_id).not.toBeNull();
    expect(Number(row.discount_amount)).toBe(5000);
  });

  it('two POS redeeming the same ACTIVE coupon at the same instant (no reservation): exactly one succeeds', async () => {
    const issued = await sell(pos1, [{ sku: 'RC-001', qty: 3 }]);
    const code = issued.body.receipt.coupons[0].code;
    const res = await Promise.all([
      sell(pos1, [{ sku: 'RC-001', qty: 2 }], { couponCodes: [code] }),
      sell(pos2, [{ sku: 'RC-001', qty: 2 }], { couponCodes: [code] }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('releasing a reservation (bill cancelled) returns the coupon to ACTIVE', async () => {
    const issued = await sell(pos1, [{ sku: 'RC-001', qty: 3 }]);
    const code = issued.body.receipt.coupons[0].code;
    expect((await env.api('POST', '/api/pos/coupons/reserve', { code, cartId: 'cart-Z' }, pos1)).status).toBe(200);
    expect((await env.api('POST', '/api/pos/coupons/reserve', { code, cartId: 'cart-Y' }, pos2)).status).toBe(409);
    await env.api('POST', '/api/pos/coupons/release', { cartId: 'cart-Z' }, pos1);
    expect((await env.api('POST', '/api/pos/coupons/reserve', { code, cartId: 'cart-Y' }, pos2)).status).toBe(200);
  });

  it('concurrent sales cannot oversell stock', async () => {
    await env.pool.query('UPDATE stock_levels SET qty=5 WHERE branch_id=1 AND product_id=$1', [ids['HM-001']]);
    await env.pool.query('UPDATE stock_lots SET qty=5 WHERE branch_id=1 AND product_id=$1', [ids['HM-001']]);
    const res = await Promise.all([sell(pos1, [{ sku: 'HM-001', qty: 3 }]), sell(pos2, [{ sku: 'HM-001', qty: 3 }])]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
    const left = Number((await env.pool.query('SELECT qty FROM stock_levels WHERE branch_id=1 AND product_id=$1', [ids['HM-001']])).rows[0].qty);
    expect(left).toBe(2);
  });

  it('member earns points; full refund restocks, reverses points and cancels unused issued coupons', async () => {
    const m = (await env.pool.query(`SELECT id, points FROM members WHERE member_no='M100000002'`)).rows[0];
    const r = await sell(pos1, [{ sku: 'RC-001', qty: 3 }], { memberId: m.id });
    expect(r.status).toBe(200);
    expect(r.body.receipt.sale.pointsEarned).toBeGreaterThan(0);
    const after = (await env.pool.query('SELECT points FROM members WHERE id=$1', [m.id])).rows[0].points;
    expect(after).toBe(m.points + r.body.receipt.sale.pointsEarned);
    const couponCode = r.body.receipt.coupons[0].code;

    // cashier has no refund permission → requires approval
    const denied = await env.api('POST', `/api/pos/sales/${r.body.receipt.sale.id}/refund`, { idempotencyKey: uuid(), type: 'refund', reason: 'ลูกค้าเปลี่ยนใจ' }, pos1);
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('APPROVAL_REQUIRED');
    const appr = await env.api('POST', '/api/auth/approve', { employeeCode: '2000', pin: '246802', permission: 'pos.refund', reason: 'test' }, pos1);
    expect(appr.status).toBe(200);
    const ok = await env.api('POST', `/api/pos/sales/${r.body.receipt.sale.id}/refund`, { idempotencyKey: uuid(), type: 'refund', reason: 'ลูกค้าเปลี่ยนใจ', approvalId: appr.body.approvalId }, pos1);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('refunded');
    // approval is single-use
    const reuse = await env.api('POST', `/api/pos/sales/${r.body.receipt.sale.id}/refund`, { idempotencyKey: uuid(), type: 'refund', reason: 'again', approvalId: appr.body.approvalId }, pos1);
    expect(reuse.status).toBe(403);
    const pts = (await env.pool.query('SELECT points FROM members WHERE id=$1', [m.id])).rows[0].points;
    expect(pts).toBe(m.points);
    const c = (await env.pool.query('SELECT status FROM coupons WHERE code=$1', [couponCode])).rows[0];
    expect(c.status).toBe('CANCELLED');
    const audit = await env.pool.query(`SELECT COUNT(*)::int n FROM audit_logs WHERE action='sale.refund' AND approved_by IS NOT NULL`);
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  it('offline sync: duplicate-safe and tolerant of a reused bill number', async () => {
    const key = uuid();
    const payload = {
      idempotencyKey: key, cartId: 'offline-cart', billNo: 'P01-000001', offline: true, clientCreatedAt: new Date().toISOString(),
      lines: [{ lineId: 'a', productId: ids['DR-002'], qty: 2 }], payments: [{ method: 'cash', amount: 3400, received: 5000 }], expectedTotal: 3400,
    };
    const a = await env.api('POST', '/api/pos/checkout', payload, pos1);
    expect(a.status).toBe(200);
    expect(a.body.receipt.sale.billNo).toMatch(/^P01-000001-OFF/); // P01-000001 was already used online
    const b = await env.api('POST', '/api/pos/checkout', payload, pos1);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.receipt.sale.id).toBe(a.body.receipt.sale.id);
    // coupons are never accepted offline (they need server validation)
    const c = await env.api('POST', '/api/pos/checkout', { ...payload, idempotencyKey: uuid(), couponCodes: ['CPN-XXXXXXXX'] }, pos1);
    expect(c.body.code).toBe('OFFLINE_COUPON');
  });

  it('member: password login with last-4 initial password, change, card link and 4 identify methods', async () => {
    const m = (await env.pool.query(`SELECT id, phone, member_no FROM members WHERE member_no='M100000001'`)).rows[0];
    // initial password = last 4 digits of phone, must change afterwards
    const bad = await env.api('POST', '/api/member/login', { identifier: m.phone, password: '0000' });
    expect(bad.status).toBe(401);
    const ok = await env.api('POST', '/api/member/login', { identifier: m.phone, password: m.phone.slice(-4) });
    expect(ok.status).toBe(200);
    expect(ok.body.mustChangePassword).toBe(true);
    const tok = ok.body.token;
    expect((await env.api('POST', '/api/member/password', { password: m.phone.slice(-4) + '00' }, tok)).status).toBe(200);
    // old initial password no longer works, new one does (by member number too)
    expect((await env.api('POST', '/api/member/login', { identifier: m.phone, password: m.phone.slice(-4) })).status).toBe(401);
    const again = await env.api('POST', '/api/member/login', { identifier: m.member_no, password: m.phone.slice(-4) + '00' });
    expect(again.body.mustChangePassword).toBe(false);
    // extended profile
    expect((await env.api('PUT', '/api/member/profile', { address: '1 ถนนสุขุมวิท', gender: 'female', nationality: 'ไทย', country: 'Thailand', birthday: '1990-05-01' }, again.body.token)).status).toBe(200);
    const me = await env.api('GET', '/api/member/me', undefined, again.body.token);
    expect(me.body.country).toBe('Thailand');

    // cashier links an RFID card and a printed card number to the member
    expect((await env.api('POST', `/api/members/${m.id}/cards`, { code: '0012345678', kind: 'rfid' }, pos1)).status).toBe(200);
    expect((await env.api('POST', `/api/members/${m.id}/cards`, { code: 'PPC-000123', kind: 'number' }, pos1)).status).toBe(200);
    const other = (await env.pool.query(`SELECT id FROM members WHERE member_no='M100000002'`)).rows[0];
    expect((await env.api('POST', `/api/members/${other.id}/cards`, { code: '0012345678', kind: 'rfid' }, pos1)).body.code).toBe('CARD_TAKEN');
    for (const [method, value] of [['phone', m.phone], ['card', 'PPC-000123'], ['barcode', m.member_no], ['tap', '0012345678']]) {
      const r = await env.api('POST', '/api/pos/members/identify', { method, value }, pos1);
      expect(r.status).toBe(200);
      expect(r.body.id).toBe(m.id);
      expect(r.body.phone).toContain('xxx');
    }
    expect((await env.api('POST', '/api/pos/members/identify', { method: 'tap', value: '9999999999' }, pos1)).status).toBe(404);
    // card number also works for the website login
    expect((await env.api('POST', '/api/member/login', { identifier: 'PPC-000123', password: m.phone.slice(-4) + '00' })).status).toBe(200);
  });

  it('member password lockout after 5 failures', async () => {
    const m = (await env.pool.query(`SELECT phone FROM members WHERE member_no='M100000002'`)).rows[0];
    for (let i = 0; i < 4; i++) expect((await env.api('POST', '/api/member/login', { identifier: m.phone, password: 'xxxx' })).status).toBe(401);
    expect((await env.api('POST', '/api/member/login', { identifier: m.phone, password: 'xxxx' })).status).toBe(423);
    expect((await env.api('POST', '/api/member/login', { identifier: m.phone, password: m.phone.slice(-4) })).status).toBe(423);
  });

  it('PIN lockout after repeated failures', async () => {
    for (let i = 0; i < 5; i++) await env.api('POST', '/api/auth/login', { employeeCode: '5001', pin: '0000' });
    const r = await env.api('POST', '/api/auth/login', { employeeCode: '5001', pin: '9753' });
    expect(r.status).toBe(423);
  });

  it('shift close computes expected cash and difference', async () => {
    const cur = await env.api('GET', '/api/shifts/current', undefined, pos2);
    const expected = cur.body.cash.expected;
    const closed = await env.api('POST', `/api/shifts/${cur.body.shift.id}/close`, { countedCash: expected - 500 }, pos2);
    expect(closed.status).toBe(200);
    expect(Number(closed.body.shift.difference)).toBe(-500);
  });

  it('manager can see coupon dashboard stats', async () => {
    const s = await env.api('GET', '/api/marketing/coupons/stats', undefined, manager);
    expect(s.status).toBe(200);
    expect(s.body.issued).toBeGreaterThan(3);
    expect(s.body.redeemed).toBeGreaterThanOrEqual(2);
  });
});
