// Online shop: pricing, order placement (stock locked at order time), payment, fulfilment and sale recording.
import { pool, tx, one, type Db } from '../db';
import { bad, conflict, notFound, randomCode, randomToken, sha256 } from '../util';
import { getSetting } from '../settings';
import { config } from '../config';
import { moveStock } from './stock';
import { rowToPricingProduct, activePromotions } from './catalog';
import { earnPoints, recalcTier, pointsConfig } from './points';
import { priceCart, type PricingProduct } from '../../../shared/pricing';
import { audit } from '../audit';
import { broadcastStaff } from '../realtime';

export interface ShopItemInput { productId: number; qty: number }

export async function shopSettings(db: Db = pool) {
  const s = await getSetting('shop', db);
  const branchId: number = s.branchId ?? (await one('SELECT id FROM branches WHERE is_active ORDER BY id LIMIT 1', [], db))!.id;
  return { ...s, branchId };
}

/** Members can sign in on the shop with their member-site session (member prices + points). */
export async function memberFromToken(token?: string | null, db: Db = pool) {
  if (!token) return null;
  return one(`SELECT m.* , t.discount_pct, t.point_multiplier FROM member_sessions s JOIN members m ON m.id=s.member_id LEFT JOIN tiers t ON t.id=m.tier_id
    WHERE s.token_hash=$1 AND s.expires_at > now() AND m.is_active`, [sha256(token)], db);
}

/** Server-side pricing of a shop cart (same engine as the POS). Throws on unavailable products. */
export async function priceShopCart(items: ShopItemInput[], member: any | null, fulfillment: 'pickup' | 'delivery', db: Db = pool) {
  if (!items.length) throw bad('ตะกร้าว่าง');
  const shop = await shopSettings(db);
  const tax = await getSetting('tax', db);
  const store = await getSetting('store', db);
  const ids = [...new Set(items.map((i) => i.productId))];
  const rows = (await db.query(`SELECT p.*, COALESCE(sl.qty,0) AS stock, (SELECT COUNT(*) FROM products v WHERE v.parent_id=p.id AND v.is_active) AS variant_count
    FROM products p LEFT JOIN stock_levels sl ON sl.product_id=p.id AND sl.branch_id=$2 WHERE p.id = ANY($1)`, [ids, shop.branchId])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const products = new Map<number, PricingProduct>();
  for (const i of items) {
    const r = byId.get(i.productId);
    if (!r || !r.is_active || !r.online || r.sale_blocked) throw conflict(`สินค้า #${i.productId} ไม่พร้อมขายออนไลน์`, 'NOT_AVAILABLE', { productId: i.productId });
    if (Number(r.variant_count) > 0) throw bad(`กรุณาเลือกไซส์ของ ${r.name}`, 'SIZE_REQUIRED');
    if (!r.is_weighted && !Number.isInteger(i.qty)) throw bad('จำนวนต้องเป็นจำนวนเต็ม');
    products.set(r.id, rowToPricingProduct(r));
  }
  const priced = priceCart({
    lines: items.map((i, k) => ({ lineId: String(k), productId: i.productId, qty: i.qty })), products, promotions: await activePromotions(db),
    ctx: {
      now: new Date(), timeZone: store.timeZone || config.timeZone, branchId: shop.branchId, vat: { mode: tax.mode, rate: Number(tax.rate) },
      member: member ? { id: member.id, tierId: member.tier_id, birthday: member.birthday } : null, tierDiscountPct: member ? Number(member.discount_pct || 0) : 0,
    },
  });
  const shipping = fulfillment === 'delivery' ? (shop.freeDeliveryMin && priced.total >= shop.freeDeliveryMin ? 0 : Number(shop.deliveryFee || 0)) : 0;
  return { priced, shipping, total: priced.total + shipping, rows: byId, shop };
}

export async function createOrder(input: {
  idempotencyKey: string; items: ShopItemInput[]; customer: { name: string; phone: string; email?: string | null };
  fulfillment: 'pickup' | 'delivery'; address?: string | null; note?: string | null; paymentMethod: 'promptpay' | 'pay_at_store' | 'cod'; memberToken?: string | null;
}) {
  const dup = await one('SELECT order_no FROM online_orders WHERE idempotency_key=$1', [input.idempotencyKey]);
  if (dup) throw conflict('ส่งคำสั่งซื้อนี้ไปแล้ว', 'DUPLICATE_ORDER', { orderNo: dup.order_no });
  const shop = await shopSettings();
  if (!shop.enabled) throw conflict('ร้านค้าออนไลน์ปิดให้บริการชั่วคราว', 'SHOP_CLOSED');
  if (input.fulfillment === 'pickup' && !shop.pickup) throw bad('ไม่รองรับการรับที่ร้าน');
  if (input.fulfillment === 'delivery' && !shop.delivery) throw bad('ไม่รองรับการจัดส่ง');
  if (input.fulfillment === 'delivery' && !(input.address && input.address.trim().length > 10)) throw bad('กรุณากรอกที่อยู่จัดส่งให้ครบถ้วน');
  const pm = shop.payments || {};
  if ((input.paymentMethod === 'promptpay' && !pm.promptpay) || (input.paymentMethod === 'pay_at_store' && (!pm.payAtStore || input.fulfillment !== 'pickup')) || (input.paymentMethod === 'cod' && (!pm.cod || input.fulfillment !== 'delivery'))) {
    throw bad('วิธีชำระเงินนี้ไม่พร้อมใช้งาน');
  }
  const member = await memberFromToken(input.memberToken);
  const accessToken = randomToken(18);

  const order = await tx(async (db) => {
    const { priced, shipping, total, rows } = await priceShopCart(input.items, member, input.fulfillment, db);
    if (shop.minOrder && priced.total < shop.minOrder) throw bad(`ยอดสั่งซื้อขั้นต่ำ ${(shop.minOrder / 100).toFixed(2)} บาท`, 'MIN_ORDER');
    let orderNo = '';
    for (let i = 0; i < 5 && !orderNo; i++) {
      const cand = 'WEB-' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + randomCode(5);
      if (!(await db.query('SELECT 1 FROM online_orders WHERE order_no=$1', [cand])).rowCount) orderNo = cand;
    }
    const o = (await db.query(
      `INSERT INTO online_orders (order_no, access_token_hash, idempotency_key, member_id, branch_id, customer_name, customer_phone, customer_email, fulfillment, address, note,
        payment_method, subtotal, discount_total, shipping_fee, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [orderNo, sha256(accessToken), input.idempotencyKey, member?.id ?? null, shop.branchId, input.customer.name, input.customer.phone, input.customer.email || null,
       input.fulfillment, input.fulfillment === 'delivery' ? input.address : null, input.note || null, input.paymentMethod, priced.subtotal, priced.discountTotal, shipping, total])).rows[0];
    // stock is taken at order time (row-locked, never oversells) and returned if the order is cancelled
    for (const l of [...priced.lines].sort((a, b) => a.productId - b.productId)) {
      const r = rows.get(l.productId);
      await db.query(`INSERT INTO online_order_items (order_id, product_id, name, variant_label, qty, unit_price, discount, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [o.id, l.productId, l.name, r.variant_label, l.qty, l.unitPrice, l.itemDiscount + l.billDiscountShare, l.total]);
      if (r.track_stock) await moveStock(db, { branchId: shop.branchId, productId: l.productId, qty: -l.qty, type: 'online_order', refType: 'online_order', refId: o.id, productName: r.name, reason: orderNo });
    }
    if (input.paymentMethod === 'promptpay') {
      const { createPaymentIntent } = await import('../routes/payments');
      const it = await createPaymentIntent({ method: 'promptpay', amount: total, cartId: `ORDER:${o.id}`, terminalId: null, staffId: null }, db);
      await db.query('UPDATE online_orders SET payment_intent_id=$2 WHERE id=$1', [o.id, it!.id]);
    }
    return o;
  });
  broadcastStaff('shop.order', { orderNo: order.order_no, total: order.total, status: order.status });
  broadcastStaff('stock.changed', { productIds: input.items.map((i) => i.productId), branchId: order.branch_id });
  return { orderNo: order.order_no, accessToken };
}

export async function orderView(orderNo: string, accessToken: string | null, memberId: number | null) {
  const o = await one('SELECT * FROM online_orders WHERE order_no=$1', [orderNo]);
  if (!o) throw notFound('ไม่พบคำสั่งซื้อ');
  const allowed = (accessToken && sha256(accessToken) === o.access_token_hash) || (memberId && o.member_id === memberId);
  if (!allowed) throw notFound('ไม่พบคำสั่งซื้อ');
  return publicOrder(o);
}

export async function publicOrder(o: any, db: Db = pool) {
  const items = (await db.query('SELECT product_id, name, variant_label, qty, unit_price, discount, line_total FROM online_order_items WHERE order_id=$1 ORDER BY id', [o.id])).rows;
  const it = o.payment_intent_id ? (await db.query('SELECT id, status, qr_payload, qr_image_url, amount FROM payment_intents WHERE id=$1', [o.payment_intent_id])).rows[0] : null;
  const branch = (await db.query('SELECT name, address, phone FROM branches WHERE id=$1', [o.branch_id])).rows[0];
  return {
    orderNo: o.order_no, status: o.status, createdAt: o.created_at, paidAt: o.paid_at, fulfillment: o.fulfillment, address: o.address, note: o.note,
    customer: { name: o.customer_name, phone: o.customer_phone.replace(/^(\d{3})\d+(\d{3})$/, '$1-xxx-$2') }, paymentMethod: o.payment_method,
    subtotal: Number(o.subtotal), discount: Number(o.discount_total), shipping: Number(o.shipping_fee), total: Number(o.total), trackingNo: o.tracking_no,
    cancelledReason: o.cancelled_reason, branch, items,
    payment: it ? { status: it.status, qrPayload: it.qr_payload, qrImageUrl: it.qr_image_url, amount: Number(it.amount) } : null,
  };
}

/** Make sure the web channel (terminal WEB + system staff) exists; returns ids. */
async function webChannel(db: Db, branchId: number) {
  let t = (await db.query(`SELECT id FROM terminals WHERE code='WEB'`)).rows[0];
  if (!t) t = (await db.query(`INSERT INTO terminals (branch_id, code, name) VALUES ($1,'WEB','Online Shop') RETURNING id`, [branchId])).rows[0];
  let s = (await db.query(`SELECT id FROM staff WHERE employee_code='WEB'`)).rows[0];
  if (!s) {
    let role = (await db.query(`SELECT id FROM roles WHERE key='system'`)).rows[0];
    if (!role) role = (await db.query(`INSERT INTO roles (key, name, permissions, is_system) VALUES ('system','System','{}',true) RETURNING id`)).rows[0];
    s = (await db.query(`INSERT INTO staff (employee_code, name, pin_hash, role_id, is_active) VALUES ('WEB','เว็บไซต์ (Online)','!disabled',$1,false) RETURNING id`, [role.id])).rows[0];
  }
  return { terminalId: t.id as number, staffId: s.id as number };
}

/**
 * Order is paid: status -> paid and record it as a sale (web channel) so it appears in sales reports,
 * member spend / points / tier update. Stock was already taken when the order was placed.
 */
export async function markOrderPaid(db: Db, orderId: number, payment: { method: string; reference?: string | null; intentId?: string | null; staffId?: number | null }) {
  const o = (await db.query('SELECT * FROM online_orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
  if (!o) throw notFound('ไม่พบคำสั่งซื้อ');
  if (o.sale_id) return o; // already recorded
  if (o.status === 'cancelled') throw conflict('คำสั่งซื้อนี้ถูกยกเลิกแล้ว', 'ORDER_CANCELLED');
  const { terminalId, staffId } = await webChannel(db, o.branch_id);
  const items = (await db.query('SELECT oi.*, p.cost, p.is_weighted, p.vat_exempt FROM online_order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=$1 ORDER BY oi.id', [o.id])).rows;
  const tax = await getSetting('tax', db);
  const vatBase = items.filter((i) => !i.vat_exempt).reduce((a, i) => a + Number(i.line_total), 0);
  const vat = tax.mode === 'inclusive' ? Math.round((vatBase * tax.rate) / (100 + tax.rate)) : tax.mode === 'exclusive' ? Math.round((vatBase * tax.rate) / 100) : 0;
  let pointsEarned = 0;
  if (o.member_id) {
    const ptsCfg = await pointsConfig(db);
    const tier = (await db.query('SELECT t.point_multiplier FROM members m LEFT JOIN tiers t ON t.id=m.tier_id WHERE m.id=$1', [o.member_id])).rows[0];
    if (ptsCfg.enabled && ptsCfg.spendPerPoint > 0) pointsEarned = Math.floor(Math.floor((Number(o.total) - Number(o.shipping_fee)) / ptsCfg.spendPerPoint) * Number(tier?.point_multiplier ?? 1));
  }
  const sale = (await db.query(
    `INSERT INTO sales (idempotency_key, bill_no, cart_id, terminal_id, branch_id, staff_id, member_id, subtotal, discount_total, vat_amount, total, paid_total, items_count, lines_count, points_earned)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14) RETURNING id`,
    ['ORDER:' + o.order_no, o.order_no, 'ORDER:' + o.id, terminalId, o.branch_id, staffId, o.member_id, o.subtotal, o.discount_total, vat, o.total,
     items.reduce((a, i) => a + (i.is_weighted ? 1 : Number(i.qty)), 0), items.length, pointsEarned])).rows[0];
  for (const i of items) {
    await db.query(`INSERT INTO sale_items (sale_id, product_id, name, qty, unit_price, unit_cost, discount, line_total, is_weighted, vat_exempt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [sale.id, i.product_id, i.name, i.qty, i.unit_price, i.cost, i.discount, i.line_total, i.is_weighted, i.vat_exempt]);
  }
  await db.query(`INSERT INTO sale_payments (sale_id, method, amount, received, reference, payment_intent_id) VALUES ($1,$2,$3,$3,$4,$5)`,
    [sale.id, payment.method, o.total, payment.reference ?? null, payment.intentId ?? null]);
  if (Number(o.shipping_fee)) await db.query(`INSERT INTO sale_discounts (sale_id, source, ref_id, name, amount) VALUES ($1,'manual','shipping','ค่าจัดส่ง (รวมในยอด)',$2)`, [sale.id, -Number(o.shipping_fee)]);
  if (payment.intentId) await db.query('UPDATE payment_intents SET sale_id=$2 WHERE id=$1', [payment.intentId, sale.id]);
  if (o.member_id) {
    await db.query('SELECT id FROM members WHERE id=$1 FOR UPDATE', [o.member_id]);
    if (pointsEarned > 0) await earnPoints(db, o.member_id, pointsEarned, sale.id, `สะสมคะแนนออเดอร์ออนไลน์ ${o.order_no}`, payment.staffId ?? null);
    await db.query('UPDATE members SET total_spend = total_spend + $2, visit_count = visit_count + 1 WHERE id=$1', [o.member_id, o.total]);
    await recalcTier(db, o.member_id);
  }
  const next = o.status === 'pending_payment' ? 'paid' : o.status;
  const r = (await db.query(`UPDATE online_orders SET status=$2, paid_at=now(), sale_id=$3, updated_at=now() WHERE id=$1 RETURNING *`, [o.id, next, sale.id])).rows[0];
  await audit({ staffId: payment.staffId ?? null, action: 'order.paid', entity: 'online_order', entityId: o.id, billNo: o.order_no, details: { method: payment.method, reference: payment.reference } }, db);
  return r;
}

export async function onOrderIntentPaid(intent: any) {
  const orderId = Number(String(intent.cart_id).slice(6));
  await tx((db) => markOrderPaid(db, orderId, { method: 'promptpay', reference: intent.reference ?? intent.provider_ref, intentId: intent.id, staffId: intent.verified_by }));
  broadcastStaff('shop.order', { orderId, status: 'paid' });
}

const FLOW: Record<string, string[]> = {
  pending_payment: ['cancelled'], paid: ['preparing', 'ready', 'shipped', 'completed', 'cancelled'], preparing: ['ready', 'shipped', 'completed', 'cancelled'],
  ready: ['completed', 'cancelled'], shipped: ['completed'], completed: [], cancelled: [],
};

/** Status changes from the back office. Cancelling returns stock; a paid+recorded order must be refunded at the POS. */
export async function setOrderStatus(orderId: number, to: string, staff: { id: number; name: string }, extra: { reason?: string; trackingNo?: string } = {}) {
  return tx(async (db) => {
    const o = (await db.query('SELECT * FROM online_orders WHERE id=$1 FOR UPDATE', [orderId])).rows[0];
    if (!o) throw notFound();
    // pay-at-store / COD orders can move on before payment; payment is recorded with mark-paid
    const allowed = new Set(FLOW[o.status] ?? []);
    if (o.status === 'pending_payment' && o.payment_method !== 'promptpay') ['preparing', 'ready', 'shipped'].forEach((x) => allowed.add(x));
    if (o.status !== 'paid' && !o.sale_id && to === 'completed') throw conflict('ต้องบันทึกการชำระเงินก่อนปิดออเดอร์', 'NOT_PAID');
    if (!allowed.has(to) && !(to === 'completed' && o.sale_id && o.status !== 'cancelled' && o.status !== 'completed')) throw conflict(`เปลี่ยนสถานะจาก ${o.status} เป็น ${to} ไม่ได้`, 'BAD_TRANSITION');
    if (to === 'cancelled') {
      if (o.sale_id) throw conflict('ออเดอร์ชำระเงินแล้ว — กรุณาคืนเงินจากประวัติบิลที่หน้าขาย (บิล ' + o.order_no + ')', 'PAID_REFUND_AT_POS');
      const items = (await db.query('SELECT oi.*, p.track_stock FROM online_order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=$1 ORDER BY product_id', [o.id])).rows;
      for (const i of items) if (i.track_stock) await moveStock(db, { branchId: o.branch_id, productId: i.product_id, qty: Number(i.qty), type: 'online_cancel', refType: 'online_order', refId: o.id, reason: extra.reason || 'ยกเลิกออเดอร์', staffId: staff.id || null, lot: {} });
      if (o.payment_intent_id) await db.query(`UPDATE payment_intents SET status='cancelled' WHERE id=$1 AND status IN ('pending','needs_review')`, [o.payment_intent_id]);
    }
    const r = (await db.query(`UPDATE online_orders SET status=$2, cancelled_reason=CASE WHEN $2='cancelled' THEN $3 ELSE cancelled_reason END, tracking_no=COALESCE($4, tracking_no), updated_at=now() WHERE id=$1 RETURNING *`,
      [o.id, to, extra.reason ?? null, extra.trackingNo ?? null])).rows[0];
    await audit({ staffId: staff.id || null, staffName: staff.name, action: 'order.status', entity: 'online_order', entityId: o.id, billNo: o.order_no, reason: extra.reason, details: { from: o.status, to } }, db);
    return r;
  });
}

/** Housekeeping: cancel PromptPay orders that were never paid (returns stock). */
export async function expireUnpaidOrders() {
  const shop = await shopSettings();
  const mins = Number(shop.paymentTimeoutMinutes || 30);
  const rows = (await pool.query(`SELECT o.id FROM online_orders o LEFT JOIN payment_intents pi ON pi.id=o.payment_intent_id
    WHERE o.status='pending_payment' AND o.payment_method='promptpay' AND o.created_at < now() - ($1 || ' minutes')::interval
      AND (pi.status IS NULL OR pi.status NOT IN ('paid','needs_review'))`, [String(mins)])).rows;
  for (const r of rows) await setOrderStatus(r.id, 'cancelled', { id: 0, name: 'system' }, { reason: 'หมดเวลาชำระเงิน' }).catch((e) => console.error('[shop expire]', e.message));
  return rows.length;
}

export { sha256 as hashToken };
