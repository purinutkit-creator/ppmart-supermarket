import { pool, tx, type Db } from '../db';
import { conflict, bad, randomCode } from '../util';
import { getSetting } from '../settings';
import { config } from '../config';
import { localParts, describeReward, type CouponInput, type CouponReward, type IssuanceDecision } from '../../../shared/pricing';
import { audit } from '../audit';

export interface CouponCheck {
  valid: boolean;
  code: string;
  status?: string;
  reason?: string;
  message: string;
  coupon?: any;
}

const fmtDT = (d: Date | string) =>
  new Date(d).toLocaleString('th-TH', { timeZone: config.timeZone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function normalizeCode(code: string) {
  return code.trim().toUpperCase();
}

export async function couponEvent(db: Db, e: { couponId: string; from?: string | null; to: string; saleId?: number | null; cartId?: string | null; staffId?: number | null; terminalId?: number | null; reason?: string | null }) {
  await db.query(
    `INSERT INTO coupon_events (coupon_id, from_status, to_status, sale_id, cart_id, staff_id, terminal_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [e.couponId, e.from ?? null, e.to, e.saleId ?? null, e.cartId ?? null, e.staffId ?? null, e.terminalId ?? null, e.reason ?? null]);
}

/**
 * Check a locked/loaded coupon row against all rules (except cart-dependent min spend/product, done by pricing).
 * `cartId` allows a coupon that is RESERVED by the same cart.
 */
export function checkCouponRow(c: any, o: { branchId: number; cartId?: string | null; memberId?: number | null; now?: Date; promotion?: any; redeemedBranchName?: string | null }): CouponCheck {
  const now = o.now ?? new Date();
  const code = c.code;
  const fail = (reason: string, message: string): CouponCheck => ({ valid: false, code, status: c.status, reason, message, coupon: c });
  if (c.status === 'USED') {
    return fail('USED', `คูปองนี้ถูกใช้ไปแล้ว\nใช้เมื่อ: ${c.redeemed_at ? fmtDT(c.redeemed_at) : '-'}\nสาขา: ${o.redeemedBranchName ?? c.redeemed_branch_name ?? '-'}`);
  }
  if (c.status === 'CANCELLED') return fail('CANCELLED', 'คูปองนี้ถูกยกเลิกแล้ว');
  if (c.status === 'VOID') return fail('VOID', 'คูปองนี้เป็นโมฆะ');
  if (c.status === 'PENDING_REVIEW') return fail('PENDING_REVIEW', 'คูปองนี้อยู่ระหว่างการตรวจสอบโดยผู้จัดการ');
  if (c.status === 'EXPIRED' || new Date(c.expires_at) < now) return fail('EXPIRED', `คูปองหมดอายุแล้วเมื่อ ${fmtDT(c.expires_at)}`);
  if (new Date(c.valid_from) > now) return fail('NOT_YET_VALID', `คูปองเริ่มใช้ได้ ${fmtDT(c.valid_from)}`);
  if (c.status === 'RESERVED' && c.reserved_cart_id !== o.cartId && c.reserved_until && new Date(c.reserved_until) > now) {
    return fail('RESERVED', 'คูปองนี้กำลังถูกใช้งานในบิลอื่น (ถูกจองไว้)');
  }
  if (c.branch_ids && c.branch_ids.length && !c.branch_ids.includes(o.branchId)) return fail('BRANCH', 'คูปองนี้ไม่สามารถใช้ได้ที่สาขานี้');
  if (c.member_id && c.member_id !== o.memberId) return fail('MEMBER', 'คูปองนี้ใช้ได้เฉพาะสมาชิกเจ้าของคูปอง กรุณาระบุสมาชิกก่อน');
  const p = o.promotion?.params || {};
  if (p.redeemDaysOfWeek?.length || (p.redeemTimeStart && p.redeemTimeEnd)) {
    const lp = localParts(now, config.timeZone);
    if (p.redeemDaysOfWeek?.length && !p.redeemDaysOfWeek.includes(lp.dow)) return fail('TIME', 'คูปองนี้ใช้ไม่ได้ในวันนี้');
    if (p.redeemTimeStart && p.redeemTimeEnd && !(lp.time >= p.redeemTimeStart && lp.time <= p.redeemTimeEnd)) {
      return fail('TIME', `คูปองนี้ใช้ได้เฉพาะช่วงเวลา ${p.redeemTimeStart.slice(0, 5)}–${p.redeemTimeEnd.slice(0, 5)}`);
    }
  }
  return { valid: true, code, status: c.status, message: 'Coupon Valid ✓', coupon: c };
}

async function loadCoupon(db: Db, code: string, lock: boolean) {
  const r = await db.query(
    `SELECT c.*, b.name AS redeemed_branch_name FROM coupons c LEFT JOIN branches b ON b.id = c.redeemed_branch_id
     WHERE c.code = $1 OR c.barcode_value = $1 ${lock ? 'FOR UPDATE OF c' : ''}`, [normalizeCode(code)]);
  return r.rows[0];
}

async function loadPromo(db: Db, id: number | null) {
  if (!id) return null;
  return (await db.query('SELECT * FROM promotions WHERE id=$1', [id])).rows[0] ?? null;
}

export function couponToInput(c: any): CouponInput {
  return { id: c.id, code: c.code, title: c.title, reward: c.reward as CouponReward, minSpend: Number(c.min_spend || 0) };
}

export function couponPublic(c: any) {
  return {
    id: c.id, code: c.code, barcodeValue: c.barcode_value, title: c.title, reward: c.reward, rewardText: describeReward(c.reward),
    minSpend: Number(c.min_spend || 0), status: c.status, expiresAt: c.expires_at, issuedAt: c.issued_at, validFrom: c.valid_from,
    redeemedAt: c.redeemed_at, memberId: c.member_id, promotionId: c.promotion_id, reservedCartId: c.reserved_cart_id,
    reservedUntil: c.reserved_until, discountAmount: c.discount_amount,
  };
}

/** Look up and validate (read-only). */
export async function validateCoupon(code: string, o: { branchId: number; cartId?: string | null; memberId?: number | null }): Promise<CouponCheck> {
  const c = await loadCoupon(pool, code, false);
  if (!c) return { valid: false, code: normalizeCode(code), reason: 'NOT_FOUND', message: 'ไม่พบคูปองนี้ในระบบ' };
  if (c.status === 'ACTIVE' && new Date(c.expires_at) < new Date()) {
    await expireCoupon(pool, c);
    c.status = 'EXPIRED';
  }
  return checkCouponRow(c, { ...o, promotion: await loadPromo(pool, c.promotion_id) });
}

async function expireCoupon(db: Db, c: any) {
  const r = await db.query(`UPDATE coupons SET status='EXPIRED' WHERE id=$1 AND status IN ('ACTIVE','RESERVED') RETURNING id`, [c.id]);
  if (r.rowCount) await couponEvent(db, { couponId: c.id, from: c.status, to: 'EXPIRED', reason: 'expired' });
}

/** ACTIVE -> RESERVED for a cart. Atomic: row lock guarantees two POS cannot reserve the same coupon. */
export async function reserveCoupon(code: string, o: { cartId: string; branchId: number; terminalId: number; staffId: number; memberId?: number | null }) {
  const minutes = (await getSetting('coupons')).reservationMinutes || config.couponReserveMinutes;
  return tx(async (db) => {
    const c = await loadCoupon(db, code, true);
    if (!c) throw bad('ไม่พบคูปองนี้ในระบบ', 'COUPON_NOT_FOUND');
    const chk = checkCouponRow(c, { ...o, promotion: await loadPromo(db, c.promotion_id) });
    if (!chk.valid) {
      if (chk.reason === 'EXPIRED' && c.status !== 'EXPIRED') await expireCoupon(db, c);
      throw conflict(chk.message, 'COUPON_' + chk.reason, { coupon: couponPublic(c) });
    }
    const r = await db.query(
      `UPDATE coupons SET status='RESERVED', reserved_cart_id=$2, reserved_terminal_id=$3, reserved_until = now() + ($4 || ' minutes')::interval
       WHERE id=$1 RETURNING *`, [c.id, o.cartId, o.terminalId, String(minutes)]);
    if (c.status !== 'RESERVED' || c.reserved_cart_id !== o.cartId) {
      await couponEvent(db, { couponId: c.id, from: c.status, to: 'RESERVED', cartId: o.cartId, staffId: o.staffId, terminalId: o.terminalId });
    }
    return couponPublic(r.rows[0]);
  });
}

/** RESERVED -> ACTIVE (bill cancelled or coupon removed). */
export async function releaseCoupons(cartId: string, opts: { code?: string; staffId?: number | null; reason?: string } = {}, db: Db = pool) {
  const r = await db.query(
    `UPDATE coupons SET status='ACTIVE', reserved_cart_id=NULL, reserved_terminal_id=NULL, reserved_until=NULL
     WHERE status='RESERVED' AND reserved_cart_id=$1 ${opts.code ? 'AND code=$2' : ''} RETURNING id`,
    opts.code ? [cartId, normalizeCode(opts.code)] : [cartId]);
  for (const row of r.rows) await couponEvent(db, { couponId: row.id, from: 'RESERVED', to: 'ACTIVE', cartId, staffId: opts.staffId, reason: opts.reason || 'released' });
  return r.rowCount ?? 0;
}

/** Background housekeeping: release timed-out reservations and expire old coupons. */
export async function sweepCoupons() {
  await tx(async (db) => {
    const rel = await db.query(
      `UPDATE coupons SET status='ACTIVE', reserved_cart_id=NULL, reserved_terminal_id=NULL, reserved_until=NULL
       WHERE status='RESERVED' AND reserved_until < now() RETURNING id`);
    for (const row of rel.rows) await couponEvent(db, { couponId: row.id, from: 'RESERVED', to: 'ACTIVE', reason: 'reservation timeout' });
    const exp = await db.query(`UPDATE coupons SET status='EXPIRED' WHERE status='ACTIVE' AND expires_at < now() RETURNING id`);
    for (const row of exp.rows) await couponEvent(db, { couponId: row.id, from: 'ACTIVE', to: 'EXPIRED', reason: 'expired' });
  });
}

/** Inside checkout transaction: lock & validate coupons that will be redeemed by this sale. */
export async function lockCouponsForCheckout(db: Db, codes: string[], o: { cartId: string; branchId: number; memberId?: number | null }) {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const raw of codes) {
    const code = normalizeCode(raw);
    if (seen.has(code)) throw bad(`สแกนคูปอง ${code} ซ้ำในบิลเดียวกัน`, 'COUPON_DUPLICATE');
    seen.add(code);
    const c = await loadCoupon(db, code, true);
    if (!c) throw conflict(`ไม่พบคูปอง ${code}`, 'COUPON_NOT_FOUND');
    const chk = checkCouponRow(c, { ...o, promotion: await loadPromo(db, c.promotion_id) });
    if (!chk.valid) throw conflict(`${code}: ${chk.message}`, 'COUPON_' + chk.reason, { coupon: couponPublic(c) });
    out.push(c);
  }
  return out;
}

/** RESERVED/ACTIVE -> USED inside the checkout transaction (rows already locked). */
export async function redeemCouponsInTx(db: Db, coupons: { row: any; amount: number }[], s: { saleId: number; branchId: number; terminalId: number; staffId: number; cartId: string }) {
  for (const { row, amount } of coupons) {
    const r = await db.query(
      `UPDATE coupons SET status='USED', redeemed_sale_id=$2, redeemed_branch_id=$3, redeemed_terminal_id=$4, redeemed_staff_id=$5,
         redeemed_at=now(), discount_amount=$6, reserved_until=NULL
       WHERE id=$1 AND status IN ('ACTIVE','RESERVED') AND (status='ACTIVE' OR reserved_cart_id=$7 OR reserved_until < now())`,
      [row.id, s.saleId, s.branchId, s.terminalId, s.staffId, amount, s.cartId]);
    if (r.rowCount !== 1) throw conflict(`คูปอง ${row.code} ถูกใช้ไปแล้ว`, 'COUPON_USED');
    await couponEvent(db, { couponId: row.id, from: row.status, to: 'USED', saleId: s.saleId, cartId: s.cartId, staffId: s.staffId, terminalId: s.terminalId });
  }
}

export async function generateUniqueCoupon(db: Db, values: Record<string, any>): Promise<any> {
  for (let i = 0; i < 10; i++) {
    const code = 'CPN-' + randomCode(8);
    const cols = ['code', 'barcode_value', ...Object.keys(values)];
    const vals = [code, code, ...Object.values(values)];
    const r = await db.query(
      `INSERT INTO coupons (${cols.join(',')}) VALUES (${cols.map((_, k) => '$' + (k + 1)).join(',')}) ON CONFLICT DO NOTHING RETURNING *`,
      vals);
    if (r.rowCount) return r.rows[0];
  }
  throw new Error('Could not generate unique coupon code');
}

/** Issue receipt coupons for a completed sale (inside the checkout transaction, BEFORE printing). */
export async function issueCouponsInTx(db: Db, decisions: IssuanceDecision[], s: { saleId: number; branchId: number; terminalId: number; staffId: number; memberId: number | null }) {
  const issued: any[] = [];
  for (const d of decisions) {
    const prm = d.promotion.params || {};
    const reward: CouponReward = prm.reward || { type: 'amount', value: 0 };
    const validDays = Number(prm.validDays || 30);
    const expiresAt = prm.expiresOn ? new Date(prm.expiresOn + 'T23:59:59+07:00') : new Date(Date.now() + validDays * 86400000);
    const validFrom = prm.validFromNextDay ? new Date(Date.now() + 86400000) : new Date();
    for (let i = 0; i < d.count; i++) {
      const c = await generateUniqueCoupon(db, {
        promotion_id: d.promotionId, member_id: prm.memberBound ? s.memberId : null, source: 'receipt', reward: JSON.stringify(reward),
        title: prm.title || d.promotion.name, min_spend: Number(prm.redeemMinSpend || 0),
        branch_ids: prm.redeemBranchIds?.length ? prm.redeemBranchIds : null, status: 'ACTIVE',
        issued_sale_id: s.saleId, issued_branch_id: s.branchId, issued_terminal_id: s.terminalId,
        expires_at: expiresAt, valid_from: validFrom,
      });
      await couponEvent(db, { couponId: c.id, to: 'ACTIVE', saleId: s.saleId, staffId: s.staffId, terminalId: s.terminalId, reason: 'issued' });
      issued.push(couponPublic(c));
    }
    await db.query('UPDATE promotions SET usage_count = usage_count + $2 WHERE id=$1', [d.promotionId, d.count]);
  }
  return issued;
}

/** Apply refund policies to coupons linked to a refunded sale (inside the refund transaction). */
export async function applyRefundCouponPolicies(db: Db, saleId: number, fullRefund: boolean, staff: { id: number; name: string }) {
  const pol = await getSetting('coupons', db);
  const results: string[] = [];
  // Coupons that were USED by this sale
  if (fullRefund) {
    const used = await db.query(`SELECT * FROM coupons WHERE redeemed_sale_id=$1 AND status='USED' FOR UPDATE`, [saleId]);
    for (const c of used.rows) {
      if (pol.onRedeemedOrderRefund === 'reactivate') {
        await db.query(`UPDATE coupons SET status='ACTIVE', redeemed_sale_id=NULL, redeemed_branch_id=NULL, redeemed_terminal_id=NULL,
          redeemed_staff_id=NULL, redeemed_at=NULL, discount_amount=NULL, reserved_cart_id=NULL WHERE id=$1`, [c.id]);
        await couponEvent(db, { couponId: c.id, from: 'USED', to: 'ACTIVE', saleId, staffId: staff.id, reason: 'refund policy: reactivate' });
        results.push(`คืนคูปอง ${c.code} เป็น ACTIVE`);
      } else if (pol.onRedeemedOrderRefund === 'reissue') {
        const n = await generateUniqueCoupon(db, {
          promotion_id: c.promotion_id, member_id: c.member_id, source: 'replacement', reward: JSON.stringify(c.reward), title: c.title,
          min_spend: c.min_spend, branch_ids: c.branch_ids, status: 'ACTIVE', issued_sale_id: c.issued_sale_id,
          issued_branch_id: c.issued_branch_id, issued_terminal_id: c.issued_terminal_id, expires_at: c.expires_at, note: `แทนคูปอง ${c.code}`,
        });
        await db.query('UPDATE coupons SET replaced_by=$2 WHERE id=$1', [c.id, n.id]);
        await couponEvent(db, { couponId: n.id, to: 'ACTIVE', saleId, staffId: staff.id, reason: `replacement for ${c.code}` });
        results.push(`ออกคูปองใหม่ ${n.code} แทน ${c.code}`);
      }
      await audit({ staffId: staff.id, staffName: staff.name, action: 'coupon.refund_policy', entity: 'coupon', entityId: c.id, details: { policy: pol.onRedeemedOrderRefund, saleId } }, db);
    }
  }
  // Coupons that were ISSUED by this sale and not used yet
  const issued = await db.query(`SELECT * FROM coupons WHERE issued_sale_id=$1 AND status IN ('ACTIVE','RESERVED') FOR UPDATE`, [saleId]);
  for (const c of issued.rows) {
    if (pol.onIssuedOrderRefund === 'cancel') {
      await db.query(`UPDATE coupons SET status='CANCELLED', reserved_cart_id=NULL, reserved_until=NULL, note='ยกเลิกเนื่องจากบิลต้นทางถูกคืนเงิน' WHERE id=$1`, [c.id]);
      await couponEvent(db, { couponId: c.id, from: c.status, to: 'CANCELLED', saleId, staffId: staff.id, reason: 'source order refunded' });
      results.push(`ยกเลิกคูปอง ${c.code}`);
    } else if (pol.onIssuedOrderRefund === 'review') {
      await db.query(`UPDATE coupons SET status='PENDING_REVIEW', reserved_cart_id=NULL, reserved_until=NULL WHERE id=$1`, [c.id]);
      await couponEvent(db, { couponId: c.id, from: c.status, to: 'PENDING_REVIEW', saleId, staffId: staff.id, reason: 'source order refunded — manager review' });
      results.push(`ส่งคูปอง ${c.code} ให้ผู้จัดการตรวจสอบ`);
    }
    await audit({ staffId: staff.id, staffName: staff.name, action: 'coupon.source_refund_policy', entity: 'coupon', entityId: c.id, details: { policy: pol.onIssuedOrderRefund, saleId } }, db);
  }
  return results;
}
