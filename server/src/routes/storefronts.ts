// Back office: online storefronts (which stores exist, which are open, and how each website looks and sells).
import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one } from '../db';
import { requireStaff, requirePerm } from '../auth';
import { parse, bad, notFound, conflict } from '../util';
import { audit } from '../audit';
import { broadcastStaff } from '../realtime';
import { mergeStore } from '../services/shop';

export const storefrontsRouter = Router();
storefrontsRouter.use(requireStaff);

const ids = z.array(z.number().int()).max(500);
const configSchema = z.object({
  tagline: z.string().max(200).default(''),
  logoMediaId: z.number().int().nullable().default(null),
  theme: z.object({ primary: z.string().regex(/^#[0-9a-fA-F]{6}$/), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
  announcements: z.array(z.string().max(200)).max(10),
  banners: z.array(z.object({
    mediaId: z.number().int(), mobileMediaId: z.number().int().nullable().optional(), title: z.string().max(120).optional(), subtitle: z.string().max(240).optional(),
    buttonText: z.string().max(40).optional(), link: z.string().max(500).optional(),
  })).max(20),
  scope: z.object({ mode: z.enum(['all', 'categories', 'brands']), categoryIds: ids, brandIds: ids }),
  home: z.object({ showCategories: z.boolean(), showNew: z.boolean(), showSale: z.boolean(), showBest: z.boolean(), showBrands: z.boolean(), newDays: z.number().int().min(1).max(365) }),
  pickup: z.boolean(), delivery: z.boolean(),
  deliveryFee: z.number().int().min(0), freeDeliveryMin: z.number().int().min(0), minOrder: z.number().int().min(0),
  payments: z.object({ promptpay: z.boolean(), payAtStore: z.boolean(), cod: z.boolean() }),
  paymentTimeoutMinutes: z.number().int().min(5).max(1440),
  contact: z.object({ phone: z.string().max(60), line: z.string().max(120), facebook: z.string().max(300), instagram: z.string().max(300), tiktok: z.string().max(300), email: z.string().max(120), address: z.string().max(500) }),
  locationBranchIds: ids,
  shippingInfo: z.string().max(3000), returnInfo: z.string().max(3000), footerText: z.string().max(1000),
});
const storeSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,39}$/, 'ชื่อในลิงก์ใช้ได้เฉพาะ a-z 0-9 และ - (2–40 ตัว)'),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  branchId: z.number().int().nullable().default(null),
  sortOrder: z.number().int().default(0),
  config: configSchema.partial().default({}),
});

async function firstBranch() { return (await one('SELECT id FROM branches WHERE is_active ORDER BY id LIMIT 1'))!.id as number; }

storefrontsRouter.get('/', async (_req, res) => {
  const fb = await firstBranch();
  const rows = await q(`SELECT s.*, b.name AS branch_name,
      (SELECT COUNT(*)::int FROM online_orders o WHERE o.storefront_id=s.id) AS orders,
      (SELECT COUNT(*)::int FROM online_orders o WHERE o.storefront_id=s.id AND o.status IN ('pending_payment','paid','preparing','ready')) AS open_orders
    FROM storefronts s LEFT JOIN branches b ON b.id=COALESCE(s.branch_id, $1) ORDER BY s.sort_order, s.id`, [fb]);
  res.json(rows.map((r) => ({ ...mergeStore(r, fb), branchName: r.branch_name, orders: r.orders, openOrders: r.open_orders })));
});

const taken = async (slug: string, id: number | null) => !!(await one('SELECT 1 FROM storefronts WHERE slug=$1 AND id IS DISTINCT FROM $2', [slug, id]));

storefrontsRouter.post('/', requirePerm('settings.manage'), async (req, res) => {
  const b = parse(storeSchema, req.body);
  if (await taken(b.slug, null)) throw conflict('ชื่อในลิงก์นี้ถูกใช้แล้ว', 'SLUG_TAKEN');
  const r = await one('INSERT INTO storefronts (slug, name, enabled, branch_id, sort_order, config) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
    [b.slug, b.name, b.enabled, b.branchId, b.sortOrder, JSON.stringify(b.config)]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'storefront.create', entity: 'storefront', entityId: r.id, details: { slug: b.slug, name: b.name } });
  res.json({ id: r.id });
});

storefrontsRouter.put('/:id', requirePerm('settings.manage'), async (req, res) => {
  const id = Number(String(req.params.id));
  const b = parse(storeSchema, req.body);
  const cur = await one('SELECT * FROM storefronts WHERE id=$1', [id]);
  if (!cur) throw notFound();
  if (await taken(b.slug, id)) throw conflict('ชื่อในลิงก์นี้ถูกใช้แล้ว', 'SLUG_TAKEN');
  await pool.query('UPDATE storefronts SET slug=$2, name=$3, enabled=$4, branch_id=$5, sort_order=$6, config=$7, updated_at=now() WHERE id=$1',
    [id, b.slug, b.name, b.enabled, b.branchId, b.sortOrder, JSON.stringify({ ...cur.config, ...b.config })]);
  // drop media no longer referenced by the store (old logos / removed banners)
  const used = new Set<number>([b.config.logoMediaId ?? cur.config.logoMediaId, ...((b.config.banners ?? cur.config.banners ?? []) as any[]).flatMap((x) => [x.mediaId, x.mobileMediaId])].filter(Boolean));
  await pool.query(`DELETE FROM shop_media WHERE storefront_id=$1 AND NOT (id = ANY($2::int[])) AND created_at < now() - interval '1 day'`, [id, [...used]]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'storefront.update', entity: 'storefront', entityId: id, details: { slug: b.slug, enabled: b.enabled } });
  broadcastStaff('storefront.changed', { id });
  res.json({ ok: true });
});

storefrontsRouter.delete('/:id', requirePerm('settings.manage'), async (req, res) => {
  const id = Number(String(req.params.id));
  if (await one('SELECT 1 FROM online_orders WHERE storefront_id=$1 LIMIT 1', [id])) throw conflict('ร้านนี้มีคำสั่งซื้อแล้ว ลบไม่ได้ — ให้ปิดร้านแทน', 'HAS_ORDERS');
  await pool.query('DELETE FROM storefronts WHERE id=$1', [id]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'storefront.delete', entity: 'storefront', entityId: id });
  res.json({ ok: true });
});

/** Upload a logo / banner image for a store (client resizes; JPEG/PNG/WebP only). */
storefrontsRouter.post('/:id/media', requirePerm('settings.manage'), async (req, res) => {
  const id = Number(String(req.params.id));
  const b = parse(z.object({ dataBase64: z.string().min(10).max(10_000_000), mime: z.enum(['image/jpeg', 'image/png', 'image/webp']), width: z.number().int().optional(), height: z.number().int().optional() }), req.body);
  const data = Buffer.from(b.dataBase64, 'base64');
  const sig = data.subarray(0, 12);
  const ok = b.mime === 'image/jpeg' ? sig[0] === 0xff && sig[1] === 0xd8 : b.mime === 'image/png' ? sig.subarray(1, 4).toString() === 'PNG' : sig.subarray(8, 12).toString() === 'WEBP';
  if (!ok) throw bad('ไฟล์รูปภาพไม่ถูกต้อง');
  if (!(await one('SELECT 1 FROM storefronts WHERE id=$1', [id]))) throw notFound();
  const r = await one('INSERT INTO shop_media (storefront_id, mime, data, width, height) VALUES ($1,$2,$3,$4,$5) RETURNING id', [id, b.mime, data, b.width ?? null, b.height ?? null]);
  res.json({ id: r.id, url: `/api/shop/media/${r.id}` });
});
