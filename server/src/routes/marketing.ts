import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, tx } from '../db';
import { requireStaff, requirePerm } from '../auth';
import { parse, notFound, conflict, bad } from '../util';
import { couponEvent, couponPublic, generateUniqueCoupon, normalizeCode } from '../services/coupons';
import { audit } from '../audit';
import { broadcastStaff } from '../realtime';

export const marketingRouter = Router();
marketingRouter.use(requireStaff);

const ids = z.array(z.number().int()).nullable().optional();
const promoSchema = z.object({
  name: z.string().min(1), nameEn: z.string().nullable().optional(), nameZh: z.string().nullable().optional(),
  type: z.enum(['bxgy', 'qty_percent', 'bill_threshold', 'special_price', 'percent_off', 'tier_price', 'birthday', 'receipt_coupon']),
  isActive: z.boolean().default(true), priority: z.number().int().default(100), stackable: z.boolean().default(false),
  startsAt: z.string().nullable().optional(), endsAt: z.string().nullable().optional(),
  daysOfWeek: ids, timeStart: z.string().nullable().optional(), timeEnd: z.string().nullable().optional(),
  branchIds: ids, tierIds: ids, memberOnly: z.boolean().default(false), productIds: ids, categoryIds: ids, brandIds: ids,
  promoCode: z.string().nullable().optional(), usageLimit: z.number().int().positive().nullable().optional(),
  params: z.record(z.string(), z.any()).default({}), description: z.string().nullable().optional(), imageUrl: z.string().nullable().optional(),
  showOnDisplay: z.boolean().default(true),
});

const nz = (a?: number[] | null) => (a && a.length ? a : null);
const promoVals = (p: z.infer<typeof promoSchema>) => [p.name, p.nameEn ?? null, p.nameZh ?? null, p.type, p.isActive, p.priority, p.stackable, p.startsAt || null, p.endsAt || null,
  nz(p.daysOfWeek), p.timeStart || null, p.timeEnd || null, nz(p.branchIds), nz(p.tierIds), p.memberOnly, nz(p.productIds), nz(p.categoryIds), nz(p.brandIds),
  p.promoCode || null, p.usageLimit ?? null, JSON.stringify(p.params), p.description ?? null, p.imageUrl ?? null, p.showOnDisplay];
const PROMO_COLS = 'name,name_en,name_zh,type,is_active,priority,stackable,starts_at,ends_at,days_of_week,time_start,time_end,branch_ids,tier_ids,member_only,product_ids,category_ids,brand_ids,promo_code,usage_limit,params,description,image_url,show_on_display';

function validateParams(p: z.infer<typeof promoSchema>) {
  const r = p.params as Record<string, any>;
  if (p.type === 'receipt_coupon') {
    if (!r.reward?.type) throw bad('กรุณากำหนดสิทธิ์ของคูปอง (reward)');
    if (!r.minSpend && !r.minQty && !nz(p.productIds) && !nz(p.categoryIds) && !nz(p.brandIds)) throw bad('กรุณากำหนดเงื่อนไขการออกคูปองอย่างน้อย 1 อย่าง');
  }
  if (p.type === 'bxgy' && !(r.buy > 0 && r.get > 0)) throw bad('กรุณาระบุจำนวนซื้อ/แถม');
}

marketingRouter.get('/promotions', requirePerm('promotions.manage', 'coupons.manage', 'reports.view'), async (_req, res) => {
  res.json(await q(`SELECT p.*, (SELECT COUNT(*) FROM coupons c WHERE c.promotion_id=p.id)::int AS coupons_issued FROM promotions p ORDER BY p.is_active DESC, p.priority, p.id DESC`));
});
marketingRouter.post('/promotions', requirePerm('promotions.manage'), async (req, res) => {
  const p = parse(promoSchema, req.body);
  validateParams(p);
  const r = await one(`INSERT INTO promotions (${PROMO_COLS}) VALUES (${PROMO_COLS.split(',').map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, promoVals(p));
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'promotion.create', entity: 'promotion', entityId: r.id, details: p });
  broadcastStaff('catalog.changed', {});
  res.json(r);
});
marketingRouter.put('/promotions/:id', requirePerm('promotions.manage'), async (req, res) => {
  const p = parse(promoSchema, req.body);
  validateParams(p);
  await pool.query(`UPDATE promotions SET ${PROMO_COLS.split(',').map((c, i) => `${c}=$${i + 1}`).join(',')} WHERE id=$25`, [...promoVals(p), String(req.params.id)]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'promotion.update', entity: 'promotion', entityId: String(req.params.id), details: p });
  broadcastStaff('catalog.changed', {});
  res.json({ ok: true });
});
marketingRouter.delete('/promotions/:id', requirePerm('promotions.manage'), async (req, res) => {
  const used = await one('SELECT 1 FROM coupons WHERE promotion_id=$1 LIMIT 1', [String(req.params.id)]);
  if (used) await pool.query('UPDATE promotions SET is_active=false WHERE id=$1', [String(req.params.id)]);
  else await pool.query('DELETE FROM promotions WHERE id=$1', [String(req.params.id)]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'promotion.delete', entity: 'promotion', entityId: String(req.params.id) });
  broadcastStaff('catalog.changed', {});
  res.json({ ok: true, deactivated: !!used });
});

// ---------- Receipt Coupon management ----------
marketingRouter.get('/coupons/stats', requirePerm('coupons.manage', 'reports.view'), async (req, res) => {
  const pid = req.query.promotionId ? Number(req.query.promotionId) : null;
  const s = await one(`SELECT COUNT(*)::int AS issued,
      COUNT(*) FILTER (WHERE status='USED')::int AS redeemed,
      COUNT(*) FILTER (WHERE status='ACTIVE')::int AS active,
      COUNT(*) FILTER (WHERE status='RESERVED')::int AS reserved,
      COUNT(*) FILTER (WHERE status='EXPIRED')::int AS expired,
      COUNT(*) FILTER (WHERE status IN ('CANCELLED','VOID'))::int AS cancelled,
      COUNT(*) FILTER (WHERE status='PENDING_REVIEW')::int AS pending_review,
      COALESCE(SUM(discount_amount) FILTER (WHERE status='USED'),0)::bigint AS discount_used
    FROM coupons WHERE ($1::int IS NULL OR promotion_id=$1)`, [pid]);
  const byPromo = await q(`SELECT p.id, p.name, COUNT(c.id)::int AS issued, COUNT(c.id) FILTER (WHERE c.status='USED')::int AS redeemed,
      COALESCE(SUM(c.discount_amount) FILTER (WHERE c.status='USED'),0)::bigint AS discount_used,
      COALESCE((SELECT SUM(s.total) FROM sales s WHERE s.id IN (SELECT redeemed_sale_id FROM coupons c2 WHERE c2.promotion_id=p.id AND c2.status='USED')),0)::bigint AS redeemed_sales
    FROM promotions p JOIN coupons c ON c.promotion_id=p.id GROUP BY p.id ORDER BY issued DESC`);
  res.json({ ...s, redemptionRate: s.issued ? s.redeemed / s.issued : 0, byPromotion: byPromo });
});

marketingRouter.get('/coupons', requirePerm('coupons.manage', 'reports.view'), async (req, res) => {
  const term = normalizeCode(String(req.query.q || ''));
  const status = req.query.status ? String(req.query.status) : null;
  const rows = await q(`SELECT c.*, p.name AS promotion_name, si.bill_no AS issued_bill_no, sr.bill_no AS redeemed_bill_no, ib.name AS issued_branch_name,
      rb.name AS redeemed_branch_name, m.member_no, m.first_name AS member_first_name, rs.name AS redeemed_staff_name, it.code AS issued_terminal_code, rt.code AS redeemed_terminal_code
    FROM coupons c LEFT JOIN promotions p ON p.id=c.promotion_id LEFT JOIN sales si ON si.id=c.issued_sale_id LEFT JOIN sales sr ON sr.id=c.redeemed_sale_id
    LEFT JOIN branches ib ON ib.id=c.issued_branch_id LEFT JOIN branches rb ON rb.id=c.redeemed_branch_id LEFT JOIN members m ON m.id=COALESCE(c.member_id, si.member_id)
    LEFT JOIN staff rs ON rs.id=c.redeemed_staff_id LEFT JOIN terminals it ON it.id=c.issued_terminal_id LEFT JOIN terminals rt ON rt.id=c.redeemed_terminal_id
    WHERE ($1 = '' OR c.code LIKE '%'||$1||'%' OR c.barcode_value = $1) AND ($2::text IS NULL OR c.status=$2) AND ($3::int IS NULL OR c.promotion_id=$3)
    ORDER BY c.issued_at DESC LIMIT 500`, [term, status, req.query.promotionId ? Number(req.query.promotionId) : null]);
  res.json(rows.map((r) => ({
    ...couponPublic(r), promotionName: r.promotion_name, issuedBillNo: r.issued_bill_no, redeemedBillNo: r.redeemed_bill_no, issuedBranch: r.issued_branch_name,
    redeemedBranch: r.redeemed_branch_name, memberNo: r.member_no, memberName: r.member_first_name, redeemedStaff: r.redeemed_staff_name,
    issuedTerminal: r.issued_terminal_code, redeemedTerminal: r.redeemed_terminal_code, issuedSaleId: r.issued_sale_id, redeemedSaleId: r.redeemed_sale_id, source: r.source, note: r.note,
  })));
});

marketingRouter.get('/coupons/:id/events', requirePerm('coupons.manage', 'audit.view'), async (req, res) => {
  res.json(await q(`SELECT e.*, s.name AS staff_name, sa.bill_no FROM coupon_events e LEFT JOIN staff s ON s.id=e.staff_id LEFT JOIN sales sa ON sa.id=e.sale_id WHERE coupon_id=$1 ORDER BY e.created_at`, [String(req.params.id)]));
});

/** Manual status change: cancel / void / approve-after-review / extend. All audited. */
marketingRouter.post('/coupons/:id/status', requirePerm('coupons.manage'), async (req, res) => {
  const b = parse(z.object({ action: z.enum(['cancel', 'void', 'reactivate', 'extend']), reason: z.string().min(2), expiresAt: z.string().optional() }), req.body);
  const r = await tx(async (db) => {
    const c = (await db.query('SELECT * FROM coupons WHERE id=$1 FOR UPDATE', [String(req.params.id)])).rows[0];
    if (!c) throw notFound();
    let to = c.status;
    if (b.action === 'cancel' || b.action === 'void') {
      if (c.status === 'USED') throw conflict('คูปองถูกใช้แล้ว ไม่สามารถยกเลิกได้');
      to = b.action === 'cancel' ? 'CANCELLED' : 'VOID';
    } else if (b.action === 'reactivate') {
      if (!['PENDING_REVIEW', 'CANCELLED', 'EXPIRED'].includes(c.status)) throw conflict('สถานะนี้ไม่สามารถเปิดใช้งานใหม่ได้');
      to = 'ACTIVE';
      if (new Date(c.expires_at) < new Date() && !b.expiresAt) throw bad('คูปองหมดอายุแล้ว กรุณาระบุวันหมดอายุใหม่');
    }
    await db.query(`UPDATE coupons SET status=$2, expires_at=COALESCE($3, expires_at), reserved_cart_id=NULL, reserved_until=NULL, note=$4 WHERE id=$1`, [c.id, to, b.expiresAt ?? null, b.reason]);
    await couponEvent(db, { couponId: c.id, from: c.status, to, staffId: req.staff!.id, reason: `${b.action}: ${b.reason}` });
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: `coupon.${b.action}`, entity: 'coupon', entityId: c.id, reason: b.reason, details: { code: c.code, from: c.status, to } }, db);
    return { status: to };
  });
  res.json(r);
});

/** Manually issue coupons (e.g. compensation / marketing campaigns). */
marketingRouter.post('/coupons/issue', requirePerm('coupons.manage'), async (req, res) => {
  const b = parse(z.object({ promotionId: z.number().int(), count: z.number().int().min(1).max(1000), memberId: z.number().int().nullable().optional(), reason: z.string().min(2) }), req.body);
  const out = await tx(async (db) => {
    const p = (await db.query(`SELECT * FROM promotions WHERE id=$1 AND type='receipt_coupon'`, [b.promotionId])).rows[0];
    if (!p) throw bad('ต้องเลือกโปรโมชั่นประเภทคูปองท้ายใบเสร็จ');
    const prm = p.params || {};
    const list = [];
    for (let i = 0; i < b.count; i++) {
      const c = await generateUniqueCoupon(db, {
        promotion_id: p.id, member_id: b.memberId ?? null, source: 'manual', reward: JSON.stringify(prm.reward), title: prm.title || p.name,
        min_spend: Number(prm.redeemMinSpend || 0), branch_ids: prm.redeemBranchIds?.length ? prm.redeemBranchIds : null, status: 'ACTIVE',
        expires_at: new Date(Date.now() + Number(prm.validDays || 30) * 86400000), note: b.reason,
      });
      await couponEvent(db, { couponId: c.id, to: 'ACTIVE', staffId: req.staff!.id, reason: 'manual issue: ' + b.reason });
      list.push(couponPublic(c));
    }
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'coupon.issue_manual', entity: 'promotion', entityId: p.id, reason: b.reason, details: { count: b.count } }, db);
    return list;
  });
  res.json(out);
});

// ---------- Gift cards ----------
marketingRouter.get('/gift-cards', requirePerm('coupons.manage'), async (_req, res) => res.json(await q('SELECT * FROM gift_cards ORDER BY created_at DESC LIMIT 500')));
marketingRouter.post('/gift-cards', requirePerm('coupons.manage'), async (req, res) => {
  const b = parse(z.object({ amount: z.number().int().positive(), count: z.number().int().min(1).max(500).default(1), validDays: z.number().int().positive().default(365) }), req.body);
  const { randomCode } = await import('../util');
  const out = [];
  for (let i = 0; i < b.count; i++) {
    out.push(await one(`INSERT INTO gift_cards (code, initial_balance, balance, expires_at) VALUES ($1,$2,$2, now() + ($3 || ' days')::interval) RETURNING *`, ['GC-' + randomCode(10), b.amount, String(b.validDays)]));
  }
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'giftcard.issue', details: { amount: b.amount, count: b.count } });
  res.json(out);
});
marketingRouter.get('/gift-cards/:code', requirePerm('pos.sell', 'coupons.manage'), async (req, res) => {
  const g = await one('SELECT code, balance, status, expires_at FROM gift_cards WHERE code=$1', [String(req.params.code).toUpperCase()]);
  if (!g) throw notFound('ไม่พบบัตรของขวัญ');
  res.json(g);
});

/**
 * Optional AI image generation for promotion artwork. Proxies an OpenAI-compatible images endpoint
 * (POST {model, prompt, size} -> {data:[{b64_json|url}]}) configured with AI_IMAGE_ENDPOINT / AI_IMAGE_API_KEY.
 * Disabled (503) when not configured — the template-based poster generator works without it.
 */
marketingRouter.post('/ai-image', requirePerm('promotions.manage'), async (req, res) => {
  const endpoint = process.env.AI_IMAGE_ENDPOINT;
  const key = process.env.AI_IMAGE_API_KEY;
  if (!endpoint || !key) throw new (await import('../util')).HttpError(503, 'ยังไม่ได้เชื่อมต่อบริการสร้างภาพด้วย AI (ตั้งค่า AI_IMAGE_ENDPOINT และ AI_IMAGE_API_KEY)', 'AI_NOT_CONFIGURED');
  const b = parse(z.object({ prompt: z.string().min(3).max(1000) }), req.body);
  const r = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.AI_IMAGE_MODEL || undefined, prompt: b.prompt, size: '1536x1024', n: 1 }),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new (await import('../util')).HttpError(502, 'AI image error: ' + (j?.error?.message || r.status), 'AI_ERROR');
  const d = j?.data?.[0];
  const image = d?.b64_json ? `data:image/png;base64,${d.b64_json}` : d?.url;
  if (!image) throw bad('AI ไม่ส่งภาพกลับมา');
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'marketing.ai_image', details: { prompt: b.prompt } });
  res.json({ image });
});
