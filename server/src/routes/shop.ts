import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool, q, one, tx } from '../db';
import { requireStaff, requirePerm, can } from '../auth';
import { parse, notFound, HttpError, forbidden } from '../util';
import { getAllSettings } from '../settings';
import { audit } from '../audit';
import { broadcastStaff } from '../realtime';
import {
  shopSettings, memberFromToken, priceShopCart, createOrder, orderView, publicOrder, markOrderPaid, setOrderStatus,
} from '../services/shop';

// ================= Public online shop =================
export const shopRouter = Router();

const memberToken = (req: Request) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};

/** Small in-memory per-IP limiter for order placement (abuse protection, stock is reserved on order). */
const hits = new Map<string, number[]>();
function limited(ip: string, max: number, windowMs: number) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
  return arr.length > max;
}

shopRouter.get('/info', async (_req, res) => {
  const s = await getAllSettings();
  const shop = await shopSettings();
  const branch = await one('SELECT id, name, address, phone FROM branches WHERE id=$1', [shop.branchId]);
  const categories = await q(`SELECT c.id, c.name, c.name_en, COUNT(p.id)::int AS count FROM categories c
    JOIN products p ON p.category_id=c.id AND p.is_active AND p.online AND p.parent_id IS NULL GROUP BY c.id ORDER BY c.name`);
  res.json({
    store: { name: s.store.name, nameEn: s.store.nameEn, logo: s.store.logo, phone: s.store.phone, address: s.store.address },
    fonts: s.fonts, display: { primaryColor: s.display?.primaryColor, accentColor: s.display?.accentColor },
    shop: {
      enabled: shop.enabled, title: shop.title, announcement: shop.announcement, pickup: shop.pickup, delivery: shop.delivery,
      deliveryFee: shop.deliveryFee, freeDeliveryMin: shop.freeDeliveryMin, minOrder: shop.minOrder, payments: shop.payments,
      paymentTimeoutMinutes: shop.paymentTimeoutMinutes,
    },
    branch, categories,
  });
});

// Product listing: parents and simple products; sized products show a price range and total stock of their sizes.
const SHOP_LIST = `
  SELECT p.id, p.name, p.name_en, p.category_id, p.price, p.member_price, p.is_weighted, p.track_stock, p.image_url,
    c.name AS category_name, u.name AS unit_name,
    COALESCE((SELECT array_agg(pi.id ORDER BY pi.sort_order, pi.id) FROM product_images pi WHERE pi.product_id=p.id), '{}') AS image_ids,
    v.cnt AS variant_count, v.min_price, v.max_price, v.stock AS variant_stock, v.untracked,
    COALESCE(sl.qty, 0) AS stock
  FROM products p
  LEFT JOIN categories c ON c.id=p.category_id
  LEFT JOIN units u ON u.id=p.unit_id
  LEFT JOIN stock_levels sl ON sl.product_id=p.id AND sl.branch_id=$1
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS cnt, MIN(ch.price) AS min_price, MAX(ch.price) AS max_price,
      SUM(CASE WHEN ch.track_stock THEN GREATEST(COALESCE(cs.qty,0),0) ELSE 0 END) AS stock, bool_or(NOT ch.track_stock) AS untracked
    FROM products ch LEFT JOIN stock_levels cs ON cs.product_id=ch.id AND cs.branch_id=$1
    WHERE ch.parent_id=p.id AND ch.is_active AND ch.online AND NOT ch.sale_blocked
  ) v ON true
  WHERE p.is_active AND p.online AND NOT p.sale_blocked AND p.parent_id IS NULL`;

function listItem(r: any) {
  const sized = r.variant_count > 0;
  const available = sized ? (r.untracked || Number(r.variant_stock) > 0) : (!r.track_stock || Number(r.stock) > 0);
  return {
    id: r.id, name: r.name, nameEn: r.name_en, categoryId: r.category_id, categoryName: r.category_name, unitName: r.unit_name,
    price: sized ? Number(r.min_price) : r.price, maxPrice: sized ? Number(r.max_price) : r.price, memberPrice: sized ? null : r.member_price,
    isWeighted: r.is_weighted, imageIds: r.image_ids, imageUrl: r.image_url, hasSizes: sized, available,
  };
}

shopRouter.get('/products', async (req, res) => {
  const shop = await shopSettings();
  const params: any[] = [shop.branchId];
  let where = '';
  const search = String(req.query.q || '').trim();
  if (search) { params.push(`%${search}%`); where += ` AND (p.name ILIKE $${params.length} OR p.name_en ILIKE $${params.length} OR p.sku ILIKE $${params.length})`; }
  if (req.query.category) { params.push(Number(req.query.category)); where += ` AND p.category_id=$${params.length}`; }
  const sort = ({ price_asc: 'p.price ASC', price_desc: 'p.price DESC', new: 'p.id DESC' } as Record<string, string>)[String(req.query.sort)] || 'p.name';
  const limit = Math.min(Number(req.query.limit) || 60, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  params.push(limit + 1, offset);
  const rows = await q(`${SHOP_LIST} ${where} ORDER BY ${sort}, p.id LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({ items: rows.slice(0, limit).map(listItem), hasMore: rows.length > limit });
});

shopRouter.get('/products/:id', async (req, res) => {
  const shop = await shopSettings();
  const id = Number(String(req.params.id));
  const r = await one(`${SHOP_LIST} AND p.id=$2`, [shop.branchId, id]);
  if (!r) throw notFound('ไม่พบสินค้า');
  const extra = await one('SELECT description, size_chart, sku FROM products WHERE id=$1', [id]);
  const variants = await q(`SELECT ch.id, ch.variant_label AS label, ch.price, ch.member_price, ch.track_stock, COALESCE(sl.qty,0) AS stock
    FROM products ch LEFT JOIN stock_levels sl ON sl.product_id=ch.id AND sl.branch_id=$2
    WHERE ch.parent_id=$1 AND ch.is_active AND ch.online AND NOT ch.sale_blocked ORDER BY ch.variant_sort, ch.id`, [id, shop.branchId]);
  res.json({
    ...listItem(r), sku: extra.sku, description: extra.description, sizeChart: extra.size_chart,
    stock: r.track_stock ? Math.max(0, Number(r.stock)) : null,
    variants: variants.map((v) => ({
      id: v.id, label: v.label, price: v.price, memberPrice: v.member_price,
      stock: v.track_stock ? Math.max(0, Number(v.stock)) : null, available: !v.track_stock || Number(v.stock) > 0,
    })),
  });
});

shopRouter.get('/images/:id', async (req, res) => {
  const img = await one('SELECT mime, data FROM product_images WHERE id=$1', [Number(String(req.params.id)) || 0]);
  if (!img) throw notFound();
  res.setHeader('Content-Type', img.mime);
  // image ids are never reused and image bytes never change → safe to cache forever
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(img.data);
});

const itemsSchema = z.array(z.object({ productId: z.number().int().positive(), qty: z.number().positive().max(9999) })).min(1).max(100);

shopRouter.post('/quote', async (req, res) => {
  const b = parse(z.object({ items: itemsSchema, fulfillment: z.enum(['pickup', 'delivery']).default('pickup') }), req.body);
  const member = await memberFromToken(memberToken(req));
  const { priced, shipping, total, rows } = await priceShopCart(b.items, member, b.fulfillment);
  res.json({
    lines: priced.lines.map((l) => {
      const r = rows.get(l.productId);
      return { productId: l.productId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, discount: l.itemDiscount + l.billDiscountShare, total: l.total,
        stock: r.track_stock ? Math.max(0, Number(r.stock)) : null };
    }),
    subtotal: priced.subtotal, discount: priced.discountTotal, shipping, total, applied: priced.discounts.map((d) => ({ name: d.name, amount: d.amount })), member: member ? { name: member.first_name } : null,
  });
});

shopRouter.post('/orders', async (req, res) => {
  if (limited(req.ip || 'x', 10, 10 * 60_000)) throw new HttpError(429, 'สั่งซื้อบ่อยเกินไป กรุณารอสักครู่', 'RATE_LIMITED');
  const b = parse(z.object({
    idempotencyKey: z.string().min(8).max(80), items: itemsSchema,
    customer: z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().regex(/^[0-9+\-\s]{9,15}$/, 'เบอร์โทรไม่ถูกต้อง'), email: z.string().email().nullable().optional().or(z.literal('')) }),
    fulfillment: z.enum(['pickup', 'delivery']), address: z.string().max(1000).nullable().optional(), note: z.string().max(1000).nullable().optional(),
    paymentMethod: z.enum(['promptpay', 'pay_at_store', 'cod']),
  }), req.body);
  const r = await createOrder({ ...b, customer: { ...b.customer, phone: b.customer.phone.replace(/[\s-]/g, '') }, memberToken: memberToken(req) });
  res.status(201).json(r);
});

shopRouter.get('/orders/:orderNo', async (req, res) => {
  const member = await memberFromToken(memberToken(req));
  res.json(await orderView(String(req.params.orderNo), (req.query.t as string) || null, member?.id ?? null));
});

/** Signed-in member: own order history. */
shopRouter.get('/my-orders', async (req, res) => {
  const member = await memberFromToken(memberToken(req));
  if (!member) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ', 'UNAUTHENTICATED');
  res.json(await q(`SELECT order_no, status, total, fulfillment, payment_method, created_at,
    (SELECT COUNT(*)::int FROM online_order_items i WHERE i.order_id=o.id) AS lines FROM online_orders o WHERE member_id=$1 ORDER BY id DESC LIMIT 100`, [member.id]));
});

// ================= Back office: online orders =================
export const ordersRouter = Router();
ordersRouter.use(requireStaff, requirePerm('orders.manage', 'payments.verify'));

ordersRouter.get('/', async (req, res) => {
  const params: any[] = [];
  let where = 'WHERE true';
  if (req.query.status) { params.push(String(req.query.status).split(',')); where += ` AND o.status = ANY($${params.length})`; }
  if (req.query.q) { params.push(`%${String(req.query.q)}%`); where += ` AND (o.order_no ILIKE $${params.length} OR o.customer_name ILIKE $${params.length} OR o.customer_phone ILIKE $${params.length})`; }
  res.json(await q(`SELECT o.id, o.order_no, o.status, o.customer_name, o.customer_phone, o.fulfillment, o.payment_method, o.total, o.created_at, o.paid_at,
      o.tracking_no, concat_ws(' ', m.first_name, m.last_name) AS member_name, (SELECT COUNT(*)::int FROM online_order_items i WHERE i.order_id=o.id) AS lines,
      pi.status AS payment_status
    FROM online_orders o LEFT JOIN members m ON m.id=o.member_id LEFT JOIN payment_intents pi ON pi.id=o.payment_intent_id
    ${where} ORDER BY o.id DESC LIMIT 300`, params));
});

ordersRouter.get('/:id', async (req, res) => {
  const o = await one('SELECT * FROM online_orders WHERE id=$1', [Number(String(req.params.id))]);
  if (!o) throw notFound();
  const view = await publicOrder(o);
  const member = o.member_id ? await one(`SELECT id, member_no, concat_ws(' ', first_name, last_name) AS name, phone FROM members WHERE id=$1`, [o.member_id]) : null;
  res.json({ ...view, id: o.id, customer: { name: o.customer_name, phone: o.customer_phone, email: o.customer_email }, member, saleId: o.sale_id, paymentIntentId: o.payment_intent_id });
});

ordersRouter.post('/:id/status', requirePerm('orders.manage'), async (req, res) => {
  const b = parse(z.object({ status: z.enum(['preparing', 'ready', 'shipped', 'completed', 'cancelled']), reason: z.string().max(300).optional(), trackingNo: z.string().max(80).optional() }), req.body);
  if (b.status === 'cancelled' && !b.reason) throw new HttpError(400, 'กรุณาระบุเหตุผลการยกเลิก', 'REASON_REQUIRED');
  const r = await setOrderStatus(Number(String(req.params.id)), b.status, { id: req.staff!.id, name: req.staff!.name }, b);
  broadcastStaff('shop.order', { orderId: r.id, orderNo: r.order_no, status: r.status });
  if (b.status === 'cancelled') broadcastStaff('stock.changed', { branchId: r.branch_id });
  res.json({ ok: true, status: r.status });
});

/** Record payment received outside PromptPay auto-confirmation (pay at store, COD, manual transfer check). */
ordersRouter.post('/:id/mark-paid', async (req, res) => {
  if (!can(req.staff, 'payments.verify') && !can(req.staff, 'orders.manage')) throw forbidden();
  const b = parse(z.object({ method: z.enum(['cash', 'promptpay', 'transfer', 'credit_card', 'debit_card', 'ewallet']), reference: z.string().max(120).nullable().optional() }), req.body);
  const r = await tx(async (db) => {
    const o = await markOrderPaid(db, Number(String(req.params.id)), { method: b.method, reference: b.reference ?? null, staffId: req.staff!.id });
    if (o.payment_intent_id) await db.query(`UPDATE payment_intents SET status='cancelled' WHERE id=$1 AND status IN ('pending','needs_review')`, [o.payment_intent_id]);
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'order.mark_paid', entity: 'online_order', entityId: o.id, billNo: o.order_no, details: b }, db);
    return o;
  });
  broadcastStaff('shop.order', { orderId: r.id, orderNo: r.order_no, status: r.status });
  res.json({ ok: true, status: r.status, saleId: r.sale_id });
});

void pool;
