import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, tx } from '../db';
import { requireStaff, requirePerm, hashPin, can } from '../auth';
import { parse, bad, notFound, forbidden } from '../util';
import { getAllSettings, setSetting, clearSettingsCache, DEFAULT_SETTINGS } from '../settings';
import { audit } from '../audit';
import { presence, broadcastStaff } from '../realtime';
import { ALL_PERMISSIONS, PERMISSIONS } from '../../../shared/permissions';

export const adminRouter = Router();
adminRouter.use(requireStaff);

// ---------- settings ----------
adminRouter.get('/settings', async (_req, res) => res.json(await getAllSettings()));
adminRouter.put('/settings/:key', requirePerm('settings.manage'), async (req, res) => {
  const key = String(req.params.key);
  if (!(key in DEFAULT_SETTINGS) && !/^[a-z_]+$/.test(key)) throw bad('invalid key');
  await setSetting(key, req.body, req.staff!.id);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'settings.update', entity: 'settings', entityId: key });
  broadcastStaff('settings.changed', { key });
  res.json({ ok: true });
});

// ---------- fonts (Google Fonts by family name, or uploaded TTF/OTF/WOFF/WOFF2) ----------
adminRouter.get('/fonts', async (_req, res) => res.json(await q('SELECT id, family, source, format, weight, created_at FROM fonts ORDER BY family')));
adminRouter.post('/fonts', requirePerm('settings.manage'), async (req, res) => {
  const b = parse(z.object({ family: z.string().min(1).max(80), source: z.enum(['google', 'upload']), weight: z.string().default('400'), format: z.enum(['ttf', 'otf', 'woff', 'woff2']).optional(), dataBase64: z.string().max(15_000_000).optional() }), req.body);
  let data: Buffer | null = null;
  if (b.source === 'upload') {
    if (!b.dataBase64 || !b.format) throw bad('กรุณาเลือกไฟล์ฟอนต์');
    data = Buffer.from(b.dataBase64, 'base64');
    const sig = data.subarray(0, 4).toString('latin1');
    const okSig = { ttf: ['\x00\x01\x00\x00', 'true'], otf: ['OTTO'], woff: ['wOFF'], woff2: ['wOF2'] }[b.format];
    if (!okSig.includes(sig)) throw bad('ไฟล์ฟอนต์ไม่ถูกต้องหรือไม่ตรงกับนามสกุล');
  }
  const r = await one('INSERT INTO fonts (family, source, format, weight, data) VALUES ($1,$2,$3,$4,$5) RETURNING id, family, source, format, weight', [b.family, b.source, b.format ?? null, b.weight, data]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'font.add', details: { family: b.family, source: b.source } });
  res.json(r);
});
adminRouter.delete('/fonts/:id', requirePerm('settings.manage'), async (req, res) => {
  await pool.query('DELETE FROM fonts WHERE id=$1', [String(req.params.id)]);
  res.json({ ok: true });
});

// ---------- branches & terminals ----------
adminRouter.get('/branches', async (_req, res) => res.json(await q('SELECT * FROM branches ORDER BY id')));
adminRouter.post('/branches', requirePerm('settings.manage'), async (req, res) => {
  const b = parse(z.object({ id: z.number().optional(), code: z.string(), name: z.string(), nameEn: z.string().nullable().optional(), address: z.string().nullable().optional(), phone: z.string().nullable().optional(), taxId: z.string().nullable().optional(), isActive: z.boolean().default(true) }), req.body);
  const v = [b.code, b.name, b.nameEn ?? null, b.address ?? null, b.phone ?? null, b.taxId ?? null, b.isActive];
  if (b.id) await pool.query('UPDATE branches SET code=$1,name=$2,name_en=$3,address=$4,phone=$5,tax_id=$6,is_active=$7 WHERE id=$8', [...v, b.id]);
  else await pool.query('INSERT INTO branches (code,name,name_en,address,phone,tax_id,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7)', v);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'branch.save', details: b });
  res.json({ ok: true });
});
adminRouter.get('/terminals', async (_req, res) => {
  const rows = await q('SELECT t.*, b.name AS branch_name FROM terminals t JOIN branches b ON b.id=t.branch_id ORDER BY t.code');
  const pres = presence();
  res.json(rows.map((t) => ({ ...t, online: pres[t.id] || { pos: 0, displays: [] } })));
});
adminRouter.post('/terminals', requirePerm('settings.manage'), async (req, res) => {
  const b = parse(z.object({ id: z.number().optional(), code: z.string().regex(/^[A-Z0-9-]{2,20}$/, 'รหัสเครื่องใช้ A-Z 0-9 -'), name: z.string(), branchId: z.number(), isActive: z.boolean().default(true) }), req.body);
  if (b.id) await pool.query('UPDATE terminals SET code=$1, name=$2, branch_id=$3, is_active=$4 WHERE id=$5', [b.code, b.name, b.branchId, b.isActive, b.id]);
  else await pool.query('INSERT INTO terminals (code, name, branch_id, is_active) VALUES ($1,$2,$3,$4)', [b.code, b.name, b.branchId, b.isActive]);
  res.json({ ok: true });
});
/** Per-terminal device settings (printer, scanner, scale, drawer, receipt print options). */
adminRouter.put('/terminals/:id/settings', async (req, res) => {
  const id = Number(String(req.params.id));
  if (!can(req.staff, 'settings.manage') && req.staff!.terminalId !== id) throw forbidden();
  await pool.query('UPDATE terminals SET settings=$2 WHERE id=$1', [id, JSON.stringify(req.body ?? {})]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'terminal.device_settings', entity: 'terminal', entityId: id });
  res.json({ ok: true });
});
adminRouter.get('/devices/status', async (_req, res) => {
  res.json({ presence: presence(), displays: await q('SELECT d.id, d.name, d.lang, d.terminal_id, d.last_seen_at, t.code AS terminal_code FROM displays d LEFT JOIN terminals t ON t.id=d.terminal_id ORDER BY d.last_seen_at DESC NULLS LAST LIMIT 100'),
    printJobs: await q(`SELECT pj.status, COUNT(*)::int n FROM print_jobs pj WHERE created_at > now() - interval '1 day' GROUP BY 1`) });
});

// ---------- staff & roles ----------
adminRouter.get('/permissions', (_req, res) => res.json(PERMISSIONS));
adminRouter.get('/roles', requirePerm('staff.manage'), async (_req, res) => res.json(await q('SELECT * FROM roles ORDER BY id')));
adminRouter.post('/roles', requirePerm('staff.manage'), async (req, res) => {
  const b = parse(z.object({ id: z.number().optional(), key: z.string().regex(/^[a-z_]+$/), name: z.string(), permissions: z.array(z.string()), maxDiscountPct: z.number().min(0).max(100) }), req.body);
  const perms = b.permissions.filter((p) => (ALL_PERMISSIONS as string[]).includes(p));
  if (b.id) {
    const r = await one('SELECT key FROM roles WHERE id=$1', [b.id]);
    if (r?.key === 'owner') throw forbidden('ไม่สามารถแก้ไขบทบาท Owner');
    await pool.query('UPDATE roles SET name=$1, permissions=$2, max_discount_pct=$3 WHERE id=$4', [b.name, perms, b.maxDiscountPct, b.id]);
  } else await pool.query('INSERT INTO roles (key, name, permissions, max_discount_pct) VALUES ($1,$2,$3,$4)', [b.key, b.name, perms, b.maxDiscountPct]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'role.save', details: { ...b, permissions: perms } });
  res.json({ ok: true });
});
adminRouter.delete('/roles/:id', requirePerm('staff.manage'), async (req, res) => {
  const r = await one('SELECT is_system FROM roles WHERE id=$1', [String(req.params.id)]);
  if (r?.is_system) throw forbidden('ไม่สามารถลบบทบาทระบบ');
  await pool.query('DELETE FROM roles WHERE id=$1', [String(req.params.id)]);
  res.json({ ok: true });
});
adminRouter.get('/staff', requirePerm('staff.manage', 'reports.view'), async (_req, res) => {
  res.json(await q(`SELECT s.id, s.employee_code, s.name, s.role_id, r.name AS role_name, r.key AS role_key, s.branch_id, b.name AS branch_name, s.is_active, s.failed_attempts, s.locked_until, s.created_at
    FROM staff s JOIN roles r ON r.id=s.role_id LEFT JOIN branches b ON b.id=s.branch_id ORDER BY s.employee_code`));
});
adminRouter.post('/staff', requirePerm('staff.manage'), async (req, res) => {
  const b = parse(z.object({ id: z.number().optional(), employeeCode: z.string().min(2), name: z.string().min(1), roleId: z.number(), branchId: z.number().nullable().optional(), isActive: z.boolean().default(true), pin: z.string().regex(/^\d{4,6}$/, 'PIN 4–6 หลัก').optional() }), req.body);
  const role = await one('SELECT key FROM roles WHERE id=$1', [b.roleId]);
  if (role?.key === 'owner' && req.staff!.roleKey !== 'owner') throw forbidden('เฉพาะ Owner เท่านั้นที่กำหนดบทบาท Owner ได้');
  if (b.pin && /^(\d)\1+$/.test(b.pin)) throw bad('PIN ง่ายเกินไป (ตัวเลขซ้ำกันทั้งหมด)');
  if (b.id) {
    await pool.query('UPDATE staff SET employee_code=$1, name=$2, role_id=$3, branch_id=$4, is_active=$5 WHERE id=$6', [b.employeeCode, b.name, b.roleId, b.branchId ?? null, b.isActive, b.id]);
    if (b.pin) await pool.query('UPDATE staff SET pin_hash=$2, failed_attempts=0, locked_until=NULL WHERE id=$1', [b.id, await hashPin(b.pin)]);
    if (!b.isActive) await pool.query('UPDATE staff_sessions SET revoked=true WHERE staff_id=$1', [b.id]);
  } else {
    if (!b.pin) throw bad('กรุณากำหนด PIN');
    await pool.query('INSERT INTO staff (employee_code, name, role_id, branch_id, is_active, pin_hash) VALUES ($1,$2,$3,$4,$5,$6)', [b.employeeCode, b.name, b.roleId, b.branchId ?? null, b.isActive, await hashPin(b.pin)]);
  }
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: b.id ? 'staff.update' : 'staff.create', entity: 'staff', entityId: b.id ?? b.employeeCode, details: { ...b, pin: b.pin ? '***' : undefined } });
  res.json({ ok: true });
});
adminRouter.post('/staff/:id/unlock', requirePerm('staff.manage'), async (req, res) => {
  await pool.query('UPDATE staff SET failed_attempts=0, locked_until=NULL WHERE id=$1', [String(req.params.id)]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'staff.unlock', entity: 'staff', entityId: String(req.params.id) });
  res.json({ ok: true });
});

// ---------- audit log ----------
adminRouter.get('/audit', requirePerm('audit.view'), async (req, res) => {
  const term = String(req.query.q || '');
  res.json(await q(`SELECT a.*, ap.name AS approved_by_name FROM audit_logs a LEFT JOIN staff ap ON ap.id=a.approved_by
    WHERE ($1 = '' OR a.action ILIKE '%'||$1||'%' OR a.bill_no ILIKE '%'||$1||'%' OR a.staff_name ILIKE '%'||$1||'%' OR a.reason ILIKE '%'||$1||'%')
    ORDER BY a.created_at DESC LIMIT 500`, [term]));
});

// ---------- backup / restore (JSON snapshot of all tables) ----------
const BACKUP_TABLES = ['branches', 'terminals', 'roles', 'staff', 'settings', 'fonts', 'categories', 'brands', 'units', 'products', 'product_barcodes', 'stock_levels', 'stock_lots',
  'tiers', 'members', 'promotions', 'gift_cards', 'shifts', 'cash_movements', 'payment_intents', 'sales', 'sale_items', 'sale_payments', 'sale_discounts', 'gift_card_txns',
  'refunds', 'refund_items', 'coupons', 'coupon_events', 'points_ledger', 'stock_movements', 'stock_transfers', 'stock_transfer_items', 'stock_counts', 'stock_count_items',
  'suppliers', 'purchase_orders', 'purchase_order_items', 'goods_receipts', 'goods_receipt_items', 'supplier_invoices', 'purchase_returns', 'purchase_return_items',
  'print_jobs', 'displays', 'approvals', 'audit_logs'];

adminRouter.get('/backup', requirePerm('backup.manage'), async (req, res) => {
  const data: Record<string, any[]> = {};
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const t of BACKUP_TABLES) {
      const r = await c.query(`SELECT * FROM ${t}`);
      data[t] = r.rows.map((row) => {
        for (const k of Object.keys(row)) if (Buffer.isBuffer(row[k])) row[k] = { $bytea: row[k].toString('base64') };
        return row;
      });
    }
    await c.query('COMMIT');
  } finally { c.release(); }
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'backup.export', ip: req.ip });
  res.setHeader('Content-Disposition', `attachment; filename="ppmart-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json"`);
  res.json({ format: 'ppmart-backup', version: 1, createdAt: new Date().toISOString(), tables: data });
});

adminRouter.post('/restore', requirePerm('backup.manage'), async (req, res) => {
  if (req.staff!.roleKey !== 'owner') throw forbidden('เฉพาะ Owner เท่านั้นที่กู้คืนข้อมูลได้');
  const b = req.body;
  if (b?.format !== 'ppmart-backup' || !b.tables) throw bad('ไฟล์สำรองข้อมูลไม่ถูกต้อง');
  await tx(async (db) => {
    await db.query(`TRUNCATE ${[...BACKUP_TABLES, 'staff_sessions', 'member_sessions', 'member_otps', 'display_pairings'].join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of BACKUP_TABLES) {
      const cols = (await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1`, [t])).rows;
      const colTypes = new Map(cols.map((c) => [c.column_name, c.data_type]));
      for (const row of b.tables[t] || []) {
        const keys = Object.keys(row).filter((k) => colTypes.has(k));
        const vals = keys.map((k) => {
          const v = row[k];
          if (v && typeof v === 'object' && '$bytea' in v) return Buffer.from(v.$bytea, 'base64');
          if (colTypes.get(k) === 'jsonb' && v !== null) return JSON.stringify(v);
          return v;
        });
        await db.query(`INSERT INTO ${t} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
      }
      // reset serial sequences
      const seqs = (await db.query(`SELECT column_name, pg_get_serial_sequence($1, column_name) AS seq FROM information_schema.columns WHERE table_name=$1`, [t])).rows.filter((r) => r.seq);
      for (const s of seqs) await db.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX("${s.column_name}"),0) FROM ${t}), 1))`, [s.seq]);
    }
  });
  clearSettingsCache();
  await audit({ staffName: 'restore', action: 'backup.restore', ip: req.ip, details: { createdAt: b.createdAt } });
  res.json({ ok: true });
});
