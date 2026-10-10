import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one } from '../db';
import { requireStaff, requirePerm, authorizeOrApproval } from '../auth';
import { parse, bad, notFound, sha256, randomToken, randomCode } from '../util';
import { checkout, checkoutSchema, receiptPayload, previewPrice } from '../services/checkout';
import { refundSale, refundSchema } from '../services/refund';
import { validateCoupon, reserveCoupon, releaseCoupons, couponPublic } from '../services/coupons';
import { activePromotions, productPublic } from '../services/catalog';
import { getAllSettings } from '../settings';
import { publish, broadcastStaff, terminalChannel, onDisplayPaired, presence } from '../realtime';
import { audit } from '../audit';
import { parseWeightedBarcode } from '../../../shared/barcode';
import { getSetting } from '../settings';

export const posRouter = Router();
posRouter.use(requireStaff);

const PRODUCT_SELECT = `
  SELECT p.*, u.name AS unit_name, c.name AS category_name, b.name AS brand_name,
    COALESCE((SELECT json_agg(json_build_object('barcode', pb.barcode, 'packQty', pb.pack_qty, 'packPrice', pb.pack_price)) FROM product_barcodes pb WHERE pb.product_id=p.id), '[]') AS barcodes,
    COALESCE((SELECT qty FROM stock_levels sl WHERE sl.product_id=p.id AND sl.branch_id=$1), 0) AS stock
  FROM products p LEFT JOIN units u ON u.id=p.unit_id LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id`;

async function branchOf(terminalId: number | null, staffBranch: number | null) {
  if (terminalId) return (await one('SELECT branch_id FROM terminals WHERE id=$1', [terminalId]))!.branch_id as number;
  return staffBranch ?? (await one('SELECT id FROM branches ORDER BY id LIMIT 1'))!.id;
}

/** Full catalog snapshot for the POS (cached in IndexedDB for offline selling). */
posRouter.get('/catalog', async (req, res) => {
  const branchId = await branchOf(req.staff!.terminalId, req.staff!.branchId);
  const products = (await q(`${PRODUCT_SELECT} WHERE p.is_active ORDER BY p.name`, [branchId])).map(productPublic);
  const promotions = await activePromotions();
  const settings = await getAllSettings();
  const categories = await q('SELECT * FROM categories ORDER BY name');
  const tiers = await q('SELECT * FROM tiers ORDER BY rank');
  const terminal = req.staff!.terminalId ? await one('SELECT t.*, b.name AS branch_name, b.address AS branch_address, b.phone AS branch_phone, b.tax_id AS branch_tax_id FROM terminals t JOIN branches b ON b.id=t.branch_id WHERE t.id=$1', [req.staff!.terminalId]) : null;
  res.json({ version: Date.now(), branchId, products, promotions, settings, categories, tiers, terminal });
});

/** Lookup by barcode (supports multiple barcodes per product, pack barcodes, weighted EAN-13). */
posRouter.get('/lookup/:code', async (req, res) => {
  const code = String(req.params.code).trim();
  const branchId = await branchOf(req.staff!.terminalId, req.staff!.branchId);
  let row = await one(`${PRODUCT_SELECT} JOIN product_barcodes x ON x.product_id=p.id WHERE x.barcode=$2`, [branchId, code]);
  let match: any = { barcode: code, packQty: 1, priceSource: 'regular' };
  if (row) {
    const bc = await one('SELECT * FROM product_barcodes WHERE barcode=$1', [code]);
    if (Number(bc.pack_qty) !== 1 || bc.pack_price != null) match = { barcode: code, packQty: Number(bc.pack_qty), packPrice: bc.pack_price, priceSource: 'pack' };
  } else {
    const cfg = (await getSetting('pos')).weightedBarcode;
    const w = parseWeightedBarcode(code, cfg);
    if (w) {
      row = await one(`${PRODUCT_SELECT} JOIN product_barcodes x ON x.product_id=p.id WHERE x.barcode=$2`, [branchId, w.plu]);
      if (row) match = { barcode: code, weightKg: w.weightKg, priceSatang: w.priceSatang, priceSource: w.priceSatang != null ? 'embedded' : 'regular' };
    }
    if (!row) row = await one(`${PRODUCT_SELECT} WHERE p.sku=$2`, [branchId, code]);
  }
  if (!row) throw notFound(`ไม่พบสินค้าบาร์โค้ด ${code}`);
  res.json({ product: productPublic(row), match });
});

/** Live stock at this terminal's branch: { [productId]: qty | null } */
posRouter.get('/stock', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  const branchId = await branchOf(req.staff!.terminalId, req.staff!.branchId);
  const rows = ids.length ? await q('SELECT p.id, sl.qty FROM products p LEFT JOIN stock_levels sl ON sl.product_id=p.id AND sl.branch_id=$1 WHERE p.id = ANY($2)', [branchId, ids]) : [];
  res.json(Object.fromEntries(rows.map((r) => [r.id, r.qty ?? 0])));
});

posRouter.get('/search', async (req, res) => {
  const term = String(req.query.q || '').trim();
  const branchId = await branchOf(req.staff!.terminalId, req.staff!.branchId);
  const rows = await q(
    `${PRODUCT_SELECT} WHERE p.is_active AND (p.name ILIKE $2 OR p.name_en ILIKE $2 OR p.sku ILIKE $2 OR EXISTS (SELECT 1 FROM product_barcodes z WHERE z.product_id=p.id AND z.barcode LIKE $3)) ORDER BY p.name LIMIT 50`,
    [branchId, `%${term}%`, `${term}%`]);
  res.json(rows.map(productPublic));
});

/** Next bill sequence for this terminal (POS keeps a local counter for offline use). */
posRouter.get('/bill-seq', async (req, res) => {
  if (!req.staff!.terminalId) throw bad('ไม่ได้ผูกเครื่อง POS');
  const t = await one('SELECT code, last_bill_seq FROM terminals WHERE id=$1', [req.staff!.terminalId]);
  res.json({ terminalCode: t.code, lastSeq: t.last_bill_seq });
});

posRouter.post('/price', async (req, res) => {
  const b = parse(checkoutSchema.pick({ lines: true, memberId: true, promoCodes: true, couponCodes: true, manualDiscount: true, redeemPoints: true }), req.body);
  res.json(await previewPrice(req.staff!, b));
});

posRouter.post('/checkout', requirePerm('pos.sell'), async (req, res) => {
  const input = parse(checkoutSchema, req.body);
  const result = await checkout(req.staff!, input, req.ip);
  const r = result.receipt!;
  if (!result.duplicate) {
    publish(terminalChannel(r.terminal.id), 'sale.completed', { saleId: r.sale.id, billNo: r.sale.billNo });
    broadcastStaff('sale.completed', { saleId: r.sale.id, billNo: r.sale.billNo, total: r.sale.total, branchId: r.branch.id, terminalId: r.terminal.id });
    broadcastStaff('stock.changed', { productIds: r.items.map((i) => i.productId), branchId: r.branch.id });
  }
  res.json(result);
});

posRouter.get('/sales', async (req, res) => {
  const term = String(req.query.q || '').trim();
  const rows = await q(
    `SELECT s.id, s.bill_no, s.total, s.status, s.created_at, s.items_count, t.code AS terminal_code, st.name AS staff_name, m.member_no
     FROM sales s JOIN terminals t ON t.id=s.terminal_id JOIN staff st ON st.id=s.staff_id LEFT JOIN members m ON m.id=s.member_id
     WHERE ($1 = '' OR s.bill_no ILIKE '%'||$1||'%') AND ($2::int IS NULL OR s.terminal_id=$2)
     ORDER BY s.created_at DESC LIMIT 100`, [term, req.query.mine ? req.staff!.terminalId : null]);
  res.json(rows);
});

posRouter.get('/sales/:id/receipt', async (req, res) => {
  const r = await receiptPayload(Number(String(req.params.id)));
  if (!r) throw notFound();
  res.json(r);
});

posRouter.post('/sales/:id/refund', async (req, res) => {
  const input = parse(refundSchema, req.body);
  const r = await refundSale(req.staff!, Number(String(req.params.id)), input, req.ip);
  broadcastStaff('sale.refunded', { saleId: Number(String(req.params.id)) });
  res.json(r);
});

/** Reprint is logged (and needs permission or approval). */
posRouter.post('/sales/:id/reprint', async (req, res) => {
  const b = parse(z.object({ approvalId: z.string().nullable().optional(), kind: z.string().default('both') }), req.body);
  const approver = await authorizeOrApproval(pool, req.staff!, 'pos.reprint', b.approvalId);
  const r = await receiptPayload(Number(String(req.params.id)));
  if (!r) throw notFound();
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'receipt.reprint', entity: 'sale', entityId: r.sale.id, billNo: r.sale.billNo, approvedBy: approver, terminalId: req.staff!.terminalId, details: { kind: b.kind }, ip: req.ip });
  res.json(r);
});

// ---------- coupons ----------
posRouter.post('/coupons/validate', async (req, res) => {
  const b = parse(z.object({ code: z.string().min(3), cartId: z.string().optional(), memberId: z.number().nullable().optional() }), req.body);
  const branchId = await branchOf(req.staff!.terminalId, req.staff!.branchId);
  const r = await validateCoupon(b.code, { branchId, cartId: b.cartId, memberId: b.memberId ?? null });
  res.json({ ...r, coupon: r.coupon ? couponPublic(r.coupon) : undefined, redeemedBranch: r.coupon?.redeemed_branch_name });
});

posRouter.post('/coupons/reserve', async (req, res) => {
  const b = parse(z.object({ code: z.string(), cartId: z.string(), memberId: z.number().nullable().optional() }), req.body);
  const branchId = await branchOf(req.staff!.terminalId, req.staff!.branchId);
  if (!req.staff!.terminalId) throw bad('ไม่ได้ผูกเครื่อง POS');
  const c = await reserveCoupon(b.code, { cartId: b.cartId, branchId, terminalId: req.staff!.terminalId, staffId: req.staff!.id, memberId: b.memberId ?? null });
  res.json(c);
});

posRouter.post('/coupons/release', async (req, res) => {
  const b = parse(z.object({ cartId: z.string(), code: z.string().optional(), reason: z.string().optional() }), req.body);
  const n = await releaseCoupons(b.cartId, { code: b.code, staffId: req.staff!.id, reason: b.reason });
  res.json({ released: n });
});

// ---------- members at the till ----------
const MEMBER_TILL_SELECT = `SELECT m.id, m.member_no, m.first_name, m.last_name, m.phone, m.points, m.birthday, m.tier_id, m.created_at, t.name AS tier_name, t.discount_pct,
     (m.password_hash IS NOT NULL) AS has_password
   FROM members m LEFT JOIN tiers t ON t.id=m.tier_id`;
const maskPhone = (m: any) => ({ ...m, phone: m.phone.replace(/^(\d{3})\d+(\d{3})$/, '$1-xxx-$2') });

posRouter.get('/members/find', async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 3) return res.json([]);
  const rows = await q(
    `${MEMBER_TILL_SELECT}
     WHERE m.is_active AND (m.member_no = upper($1) OR m.phone = $1 OR m.phone LIKE '%'||$1 OR (m.first_name||' '||coalesce(m.last_name,'')) ILIKE '%'||$1||'%'
       OR m.id = (SELECT member_id FROM member_cards c WHERE c.code=$1 AND c.status='active')) LIMIT 10`, [term]);
  res.json(rows.map(maskPhone)); // phone numbers are masked at the till
});

/**
 * Identify a member at the till by one of 4 methods:
 *  phone (full number), card (printed card number), barcode (scanned card barcode), tap (RFID/NFC UID).
 * Member-number barcodes (M#########) are accepted for barcode as well.
 */
posRouter.post('/members/identify', async (req, res) => {
  const b = parse(z.object({ method: z.enum(['phone', 'card', 'barcode', 'tap']), value: z.string().min(3).max(64) }), req.body);
  const v = b.value.trim();
  let row: any;
  if (b.method === 'phone') {
    row = await one(`${MEMBER_TILL_SELECT} WHERE m.is_active AND m.phone=$1`, [v.replace(/\D/g, '')]);
  } else {
    row = await one(`${MEMBER_TILL_SELECT} WHERE m.is_active AND (m.id = (SELECT member_id FROM member_cards c WHERE c.code=$1 AND c.status='active') OR m.member_no = upper($1))`, [v]);
  }
  if (!row) throw notFound(b.method === 'phone' ? 'ไม่พบสมาชิกจากเบอร์โทรนี้' : 'ไม่พบบัตรสมาชิกนี้ (ยังไม่ได้ผูกบัตร?)');
  res.json(maskPhone(row));
});

// ---------- customer display pairing ----------
posRouter.post('/display/pair', async (req, res) => {
  const b = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
  if (!req.staff!.terminalId) throw bad('ไม่ได้ผูกเครื่อง POS');
  const p = await one(`UPDATE display_pairings SET terminal_id=$2, paired_at=now() WHERE code=$1 AND expires_at > now() AND paired_at IS NULL RETURNING display_id`, [b.code, req.staff!.terminalId]);
  if (!p) throw bad('รหัสจับคู่ไม่ถูกต้องหรือหมดอายุ', 'PAIR_INVALID');
  await pool.query('UPDATE displays SET terminal_id=$2, paired_at=now() WHERE id=$1', [p.display_id, req.staff!.terminalId]);
  onDisplayPaired(p.display_id, req.staff!.terminalId);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'display.paired', entity: 'display', entityId: p.display_id, terminalId: req.staff!.terminalId });
  res.json({ ok: true, displayId: p.display_id });
});

posRouter.post('/display/:id/unpair', async (req, res) => {
  await pool.query('UPDATE displays SET terminal_id=NULL WHERE id=$1 AND terminal_id=$2', [String(req.params.id), req.staff!.terminalId]);
  publish(`display:${String(req.params.id)}`, 'display.unpaired', {});
  res.json({ ok: true });
});

posRouter.get('/display/list', async (req, res) => {
  const rows = await q('SELECT id, name, lang, paired_at, last_seen_at FROM displays WHERE terminal_id=$1', [req.staff!.terminalId]);
  res.json({ displays: rows, presence: presence()[req.staff!.terminalId ?? -1] || { pos: 0, displays: [] } });
});

// ---------- print job log (printing happens on the client device; the server keeps an auditable log) ----------
posRouter.post('/print-jobs', async (req, res) => {
  const b = parse(z.object({ id: z.string().uuid(), saleId: z.number().nullable().optional(), kind: z.string(), status: z.enum(['queued', 'printing', 'printed', 'failed', 'cancelled']), attempts: z.number().int().default(0), transport: z.string().optional(), error: z.string().nullable().optional() }), req.body);
  await pool.query(
    `INSERT INTO print_jobs (id, sale_id, terminal_id, kind, status, attempts, transport, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, attempts=EXCLUDED.attempts, transport=EXCLUDED.transport, error=EXCLUDED.error, updated_at=now()`,
    [b.id, b.saleId ?? null, req.staff!.terminalId, b.kind, b.status, b.attempts, b.transport ?? null, b.error ?? null]);
  res.json({ ok: true });
});

posRouter.get('/print-jobs', async (req, res) => {
  res.json(await q(`SELECT pj.*, s.bill_no FROM print_jobs pj LEFT JOIN sales s ON s.id=pj.sale_id WHERE pj.terminal_id=$1 ORDER BY pj.created_at DESC LIMIT 100`, [req.staff!.terminalId]));
});

// ---------- display pairing (public part, used by the display device itself) ----------
export const displayPublicRouter = Router();
displayPublicRouter.post('/pair-request', async (req, res) => {
  const b = parse(z.object({ lang: z.string().optional(), name: z.string().optional() }), req.body ?? {});
  const id = randomToken(12);
  const token = randomToken();
  let code = '';
  for (let i = 0; i < 10; i++) {
    code = randomCode(6, '0123456789');
    const r = await pool.query(`INSERT INTO display_pairings (code, display_id, expires_at) VALUES ($1,$2, now() + interval '10 minutes') ON CONFLICT DO NOTHING`, [code, id]);
    if (r.rowCount) break;
  }
  await pool.query('INSERT INTO displays (id, token_hash, name, lang) VALUES ($1,$2,$3,$4)', [id, sha256(token), b.name ?? 'Customer Display', b.lang ?? 'th']);
  res.json({ displayId: id, displayToken: token, code, expiresInSec: 600 });
});

displayPublicRouter.get('/config', async (req, res) => {
  const tok = String(req.query.token || '');
  const d = await one('SELECT * FROM displays WHERE token_hash=$1', [sha256(tok)]);
  if (!d) throw notFound('ไม่พบหน้าจอ');
  const settings = await getAllSettings();
  const promos = await q(`SELECT id, name, name_en, name_zh, description, image_url FROM promotions WHERE is_active AND show_on_display AND (ends_at IS NULL OR ends_at > now()) AND (starts_at IS NULL OR starts_at <= now()) ORDER BY priority LIMIT 20`);
  const terminal = d.terminal_id ? await one('SELECT t.code, t.name, b.name AS branch_name FROM terminals t JOIN branches b ON b.id=t.branch_id WHERE t.id=$1', [d.terminal_id]) : null;
  res.json({ display: { id: d.id, terminalId: d.terminal_id, lang: d.lang }, terminal, store: settings.store, display_settings: settings.display, fonts: settings.fonts, promotions: promos });
});
