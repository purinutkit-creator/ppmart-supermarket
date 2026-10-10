import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool, q, one, tx } from '../db';
import { requireStaff, requirePerm, can } from '../auth';
import { parse, notFound, HttpError, forbidden } from '../util';
import { getAllSettings } from '../settings';
import { audit } from '../audit';
import { broadcastStaff } from '../realtime';
import {
  loadStore, scopeSql, scopeCategoryIds, memberFromToken, priceShopCart, createOrder, orderView, publicOrder, markOrderPaid, setOrderStatus, mergeStore, type Store,
} from '../services/shop';

// ================= Public online shop (multiple storefronts) =================
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

const mediaUrl = (id?: number | null) => (id ? `/api/shop/media/${id}` : null);

/** Public part of a store (everything in config is meant for the website). */
function storePublic(st: Store) {
  return {
    slug: st.slug, name: st.name, tagline: st.tagline, logo: mediaUrl(st.logoMediaId), theme: st.theme, announcements: st.announcements.filter(Boolean),
    banners: st.banners.map((b) => ({ ...b, image: mediaUrl(b.mediaId), mobileImage: mediaUrl(b.mobileMediaId) || mediaUrl(b.mediaId) })),
    home: st.home, pickup: st.pickup, delivery: st.delivery, deliveryFee: st.deliveryFee, freeDeliveryMin: st.freeDeliveryMin, minOrder: st.minOrder,
    payments: st.payments, paymentTimeoutMinutes: st.paymentTimeoutMinutes, contact: st.contact, shippingInfo: st.shippingInfo, returnInfo: st.returnInfo, footerText: st.footerText,
  };
}

/** All open stores (store chooser page). */
shopRouter.get('/stores', async (_req, res) => {
  const fb = (await one('SELECT id FROM branches WHERE is_active ORDER BY id LIMIT 1'))!.id;
  const rows = await q('SELECT * FROM storefronts WHERE enabled ORDER BY sort_order, id');
  const s = await getAllSettings();
  res.json({ company: { name: s.store.name, logo: s.store.logo }, stores: rows.map((r) => { const st = mergeStore(r, fb); return { slug: st.slug, name: st.name, tagline: st.tagline, logo: mediaUrl(st.logoMediaId), theme: st.theme, banner: st.banners[0] ? mediaUrl(st.banners[0].mediaId) : null }; }) });
});

shopRouter.get('/media/:id', async (req, res) => {
  const m = await one('SELECT mime, data FROM shop_media WHERE id=$1', [Number(String(req.params.id)) || 0]);
  if (!m) throw notFound();
  res.setHeader('Content-Type', m.mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(m.data);
});

shopRouter.get('/images/:id', async (req, res) => {
  const img = await one('SELECT mime, data FROM product_images WHERE id=$1', [Number(String(req.params.id)) || 0]);
  if (!img) throw notFound();
  res.setHeader('Content-Type', img.mime);
  // image ids are never reused and image bytes never change → safe to cache forever
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(img.data);
});

shopRouter.get('/s/:slug/info', async (req, res) => {
  const st = await loadStore(String(req.params.slug));
  const s = await getAllSettings();
  const params: any[] = [];
  const scope = await scopeSql(st, 'p', params);
  const live = `p.is_active AND p.online AND NOT p.sale_blocked AND p.parent_id IS NULL ${scope}`;
  const counts = await q(`SELECT p.category_id AS id, COUNT(*)::int AS n,
      (SELECT pi.id FROM products x JOIN product_images pi ON pi.product_id=x.id WHERE x.category_id=p.category_id AND x.is_active AND x.online ORDER BY x.id DESC, pi.sort_order LIMIT 1) AS image_id
    FROM products p WHERE ${live} AND p.category_id IS NOT NULL GROUP BY p.category_id`, params);
  const cats = await q('SELECT id, name, name_en, parent_id FROM categories ORDER BY name');
  const byId = new Map(counts.map((c) => [c.id, c]));
  // roll counts up to parents so the menu shows parent categories that only have products in sub-categories
  const total = (id: number): number => (byId.get(id)?.n ?? 0) + cats.filter((c) => c.parent_id === id).reduce((a, c) => a + total(c.id), 0);
  const categories = cats.map((c) => ({ id: c.id, name: c.name, nameEn: c.name_en, parentId: c.parent_id, count: total(c.id), image: byId.get(c.id)?.image_id ? `/api/shop/images/${byId.get(c.id)!.image_id}` : null }))
    .filter((c) => c.count > 0);
  const brands = await q(`SELECT b.id, b.name, COUNT(*)::int AS count FROM products p JOIN brands b ON b.id=p.brand_id WHERE ${live} GROUP BY b.id ORDER BY b.name`, params);
  const locIds = st.locationBranchIds.length ? st.locationBranchIds : [st.branchId];
  const locations = await q('SELECT id, name, address, phone FROM branches WHERE id = ANY($1) AND is_active ORDER BY id', [locIds]);
  const branch = await one('SELECT id, name, address, phone FROM branches WHERE id=$1', [st.branchId]);
  res.json({ store: storePublic(st), company: { name: s.store.name, phone: s.store.phone, address: s.store.address, logo: s.store.logo }, fonts: s.fonts, branch, locations, categories, brands });
});

// ---------- product listing with filters / facets ----------
function baseSql(withSold: boolean) {
  return `
  SELECT p.id, p.name, p.name_en, p.category_id, p.brand_id, p.price, p.compare_price, p.member_price, p.is_weighted, p.track_stock, p.image_url, p.created_at,
    c.name AS category_name, b.name AS brand_name, u.name AS unit_name,
    COALESCE((SELECT array_agg(pi.id ORDER BY pi.sort_order, pi.id) FROM product_images pi WHERE pi.product_id=p.id), '{}') AS image_ids,
    COALESCE(v.cnt, 0) AS variant_count, v.min_price, v.max_price, v.stock AS variant_stock, v.untracked, COALESCE(v.sizes, '{}') AS sizes,
    COALESCE(sl.qty, 0) AS stock, ${withSold ? `COALESCE(sold.qty, 0)` : '0'} AS sold
  FROM products p
  LEFT JOIN categories c ON c.id=p.category_id
  LEFT JOIN brands b ON b.id=p.brand_id
  LEFT JOIN units u ON u.id=p.unit_id
  LEFT JOIN stock_levels sl ON sl.product_id=p.id AND sl.branch_id=$1
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS cnt, MIN(ch.price) AS min_price, MAX(ch.price) AS max_price,
      SUM(CASE WHEN ch.track_stock THEN GREATEST(COALESCE(cs.qty,0),0) ELSE 0 END) AS stock, bool_or(NOT ch.track_stock) AS untracked,
      array_agg(ch.variant_label ORDER BY ch.variant_sort, ch.id) FILTER (WHERE NOT ch.track_stock OR COALESCE(cs.qty,0) > 0) AS sizes
    FROM products ch LEFT JOIN stock_levels cs ON cs.product_id=ch.id AND cs.branch_id=$1
    WHERE ch.parent_id=p.id AND ch.is_active AND ch.online AND NOT ch.sale_blocked
  ) v ON true
  ${withSold ? `LEFT JOIN LATERAL (SELECT SUM(si.qty) AS qty FROM sale_items si JOIN sales s ON s.id=si.sale_id
      WHERE si.product_id IN (SELECT p.id UNION ALL SELECT k.id FROM products k WHERE k.parent_id=p.id) AND s.status <> 'voided' AND s.created_at > now() - interval '90 days') sold ON true` : ''}
  WHERE p.is_active AND p.online AND NOT p.sale_blocked AND p.parent_id IS NULL`;
}
const WRAP = (inner: string) => `WITH base AS (${inner}), x AS (
    SELECT *, CASE WHEN variant_count > 0 THEN min_price ELSE price END AS eff_price,
      CASE WHEN variant_count > 0 THEN (COALESCE(untracked,false) OR COALESCE(variant_stock,0) > 0) ELSE (NOT track_stock OR stock > 0) END AS available
    FROM base)`;

function listItem(r: any, newDays: number) {
  const sized = r.variant_count > 0;
  const price = Number(r.eff_price ?? r.price);
  return {
    id: r.id, name: r.name, nameEn: r.name_en, categoryId: r.category_id, categoryName: r.category_name, brandId: r.brand_id, brandName: r.brand_name, unitName: r.unit_name,
    price, maxPrice: sized ? Number(r.max_price) : r.price, comparePrice: r.compare_price && r.compare_price > price ? Number(r.compare_price) : null,
    memberPrice: sized ? null : r.member_price, isWeighted: r.is_weighted, imageIds: r.image_ids, imageUrl: r.image_url, hasSizes: sized, sizes: r.sizes,
    available: r.available, isNew: Date.now() - new Date(r.created_at).getTime() < newDays * 86400000, sold: Number(r.sold || 0),
  };
}

const csvNums = (v: unknown) => String(v ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0);
const csvStr = (v: unknown) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30);

shopRouter.get('/s/:slug/products', async (req, res) => {
  const st = await loadStore(String(req.params.slug));
  const Q = req.query;
  const sort = String(Q.sort || '');
  const tag = String(Q.tag || '');
  const params: any[] = [st.branchId];
  let inner = baseSql(sort === 'best' || tag === 'best') + await scopeSql(st, 'p', params);
  const search = String(Q.q || '').trim();
  if (search) { params.push(`%${search}%`); inner += ` AND (p.name ILIKE $${params.length} OR p.name_en ILIKE $${params.length} OR p.sku ILIKE $${params.length} OR b.name ILIKE $${params.length})`; }
  const catIds = csvNums(Q.category);
  if (catIds.length) {
    const all = await scopeCategoryIds({ ...st, scope: { mode: 'categories', categoryIds: catIds, brandIds: [] } });
    params.push(all); inner += ` AND p.category_id = ANY($${params.length}::int[])`;
  }
  // facets are computed before brand/size/price/stock filters so the customer can still widen them
  const facetParams = [...params];
  const facets = await one(`${WRAP(inner)} SELECT
      COALESCE((SELECT json_agg(f ORDER BY f.name) FROM (SELECT brand_id AS id, brand_name AS name, COUNT(*)::int AS count FROM x WHERE brand_id IS NOT NULL GROUP BY 1,2) f), '[]') AS brands,
      COALESCE((SELECT json_agg(DISTINCT s) FROM x, unnest(sizes) s), '[]') AS sizes,
      (SELECT MIN(eff_price) FROM x) AS min_price, (SELECT MAX(eff_price) FROM x) AS max_price`, facetParams);
  const where: string[] = [];
  const brandIds = csvNums(Q.brand);
  if (brandIds.length) { params.push(brandIds); where.push(`brand_id = ANY($${params.length}::int[])`); }
  const sizes = csvStr(Q.size);
  if (sizes.length) { params.push(sizes); where.push(`sizes && $${params.length}::text[]`); }
  if (Q.min) { params.push(Math.round(Number(Q.min) * 100)); where.push(`eff_price >= $${params.length}`); }
  if (Q.max) { params.push(Math.round(Number(Q.max) * 100)); where.push(`eff_price <= $${params.length}`); }
  if (Q.inStock === '1') where.push('available');
  if (tag === 'new') { params.push(st.home.newDays || 30); where.push(`created_at > now() - ($${params.length} || ' days')::interval`); }
  if (tag === 'sale') where.push('compare_price > eff_price');
  if (tag === 'best') where.push('sold > 0');
  const order = ({ new: 'created_at DESC', price_asc: 'eff_price ASC', price_desc: 'eff_price DESC', best: 'sold DESC', name: 'name' } as Record<string, string>)[sort]
    || (tag === 'new' ? 'created_at DESC' : tag === 'best' ? 'sold DESC' : 'available DESC, created_at DESC');
  const limit = Math.min(Number(Q.limit) || 24, 100);
  const offset = Math.max(Number(Q.offset) || 0, 0);
  params.push(limit, offset);
  const rows = await q(`${WRAP(inner)} SELECT *, COUNT(*) OVER() AS total FROM x ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${order}, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  res.json({
    items: rows.map((r) => listItem(r, st.home.newDays)), total: Number(rows[0]?.total ?? 0),
    facets: { brands: facets.brands, sizes: sortSizes(facets.sizes), minPrice: facets.min_price != null ? Number(facets.min_price) : null, maxPrice: facets.max_price != null ? Number(facets.max_price) : null },
  });
});

const SIZE_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL', 'XXXL', '4XL', '5XL'];
function sortSizes(list: string[]) {
  const rank = (s: string) => { const i = SIZE_ORDER.indexOf(s.toUpperCase()); return i >= 0 ? i : 100; };
  return [...list].sort((a, b) => rank(a) - rank(b) || (Number(a) - Number(b)) || a.localeCompare(b));
}

shopRouter.get('/s/:slug/products/:id', async (req, res) => {
  const st = await loadStore(String(req.params.slug));
  const id = Number(String(req.params.id));
  const params: any[] = [st.branchId, id];
  const r = await one(`${WRAP(baseSql(false) + ' AND p.id=$2' + await scopeSql(st, 'p', params))} SELECT * FROM x`, params);
  if (!r) throw notFound('ไม่พบสินค้า');
  const extra = await one('SELECT description, size_chart, sku FROM products WHERE id=$1', [id]);
  const variants = await q(`SELECT ch.id, ch.variant_label AS label, ch.price, ch.member_price, ch.track_stock, COALESCE(sl.qty,0) AS stock
    FROM products ch LEFT JOIN stock_levels sl ON sl.product_id=ch.id AND sl.branch_id=$2
    WHERE ch.parent_id=$1 AND ch.is_active AND ch.online AND NOT ch.sale_blocked ORDER BY ch.variant_sort, ch.id`, [id, st.branchId]);
  const crumbs: any[] = [];
  let cid = r.category_id;
  while (cid) { const c = await one('SELECT id, name, parent_id FROM categories WHERE id=$1', [cid]); if (!c) break; crumbs.unshift({ id: c.id, name: c.name }); cid = c.parent_id; }
  const rp: any[] = [st.branchId, id, r.category_id, r.brand_id];
  const related = await q(`${WRAP(baseSql(false) + ' AND p.id <> $2 AND (p.category_id = $3 OR p.brand_id = $4)' + await scopeSql(st, 'p', rp))}
    SELECT * FROM x ORDER BY available DESC, (category_id = $3) DESC, created_at DESC LIMIT 12`, rp);
  res.json({
    ...listItem(r, st.home.newDays), sku: extra.sku, description: extra.description, sizeChart: extra.size_chart, breadcrumbs: crumbs,
    stock: r.track_stock && !(r.variant_count > 0) ? Math.max(0, Number(r.stock)) : null,
    variants: variants.map((v) => ({
      id: v.id, label: v.label, price: v.price, memberPrice: v.member_price, comparePrice: r.compare_price && r.compare_price > v.price ? Number(r.compare_price) : null,
      stock: v.track_stock ? Math.max(0, Number(v.stock)) : null, available: !v.track_stock || Number(v.stock) > 0,
    })),
    related: related.map((x) => listItem(x, st.home.newDays)),
  });
});

const itemsSchema = z.array(z.object({ productId: z.number().int().positive(), qty: z.number().positive().max(9999) })).min(1).max(100);

shopRouter.post('/s/:slug/quote', async (req, res) => {
  const st = await loadStore(String(req.params.slug));
  const b = parse(z.object({ items: itemsSchema, fulfillment: z.enum(['pickup', 'delivery']).default('pickup') }), req.body);
  const member = await memberFromToken(memberToken(req));
  const { priced, shipping, total, rows } = await priceShopCart(b.items, member, b.fulfillment, st);
  res.json({
    lines: priced.lines.map((l) => {
      const r = rows.get(l.productId);
      return { productId: l.productId, name: l.name, qty: l.qty, unitPrice: l.unitPrice, discount: l.itemDiscount + l.billDiscountShare, total: l.total,
        stock: r.track_stock ? Math.max(0, Number(r.stock)) : null };
    }),
    subtotal: priced.subtotal, discount: priced.discountTotal, shipping, total, applied: priced.discounts.map((d) => ({ name: d.name, amount: d.amount })), member: member ? { name: member.first_name } : null,
  });
});

shopRouter.post('/s/:slug/orders', async (req, res) => {
  if (limited(req.ip || 'x', 10, 10 * 60_000)) throw new HttpError(429, 'สั่งซื้อบ่อยเกินไป กรุณารอสักครู่', 'RATE_LIMITED');
  const b = parse(z.object({
    idempotencyKey: z.string().min(8).max(80), items: itemsSchema,
    customer: z.object({ name: z.string().trim().min(1).max(120), phone: z.string().trim().regex(/^[0-9+\-\s]{9,15}$/, 'เบอร์โทรไม่ถูกต้อง'), email: z.string().email().nullable().optional().or(z.literal('')) }),
    fulfillment: z.enum(['pickup', 'delivery']), address: z.string().max(1000).nullable().optional(), note: z.string().max(1000).nullable().optional(),
    paymentMethod: z.enum(['promptpay', 'pay_at_store', 'cod']),
  }), req.body);
  const r = await createOrder({ ...b, store: String(req.params.slug), customer: { ...b.customer, phone: b.customer.phone.replace(/[\s-]/g, '') }, memberToken: memberToken(req) });
  res.status(201).json(r);
});

shopRouter.get('/orders/:orderNo', async (req, res) => {
  const member = await memberFromToken(memberToken(req));
  res.json(await orderView(String(req.params.orderNo), (req.query.t as string) || null, member?.id ?? null));
});

/** Signed-in member: own order history (all stores). */
shopRouter.get('/my-orders', async (req, res) => {
  const member = await memberFromToken(memberToken(req));
  if (!member) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ', 'UNAUTHENTICATED');
  res.json(await q(`SELECT o.order_no, o.status, o.total, o.fulfillment, o.payment_method, o.created_at, s.slug AS store_slug, s.name AS store_name,
    (SELECT COUNT(*)::int FROM online_order_items i WHERE i.order_id=o.id) AS lines FROM online_orders o LEFT JOIN storefronts s ON s.id=o.storefront_id
    WHERE o.member_id=$1 ORDER BY o.id DESC LIMIT 100`, [member.id]));
});

// ================= Back office: online orders =================
export const ordersRouter = Router();
ordersRouter.use(requireStaff, requirePerm('orders.manage', 'payments.verify'));

ordersRouter.get('/', async (req, res) => {
  const params: any[] = [];
  let where = 'WHERE true';
  if (req.query.status) { params.push(String(req.query.status).split(',')); where += ` AND o.status = ANY($${params.length})`; }
  if (req.query.store) { params.push(Number(req.query.store)); where += ` AND o.storefront_id = $${params.length}`; }
  if (req.query.q) { params.push(`%${String(req.query.q)}%`); where += ` AND (o.order_no ILIKE $${params.length} OR o.customer_name ILIKE $${params.length} OR o.customer_phone ILIKE $${params.length})`; }
  res.json(await q(`SELECT o.id, o.order_no, o.status, o.customer_name, o.customer_phone, o.fulfillment, o.payment_method, o.total, o.created_at, o.paid_at,
      o.tracking_no, concat_ws(' ', m.first_name, m.last_name) AS member_name, (SELECT COUNT(*)::int FROM online_order_items i WHERE i.order_id=o.id) AS lines,
      pi.status AS payment_status, sf.name AS store_name
    FROM online_orders o LEFT JOIN members m ON m.id=o.member_id LEFT JOIN payment_intents pi ON pi.id=o.payment_intent_id LEFT JOIN storefronts sf ON sf.id=o.storefront_id
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
