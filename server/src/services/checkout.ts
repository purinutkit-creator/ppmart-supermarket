// Atomic checkout: one DB transaction records the sale, payments, stock, points and coupons.
import { z } from 'zod';
import { pool, tx, one, type Db } from '../db';
import { bad, conflict, forbidden } from '../util';
import { authorizeOrApproval, can, type StaffCtx } from '../auth';
import { getSetting } from '../settings';
import { config } from '../config';
import { moveStock } from './stock';
import { rowToPricingProduct, activePromotions } from './catalog';
import { lockCouponsForCheckout, redeemCouponsInTx, issueCouponsInTx, couponToInput, couponPublic } from './coupons';
import { earnPoints, spendPoints, recalcTier, pointsConfig } from './points';
import { priceCart, evaluateCouponIssuance, type PricingProduct } from '../../../shared/pricing';
import { parseWeightedBarcode } from '../../../shared/barcode';
import { audit } from '../audit';

export const PAYMENT_METHODS = ['cash', 'promptpay', 'transfer', 'credit_card', 'debit_card', 'ewallet', 'gift_card'] as const;

export const checkoutSchema = z.object({
  idempotencyKey: z.string().min(8).max(100),
  cartId: z.string().min(4).max(100),
  billNo: z.string().min(1).max(40),
  offline: z.boolean().optional().default(false),
  clientCreatedAt: z.string().optional(),
  memberId: z.number().int().nullable().optional(),
  lines: z.array(z.object({
    lineId: z.string(),
    productId: z.number().int(),
    qty: z.number().positive(),
    barcode: z.string().nullable().optional(),
    packQty: z.number().positive().optional(),
    priceSource: z.enum(['regular', 'pack', 'embedded', 'override']).optional().default('regular'),
    unitPrice: z.number().int().nonnegative().nullable().optional(),
    overrideApprovalId: z.string().nullable().optional(),
  })).min(1).max(500),
  promoCodes: z.array(z.string()).optional().default([]),
  couponCodes: z.array(z.string()).optional().default([]),
  manualDiscount: z.object({ type: z.enum(['amount', 'percent']), value: z.number().nonnegative(), reason: z.string().optional(), approvalId: z.string().nullable().optional() }).nullable().optional(),
  redeemPoints: z.number().int().nonnegative().optional().default(0),
  payments: z.array(z.object({
    method: z.enum(PAYMENT_METHODS),
    amount: z.number().int().positive(),
    received: z.number().int().nonnegative().nullable().optional(),
    reference: z.string().max(100).nullable().optional(),
    paymentIntentId: z.string().uuid().nullable().optional(),
    giftCardCode: z.string().nullable().optional(),
  })).min(1).max(10),
  expectedTotal: z.number().int().optional(),
});
export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** Load everything the printer/receipt needs for a sale. */
export async function receiptPayload(saleId: number, db: Db = pool) {
  const sale = await one(
    `SELECT s.*, t.code AS terminal_code, t.name AS terminal_name, b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone,
            b.tax_id AS branch_tax_id, st.name AS staff_name, st.employee_code,
            m.member_no, m.first_name, m.last_name, m.points AS member_points, tr.name AS tier_name
     FROM sales s JOIN terminals t ON t.id=s.terminal_id JOIN branches b ON b.id=s.branch_id JOIN staff st ON st.id=s.staff_id
     LEFT JOIN members m ON m.id=s.member_id LEFT JOIN tiers tr ON tr.id=m.tier_id WHERE s.id=$1`, [saleId], db);
  if (!sale) return null;
  const items = (await db.query('SELECT * FROM sale_items WHERE sale_id=$1 ORDER BY id', [saleId])).rows;
  const payments = (await db.query('SELECT * FROM sale_payments WHERE sale_id=$1 ORDER BY id', [saleId])).rows;
  const discounts = (await db.query('SELECT * FROM sale_discounts WHERE sale_id=$1 ORDER BY id', [saleId])).rows;
  const coupons = (await db.query(`SELECT * FROM coupons WHERE issued_sale_id=$1 ORDER BY issued_at`, [saleId])).rows.map(couponPublic);
  const redeemed = (await db.query(`SELECT * FROM coupons WHERE redeemed_sale_id=$1`, [saleId])).rows.map(couponPublic);
  return {
    sale: {
      id: sale.id, billNo: sale.bill_no, status: sale.status, createdAt: sale.created_at, offline: sale.offline,
      subtotal: sale.subtotal, discountTotal: sale.discount_total, couponDiscount: sale.coupon_discount, pointsDiscount: sale.points_discount,
      vatAmount: sale.vat_amount, total: sale.total, paidTotal: sale.paid_total, change: sale.change_amount,
      itemsCount: sale.items_count, linesCount: sale.lines_count, pointsEarned: sale.points_earned, pointsRedeemed: sale.points_redeemed,
    },
    terminal: { id: sale.terminal_id, code: sale.terminal_code, name: sale.terminal_name },
    branch: { id: sale.branch_id, name: sale.branch_name, address: sale.branch_address, phone: sale.branch_phone, taxId: sale.branch_tax_id },
    staff: { id: sale.staff_id, name: sale.staff_name, code: sale.employee_code },
    member: sale.member_id ? { id: sale.member_id, memberNo: sale.member_no, name: `${sale.first_name} ${sale.last_name ?? ''}`.trim(), tier: sale.tier_name, pointsBalance: sale.member_points } : null,
    items: items.map((i) => ({ id: i.id, productId: i.product_id, name: i.name, qty: i.qty, unitPrice: i.unit_price, discount: i.discount, total: i.line_total, isWeighted: i.is_weighted, barcode: i.barcode })),
    payments: payments.map((p) => ({ method: p.method, amount: p.amount, received: p.received, change: p.change_amount, reference: p.reference })),
    discounts: discounts.map((d) => ({ source: d.source, name: d.name, amount: d.amount })),
    coupons,
    redeemedCoupons: redeemed,
  };
}

export async function checkout(staff: StaffCtx, input: CheckoutInput, ip?: string) {
  if (!can(staff, 'pos.sell')) throw forbidden('ไม่มีสิทธิ์ขายสินค้า');
  if (!staff.terminalId) throw bad('เซสชันนี้ไม่ได้ผูกกับเครื่อง POS', 'NO_TERMINAL');

  // Idempotency: a retried request (network drop, offline sync) returns the original sale.
  const existing = await one('SELECT id FROM sales WHERE idempotency_key=$1', [input.idempotencyKey]);
  if (existing) return { duplicate: true, receipt: await receiptPayload(existing.id) };

  try {
    const saleId = await tx((db) => doCheckout(db, staff, input, ip));
    const receipt = await receiptPayload(saleId);
    return { duplicate: false, receipt };
  } catch (e: any) {
    if (e?.code === '23505' && String(e.constraint || '').includes('idempotency')) {
      const s = await one('SELECT id FROM sales WHERE idempotency_key=$1', [input.idempotencyKey]);
      if (s) return { duplicate: true, receipt: await receiptPayload(s.id) };
    }
    if (e?.code === '23505' && String(e.constraint || '').includes('bill_no')) {
      throw conflict('เลขที่บิลซ้ำสำหรับเครื่องนี้ กรุณาซิงก์เลขบิลใหม่', 'BILL_NO_TAKEN');
    }
    throw e;
  }
}

async function doCheckout(db: Db, staff: StaffCtx, input: CheckoutInput, ip?: string): Promise<number> {
  const terminal = (await db.query('SELECT * FROM terminals WHERE id=$1', [staff.terminalId])).rows[0];
  const branchId: number = terminal.branch_id;
  const posCfg = await getSetting('pos', db);
  const taxCfg = await getSetting('tax', db);
  const couponCfg = await getSetting('coupons', db);
  const storeCfg = await getSetting('store', db);

  // ---- shift ----
  const shift = (await db.query(`SELECT id FROM shifts WHERE terminal_id=$1 AND status='open'`, [terminal.id])).rows[0];
  if (!shift && posCfg.requireShift && !input.offline) throw conflict('ยังไม่ได้เปิดกะสำหรับเครื่องนี้', 'NO_SHIFT');

  if (input.offline) {
    const allowed: string[] = posCfg.offlineAllowedMethods || ['cash'];
    for (const p of input.payments) if (!allowed.includes(p.method)) throw bad(`การขายออฟไลน์รองรับเฉพาะ ${allowed.join(', ')}`, 'OFFLINE_METHOD');
    if (input.couponCodes.length) throw bad('ไม่สามารถใช้คูปองในโหมดออฟไลน์', 'OFFLINE_COUPON');
  }

  // ---- products ----
  const productIds = [...new Set(input.lines.map((l) => l.productId))];
  const prows = (await db.query('SELECT * FROM products WHERE id = ANY($1)', [productIds])).rows;
  const pmap = new Map<number, any>(prows.map((r) => [r.id, r]));
  const products = new Map<number, PricingProduct>();
  for (const id of productIds) {
    const r = pmap.get(id);
    if (!r) throw bad(`ไม่พบสินค้า #${id}`, 'PRODUCT_NOT_FOUND');
    if (!r.is_active) throw conflict(`สินค้า ${r.name} ถูกปิดการขาย`, 'PRODUCT_INACTIVE');
    if (r.sale_blocked) throw conflict(`สินค้า ${r.name} ห้ามจำหน่าย${r.block_reason ? ': ' + r.block_reason : ''}`, 'SALE_BLOCKED');
    products.set(id, rowToPricingProduct(r));
  }

  // ---- verify per-line price sources ----
  let overrideApprover: number | null = null;
  const pricingLines = [];
  for (const l of input.lines) {
    const p = pmap.get(l.productId);
    let unitPrice: number | null = null;
    let packQty = 1;
    if (l.priceSource === 'pack') {
      const bc = (await db.query('SELECT * FROM product_barcodes WHERE barcode=$1 AND product_id=$2', [l.barcode, l.productId])).rows[0];
      if (!bc) throw bad(`บาร์โค้ดแพ็ก ${l.barcode} ไม่ถูกต้อง`, 'BAD_BARCODE');
      packQty = Number(bc.pack_qty);
      unitPrice = bc.pack_price ?? Math.round(p.price * packQty);
    } else if (l.priceSource === 'embedded') {
      const parsed = l.barcode ? parseWeightedBarcode(l.barcode, posCfg.weightedBarcode) : null;
      if (!parsed || parsed.priceSatang == null) throw bad(`บาร์โค้ดราคา ${l.barcode} ไม่ถูกต้อง`, 'BAD_BARCODE');
      unitPrice = parsed.priceSatang; // qty must be 1 for price-embedded labels
      if (l.qty !== 1) throw bad('สินค้าบาร์โค้ดราคาต้องมีจำนวน 1', 'BAD_QTY');
    } else if (l.priceSource === 'override') {
      if (l.unitPrice == null) throw bad('ไม่ได้ระบุราคา', 'BAD_PRICE');
      const approver = await authorizeOrApproval(db, staff, 'pos.price_override', l.overrideApprovalId);
      overrideApprover = approver ?? overrideApprover;
      unitPrice = l.unitPrice;
    }
    if (!p.is_weighted && !Number.isInteger(l.qty)) throw bad(`${p.name} ต้องขายเป็นจำนวนเต็ม`, 'BAD_QTY');
    pricingLines.push({ input: l, packQty, line: { lineId: l.lineId, productId: l.productId, qty: l.qty, unitPrice } });
  }

  // ---- member ----
  let member: any = null;
  let tier: any = null;
  if (input.memberId) {
    member = (await db.query('SELECT * FROM members WHERE id=$1 FOR UPDATE', [input.memberId])).rows[0];
    if (!member || !member.is_active) throw bad('ไม่พบสมาชิก', 'MEMBER_NOT_FOUND');
    if (member.tier_id) tier = (await db.query('SELECT * FROM tiers WHERE id=$1', [member.tier_id])).rows[0];
  }

  // ---- points redemption ----
  const ptsCfg = await pointsConfig(db);
  let pointsValue = 0;
  if (input.redeemPoints > 0) {
    if (!member) throw bad('ต้องระบุสมาชิกเพื่อแลกคะแนน', 'MEMBER_REQUIRED');
    if (input.redeemPoints < (ptsCfg.minRedeem || 0)) throw bad(`แลกคะแนนขั้นต่ำ ${ptsCfg.minRedeem} คะแนน`, 'POINTS_MIN');
    if (member.points < input.redeemPoints) throw bad('คะแนนสะสมไม่เพียงพอ', 'POINTS_INSUFFICIENT');
    pointsValue = input.redeemPoints * ptsCfg.pointValue;
  }

  // ---- coupons (row-locked) ----
  const couponRows = input.couponCodes.length
    ? await lockCouponsForCheckout(db, input.couponCodes, { cartId: input.cartId, branchId, memberId: member?.id ?? null })
    : [];

  // ---- pricing (authoritative) ----
  const promotions = await activePromotions(db);
  const now = input.offline && input.clientCreatedAt ? new Date(input.clientCreatedAt) : new Date();
  const ctx = {
    now, timeZone: storeCfg.timeZone || config.timeZone, branchId,
    member: member ? { id: member.id, tierId: member.tier_id, birthday: member.birthday } : null,
    promoCodes: input.promoCodes, vat: { mode: taxCfg.mode, rate: Number(taxCfg.rate) },
    tierDiscountPct: tier ? Number(tier.discount_pct) : 0,
  } as const;
  const priced = priceCart({
    lines: pricingLines.map((x) => x.line), products, promotions,
    coupons: couponRows.map(couponToInput), manualDiscount: input.manualDiscount ?? null, pointsDiscount: pointsValue, ctx: ctx as any,
  });

  // ---- manual discount authorisation (role limit or manager approval) ----
  let manualApprover: number | null = null;
  if (priced.manualDiscount > 0) {
    const pct = priced.subtotal > 0 ? (priced.manualDiscount * 100) / priced.subtotal : 100;
    const withinRole = staff.roleKey === 'owner' || (can(staff, 'pos.discount') && pct <= staff.maxDiscountPct + 1e-9);
    if (!withinRole) {
      manualApprover = await authorizeOrApproval(db, { ...staff, roleKey: 'x', permissions: [] }, 'pos.discount', input.manualDiscount?.approvalId);
    }
  }

  for (const cr of priced.couponResults) if (!cr.ok) throw conflict(`คูปอง ${cr.code}: ${cr.reason}`, 'COUPON_CONDITION', { code: cr.code });

  let total = priced.total;
  let offlineAdjustment = 0;
  if (input.expectedTotal != null && input.expectedTotal !== total) {
    if (!input.offline) {
      throw conflict('ยอดเงินมีการเปลี่ยนแปลง (ราคา/โปรโมชั่นอัปเดต) กรุณาตรวจสอบอีกครั้ง', 'PRICE_CHANGED', { serverTotal: total, priced });
    }
    // Offline sale: the customer already paid the terminal-computed total. Keep the books exact and auditable.
    offlineAdjustment = total - input.expectedTotal;
    total = input.expectedTotal;
  }

  // ---- payments ----
  const nonCash = input.payments.filter((p) => p.method !== 'cash');
  const cashPays = input.payments.filter((p) => p.method === 'cash');
  const nonCashSum = nonCash.reduce((a, p) => a + p.amount, 0);
  const cashSum = cashPays.reduce((a, p) => a + p.amount, 0);
  if (nonCashSum + cashSum !== total) throw bad(`ยอดชำระ (${(nonCashSum + cashSum) / 100}) ไม่ตรงกับยอดสุทธิ (${total / 100})`, 'PAYMENT_MISMATCH', { total });
  let change = 0;
  for (const p of cashPays) {
    const rec = p.received ?? p.amount;
    if (rec < p.amount) throw bad('รับเงินสดไม่พอ', 'CASH_SHORT');
    change += rec - p.amount;
  }

  const verifiedPayments: { p: (typeof input.payments)[number]; intentId: string | null; giftCardId: number | null }[] = [];
  for (const p of input.payments) {
    let intentId: string | null = null;
    let giftCardId: number | null = null;
    if (['promptpay', 'transfer', 'ewallet'].includes(p.method)) {
      if (!p.paymentIntentId) throw bad(`การชำระด้วย ${p.method} ต้องได้รับการยืนยันจากระบบก่อน`, 'PAYMENT_NOT_VERIFIED');
      const it = (await db.query('SELECT * FROM payment_intents WHERE id=$1 FOR UPDATE', [p.paymentIntentId])).rows[0];
      if (!it) throw bad('ไม่พบรายการชำระเงิน', 'PAYMENT_NOT_FOUND');
      if (it.status !== 'paid') throw conflict('ยังไม่ได้รับการยืนยันการชำระเงิน', 'PAYMENT_NOT_PAID', { status: it.status });
      if (it.sale_id) throw conflict('รายการชำระเงินนี้ถูกใช้กับบิลอื่นแล้ว', 'PAYMENT_ALREADY_USED');
      if (Number(it.amount) !== p.amount) throw bad('ยอดชำระไม่ตรงกับรายการที่ยืนยัน', 'PAYMENT_AMOUNT');
      intentId = it.id;
    } else if (p.method === 'credit_card' || p.method === 'debit_card') {
      if (!p.reference || p.reference.trim().length < 4) throw bad('กรุณากรอกเลขอนุมัติ (Approval Code) จากเครื่อง EDC', 'CARD_REF_REQUIRED');
    } else if (p.method === 'gift_card') {
      const gc = (await db.query('SELECT * FROM gift_cards WHERE code=$1 FOR UPDATE', [String(p.giftCardCode || '').toUpperCase()])).rows[0];
      if (!gc || gc.status !== 'active') throw bad('บัตรของขวัญไม่ถูกต้อง', 'GIFT_INVALID');
      if (gc.expires_at && new Date(gc.expires_at) < new Date()) throw bad('บัตรของขวัญหมดอายุ', 'GIFT_EXPIRED');
      if (Number(gc.balance) < p.amount) throw bad(`ยอดคงเหลือบัตรของขวัญไม่พอ (${Number(gc.balance) / 100})`, 'GIFT_BALANCE');
      await db.query('UPDATE gift_cards SET balance = balance - $2 WHERE id=$1', [gc.id, p.amount]);
      giftCardId = gc.id;
    }
    verifiedPayments.push({ p, intentId, giftCardId });
  }

  // ---- points earned ----
  let pointsEarned = 0;
  if (member && ptsCfg.enabled && ptsCfg.spendPerPoint > 0) {
    pointsEarned = Math.floor((Math.floor(total / ptsCfg.spendPerPoint)) * Number(tier?.point_multiplier ?? 1));
  }

  // ---- insert sale ----
  const sale = (await db.query(
    `INSERT INTO sales (idempotency_key, bill_no, cart_id, terminal_id, branch_id, shift_id, staff_id, member_id, subtotal, discount_total,
       coupon_discount, points_discount, vat_amount, total, paid_total, change_amount, items_count, lines_count, points_earned, points_redeemed,
       offline, client_created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
    [input.idempotencyKey, input.billNo, input.cartId, terminal.id, branchId, shift?.id ?? null, staff.id, member?.id ?? null,
     priced.subtotal, priced.discountTotal + offlineAdjustment, priced.couponDiscount, priced.pointsDiscount, priced.vatAmount, total,
     total + change, change, priced.itemsCount, priced.lines.length, pointsEarned, input.redeemPoints,
     input.offline, input.clientCreatedAt ?? null])).rows[0];
  const saleId: number = sale.id;

  // keep terminal bill counter monotonic
  const seq = Number(String(input.billNo).replace(/\D/g, '').slice(-6));
  if (Number.isFinite(seq)) await db.query('UPDATE terminals SET last_bill_seq = GREATEST(last_bill_seq, $2), last_seen_at=now() WHERE id=$1', [terminal.id, seq]);

  // ---- items + stock ----
  const lineByid = new Map(pricingLines.map((x) => [x.line.lineId, x]));
  const sorted = [...priced.lines].sort((a, b) => a.productId - b.productId); // consistent lock order prevents deadlocks
  for (const l of sorted) {
    const src = lineByid.get(l.lineId)!;
    const p = pmap.get(l.productId);
    await db.query(
      `INSERT INTO sale_items (sale_id, product_id, barcode, name, qty, pack_qty, unit_price, unit_cost, discount, line_total, is_weighted, vat_exempt, promotion_ids)
       VALUES ($1,$2,$3,$4,$5,$13,$6,$7,$8,$9,$10,$11,$12)`,
      [saleId, l.productId, src.input.barcode ?? null, l.name + (src.packQty !== 1 ? ` (แพ็ก ${src.packQty})` : ''), l.qty, l.unitPrice,
       Math.round(p.cost * src.packQty), l.itemDiscount + l.billDiscountShare, l.total, l.isWeighted, l.vatExempt, l.promotionIds, src.packQty]);
    if (p.track_stock) {
      await moveStock(db, {
        branchId, productId: l.productId, qty: -(l.qty * src.packQty), type: 'sale', refType: 'sale', refId: saleId,
        staffId: staff.id, allowNegative: posCfg.allowNegativeStock || input.offline, productName: p.name,
        reason: input.offline ? 'offline sale sync' : null,
      });
    }
  }

  // ---- payments ----
  let changeLeft = change;
  for (const { p, intentId, giftCardId } of verifiedPayments) {
    const ch = p.method === 'cash' ? Math.min(changeLeft, (p.received ?? p.amount) - p.amount) : 0;
    changeLeft -= ch;
    await db.query(
      `INSERT INTO sale_payments (sale_id, method, amount, received, change_amount, reference, payment_intent_id, gift_card_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [saleId, p.method, p.amount, p.method === 'cash' ? p.received ?? p.amount : p.amount, ch, p.reference ?? null, intentId, giftCardId]);
    if (intentId) await db.query('UPDATE payment_intents SET sale_id=$2 WHERE id=$1', [intentId, saleId]);
    if (giftCardId) await db.query('INSERT INTO gift_card_txns (gift_card_id, amount, sale_id) VALUES ($1,$2,$3)', [giftCardId, -p.amount, saleId]);
  }

  // ---- discounts ----
  for (const d of priced.discounts) {
    await db.query(`INSERT INTO sale_discounts (sale_id, source, ref_id, name, amount, approved_by) VALUES ($1,$2,$3,$4,$5,$6)`,
      [saleId, d.source, d.refId, d.name, d.amount, d.source === 'manual' ? manualApprover : null]);
  }
  if (offlineAdjustment) {
    await db.query(`INSERT INTO sale_discounts (sale_id, source, ref_id, name, amount) VALUES ($1,'manual','offline','ปรับยอดจากการขายออฟไลน์',$2)`, [saleId, offlineAdjustment]);
  }

  // ---- promotion usage (respecting limits atomically) ----
  const usedPromoIds = [...new Set(priced.discounts.filter((d) => d.source === 'promotion').map((d) => Number(d.refId)))];
  for (const pid of usedPromoIds) {
    const r = await db.query(`UPDATE promotions SET usage_count = usage_count + 1 WHERE id=$1 AND (usage_limit IS NULL OR usage_count < usage_limit) RETURNING id`, [pid]);
    if (!r.rowCount && !input.offline) throw conflict('สิทธิ์โปรโมชั่นถูกใช้ครบแล้ว กรุณาคำนวณบิลใหม่', 'PROMO_EXHAUSTED', { promotionId: pid });
  }

  // ---- coupons: RESERVED -> USED (same transaction as the sale) ----
  if (couponRows.length) {
    const amounts = new Map(priced.couponResults.map((r) => [r.couponId, r.amount]));
    await redeemCouponsInTx(db, couponRows.map((row) => ({ row, amount: amounts.get(row.id) || 0 })),
      { saleId, branchId, terminalId: terminal.id, staffId: staff.id, cartId: input.cartId });
  }

  // ---- member points / stats / tier ----
  if (member) {
    if (input.redeemPoints > 0) await spendPoints(db, member.id, input.redeemPoints, 'redeem', saleId, `แลกคะแนนบิล ${input.billNo}`, staff.id);
    if (pointsEarned > 0) await earnPoints(db, member.id, pointsEarned, saleId, `สะสมคะแนนบิล ${input.billNo}`, staff.id);
    await db.query('UPDATE members SET total_spend = total_spend + $2, visit_count = visit_count + 1 WHERE id=$1', [member.id, total]);
    await recalcTier(db, member.id);
  }

  // ---- receipt coupons: generate unique codes & persist BEFORE printing ----
  const decisions = evaluateCouponIssuance(promotions, priced, ctx as any, input.payments.map((p) => p.method), couponCfg.maxPerBill ?? 3);
  if (decisions.length) {
    await issueCouponsInTx(db, decisions, { saleId, branchId, terminalId: terminal.id, staffId: staff.id, memberId: member?.id ?? null });
  }

  // ---- audit ----
  if (input.manualDiscount?.value || overrideApprover || offlineAdjustment || input.offline) {
    await audit({
      staffId: staff.id, staffName: staff.name, action: input.offline ? 'sale.offline_sync' : 'sale.special', entity: 'sale', entityId: saleId,
      billNo: input.billNo, approvedBy: manualApprover ?? overrideApprover, terminalId: terminal.id, branchId,
      reason: input.manualDiscount?.reason ?? null, ip,
      details: { manualDiscount: input.manualDiscount ?? null, offlineAdjustment, priceOverride: !!overrideApprover },
    }, db);
  }
  return saleId;
}

/** Read-only server-side pricing preview (no locks, nothing persisted). */
export async function previewPrice(staff: StaffCtx, input: Pick<CheckoutInput, 'lines' | 'memberId' | 'promoCodes' | 'couponCodes' | 'manualDiscount' | 'redeemPoints'>) {
  const terminal = staff.terminalId ? (await pool.query('SELECT * FROM terminals WHERE id=$1', [staff.terminalId])).rows[0] : null;
  const branchId = terminal?.branch_id ?? staff.branchId ?? 1;
  const posCfg = await getSetting('pos');
  const taxCfg = await getSetting('tax');
  const storeCfg = await getSetting('store');
  const ids = [...new Set(input.lines.map((l) => l.productId))];
  const rows = (await pool.query('SELECT * FROM products WHERE id = ANY($1)', [ids])).rows;
  const products = new Map<number, PricingProduct>(rows.map((r) => [r.id, rowToPricingProduct(r)]));
  const lines = [];
  for (const l of input.lines) {
    let unitPrice: number | null = null;
    if (l.priceSource === 'pack') {
      const bc = (await pool.query('SELECT * FROM product_barcodes WHERE barcode=$1', [l.barcode])).rows[0];
      const p = rows.find((r) => r.id === l.productId);
      unitPrice = bc?.pack_price ?? Math.round((p?.price ?? 0) * Number(bc?.pack_qty ?? 1));
    } else if (l.priceSource === 'embedded') {
      unitPrice = l.barcode ? parseWeightedBarcode(l.barcode, posCfg.weightedBarcode)?.priceSatang ?? null : null;
    } else if (l.priceSource === 'override') unitPrice = l.unitPrice ?? null;
    lines.push({ lineId: l.lineId, productId: l.productId, qty: l.qty, unitPrice });
  }
  const member = input.memberId ? (await pool.query('SELECT m.*, t.discount_pct FROM members m LEFT JOIN tiers t ON t.id=m.tier_id WHERE m.id=$1', [input.memberId])).rows[0] : null;
  const coupons = input.couponCodes?.length ? (await pool.query('SELECT * FROM coupons WHERE code = ANY($1)', [input.couponCodes.map((c) => c.toUpperCase())])).rows : [];
  const ptsCfg = await pointsConfig(pool);
  return priceCart({
    lines, products, promotions: await activePromotions(), coupons: coupons.map(couponToInput), manualDiscount: input.manualDiscount ?? null,
    pointsDiscount: (input.redeemPoints || 0) * ptsCfg.pointValue,
    ctx: {
      now: new Date(), timeZone: storeCfg.timeZone || config.timeZone, branchId,
      member: member ? { id: member.id, tierId: member.tier_id, birthday: member.birthday } : null, promoCodes: input.promoCodes ?? [],
      vat: { mode: taxCfg.mode, rate: Number(taxCfg.rate) }, tierDiscountPct: member ? Number(member.discount_pct || 0) : 0,
    },
  });
}
