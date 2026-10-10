import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, tx } from '../db';
import { requireStaff, requirePerm } from '../auth';
import { parse, bad, notFound } from '../util';
import { productPublic } from '../services/catalog';
import { moveStock } from '../services/stock';
import { audit } from '../audit';
import { broadcastStaff } from '../realtime';

export const productsRouter = Router();
productsRouter.use(requireStaff);

const money = z.number().int().nonnegative();
const productSchema = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  nameEn: z.string().nullable().optional(),
  nameZh: z.string().nullable().optional(),
  categoryId: z.number().int().nullable().optional(),
  brandId: z.number().int().nullable().optional(),
  unitId: z.number().int().nullable().optional(),
  price: money,
  cost: money.optional().default(0),
  memberPrice: money.nullable().optional(),
  wholesalePrice: money.nullable().optional(),
  wholesaleMinQty: z.number().nullable().optional(),
  isWeighted: z.boolean().optional().default(false),
  trackStock: z.boolean().optional().default(true),
  vatExempt: z.boolean().optional().default(false),
  isActive: z.boolean().optional().default(true),
  saleBlocked: z.boolean().optional().default(false),
  blockReason: z.string().nullable().optional(),
  minStock: z.number().nonnegative().optional().default(0),
  imageUrl: z.string().nullable().optional(),
  barcodes: z.array(z.object({ barcode: z.string().min(1), packQty: z.number().positive().default(1), packPrice: money.nullable().optional() })).optional().default([]),
});

const LIST_SQL = `
  SELECT p.*, u.name AS unit_name, c.name AS category_name, b.name AS brand_name,
    COALESCE((SELECT json_agg(json_build_object('barcode', pb.barcode, 'packQty', pb.pack_qty, 'packPrice', pb.pack_price)) FROM product_barcodes pb WHERE pb.product_id=p.id), '[]') AS barcodes,
    (SELECT COALESCE(SUM(qty),0) FROM stock_levels sl WHERE sl.product_id=p.id AND ($1::int IS NULL OR sl.branch_id=$1)) AS stock,
    COALESCE((SELECT json_agg(json_build_object('branchId', b.id, 'branch', b.name, 'qty', COALESCE(sl.qty,0)) ORDER BY b.id)
      FROM branches b LEFT JOIN stock_levels sl ON sl.branch_id=b.id AND sl.product_id=p.id WHERE b.is_active), '[]') AS branch_stock
  FROM products p LEFT JOIN units u ON u.id=p.unit_id LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id`;

productsRouter.get('/', async (req, res) => {
  const branchId = req.query.branchId ? Number(req.query.branchId) : null;
  const term = String(req.query.q || '').trim();
  const rows = await q(`${LIST_SQL} WHERE ($2 = '' OR p.name ILIKE '%'||$2||'%' OR p.sku ILIKE '%'||$2||'%' OR EXISTS (SELECT 1 FROM product_barcodes z WHERE z.product_id=p.id AND z.barcode LIKE $2||'%'))
    AND ($3::int IS NULL OR p.category_id=$3) ORDER BY p.name LIMIT 2000`, [branchId, term, req.query.categoryId ? Number(req.query.categoryId) : null]);
  const canCost = req.staff!.roleKey === 'owner' || req.staff!.permissions.includes('reports.cost') || req.staff!.permissions.includes('products.manage');
  res.json(rows.map((r) => ({ ...productPublic(r), cost: canCost ? r.cost : undefined, branchStock: r.branch_stock })));
});

productsRouter.get('/:id', async (req, res) => {
  const r = await one(`${LIST_SQL} WHERE p.id=$2`, [null, Number(String(req.params.id))]);
  if (!r) throw notFound();
  res.json({ ...productPublic(r), cost: r.cost });
});

async function saveBarcodes(db: any, productId: number, barcodes: z.infer<typeof productSchema>['barcodes']) {
  await db.query('DELETE FROM product_barcodes WHERE product_id=$1', [productId]);
  for (const b of barcodes) {
    const taken = (await db.query('SELECT product_id FROM product_barcodes WHERE barcode=$1', [b.barcode])).rows[0];
    if (taken) throw bad(`บาร์โค้ด ${b.barcode} ถูกใช้กับสินค้าอื่นแล้ว`, 'BARCODE_TAKEN');
    await db.query('INSERT INTO product_barcodes (barcode, product_id, pack_qty, pack_price) VALUES ($1,$2,$3,$4)', [b.barcode, productId, b.packQty, b.packPrice ?? null]);
  }
}

const cols = (p: z.infer<typeof productSchema>) => [p.sku, p.name, p.nameEn ?? null, p.nameZh ?? null, p.categoryId ?? null, p.brandId ?? null, p.unitId ?? null,
  p.price, p.cost, p.memberPrice ?? null, p.wholesalePrice ?? null, p.wholesaleMinQty ?? null, p.isWeighted, p.trackStock, p.vatExempt, p.isActive,
  p.saleBlocked, p.blockReason ?? null, p.minStock, p.imageUrl ?? null];

productsRouter.post('/', requirePerm('products.manage'), async (req, res) => {
  const p = parse(productSchema, req.body);
  const id = await tx(async (db) => {
    const r = (await db.query(`INSERT INTO products (sku,name,name_en,name_zh,category_id,brand_id,unit_id,price,cost,member_price,wholesale_price,wholesale_min_qty,
      is_weighted,track_stock,vat_exempt,is_active,sale_blocked,block_reason,min_stock,image_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`, cols(p))).rows[0];
    await saveBarcodes(db, r.id, p.barcodes);
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'product.create', entity: 'product', entityId: r.id, details: { sku: p.sku, price: p.price } }, db);
    return r.id;
  });
  broadcastStaff('catalog.changed', { productId: id });
  res.json({ id });
});

productsRouter.put('/:id', requirePerm('products.manage'), async (req, res) => {
  const p = parse(productSchema, req.body);
  const id = Number(String(req.params.id));
  await tx(async (db) => {
    const before = (await db.query('SELECT price, cost, member_price, sale_blocked FROM products WHERE id=$1', [id])).rows[0];
    if (!before) throw notFound();
    await db.query(`UPDATE products SET sku=$1,name=$2,name_en=$3,name_zh=$4,category_id=$5,brand_id=$6,unit_id=$7,price=$8,cost=$9,member_price=$10,wholesale_price=$11,
      wholesale_min_qty=$12,is_weighted=$13,track_stock=$14,vat_exempt=$15,is_active=$16,sale_blocked=$17,block_reason=$18,min_stock=$19,image_url=$20,updated_at=now() WHERE id=$21`, [...cols(p), id]);
    await saveBarcodes(db, id, p.barcodes);
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'product.update', entity: 'product', entityId: id, details: { before, after: { price: p.price, cost: p.cost, memberPrice: p.memberPrice, saleBlocked: p.saleBlocked } } }, db);
  });
  broadcastStaff('catalog.changed', { productId: id });
  res.json({ id });
});

productsRouter.delete('/:id', requirePerm('products.manage'), async (req, res) => {
  const id = Number(String(req.params.id));
  const used = await one('SELECT 1 FROM sale_items WHERE product_id=$1 LIMIT 1', [id]);
  if (used) {
    await pool.query('UPDATE products SET is_active=false, updated_at=now() WHERE id=$1', [id]);
  } else {
    await pool.query('DELETE FROM stock_movements WHERE product_id=$1', [id]);
    await pool.query('DELETE FROM products WHERE id=$1', [id]);
  }
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: used ? 'product.deactivate' : 'product.delete', entity: 'product', entityId: id });
  broadcastStaff('catalog.changed', { productId: id });
  res.json({ ok: true, deactivated: !!used });
});

/** Bulk import (rows parsed from Excel/CSV in the browser). Upsert by SKU. */
productsRouter.post('/import', requirePerm('products.manage'), async (req, res) => {
  const b = parse(z.object({ rows: z.array(z.record(z.string(), z.any())).max(20000), branchId: z.number().int().optional() }), req.body);
  const report = { created: 0, updated: 0, errors: [] as { row: number; error: string }[] };
  const lookups = async (db: any, table: string, name?: string) => {
    if (!name) return null;
    const ex = (await db.query(`SELECT id FROM ${table} WHERE name=$1`, [name])).rows[0];
    if (ex) return ex.id;
    return (await db.query(`INSERT INTO ${table} (name) VALUES ($1) RETURNING id`, [name])).rows[0].id;
  };
  const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(String(v).replace(/,/g, '')));
  for (let i = 0; i < b.rows.length; i++) {
    const r = b.rows[i] as Record<string, any>;
    try {
      await tx(async (db) => {
        const sku = String(r.sku ?? r.SKU ?? '').trim();
        const name = String(r.name ?? r['ชื่อสินค้า'] ?? '').trim();
        if (!sku || !name) throw new Error('ต้องมี sku และ name');
        const price = num(r.price ?? r['ราคา']);
        if (price == null || isNaN(price)) throw new Error('ราคาไม่ถูกต้อง');
        const catId = await lookups(db, 'categories', r.category || undefined);
        const brandId = await lookups(db, 'brands', r.brand || undefined);
        const unitId = await lookups(db, 'units', r.unit || undefined);
        const vals = [sku, name, r.name_en || null, r.name_zh || null, catId, brandId, unitId, Math.round(price * 100), Math.round((num(r.cost) ?? 0) * 100),
          num(r.member_price) != null ? Math.round(num(r.member_price)! * 100) : null, num(r.wholesale_price) != null ? Math.round(num(r.wholesale_price)! * 100) : null,
          num(r.wholesale_min_qty), String(r.is_weighted ?? '').toLowerCase() === 'true' || r.is_weighted === 1, num(r.min_stock) ?? 0];
        const ex = (await db.query('SELECT id FROM products WHERE sku=$1', [sku])).rows[0];
        let id: number;
        if (ex) {
          id = ex.id;
          await db.query(`UPDATE products SET sku=$1,name=$2,name_en=$3,name_zh=$4,category_id=$5,brand_id=$6,unit_id=$7,price=$8,cost=$9,member_price=$10,wholesale_price=$11,wholesale_min_qty=$12,is_weighted=$13,min_stock=$14,updated_at=now() WHERE id=$15`, [...vals, id]);
          report.updated++;
        } else {
          id = (await db.query(`INSERT INTO products (sku,name,name_en,name_zh,category_id,brand_id,unit_id,price,cost,member_price,wholesale_price,wholesale_min_qty,is_weighted,min_stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`, vals)).rows[0].id;
          report.created++;
        }
        const codes = String(r.barcodes ?? r.barcode ?? '').split(/[|;,\s]+/).filter(Boolean);
        for (const code of codes) {
          const t = (await db.query('SELECT product_id FROM product_barcodes WHERE barcode=$1', [code])).rows[0];
          if (t && t.product_id !== id) throw new Error(`บาร์โค้ด ${code} ซ้ำกับสินค้าอื่น`);
          if (!t) await db.query('INSERT INTO product_barcodes (barcode, product_id) VALUES ($1,$2)', [code, id]);
        }
        const stock = num(r.stock);
        if (stock != null && b.branchId) {
          const cur = (await db.query('SELECT qty FROM stock_levels WHERE branch_id=$1 AND product_id=$2', [b.branchId, id])).rows[0];
          const diff = stock - Number(cur?.qty ?? 0);
          if (diff) await moveStock(db, { branchId: b.branchId, productId: id, qty: diff, type: 'adjust', reason: 'นำเข้าจากไฟล์', staffId: req.staff!.id, allowNegative: true, lot: diff > 0 ? { lotNo: r.lot_no || null, expiryDate: r.expiry_date || null } : undefined });
        }
      });
    } catch (e: any) {
      report.errors.push({ row: i + 2, error: e.message });
    }
  }
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'product.import', details: { created: report.created, updated: report.updated, errors: report.errors.length } });
  broadcastStaff('catalog.changed', {});
  res.json(report);
});

// ---- categories / brands / units ----
for (const [path, table, extra] of [['categories', 'categories', ['name_en', 'name_zh', 'parent_id']], ['brands', 'brands', []], ['units', 'units', ['name_en']]] as const) {
  productsRouter.get(`/meta/${path}`, async (_req, res) => res.json(await q(`SELECT * FROM ${table} ORDER BY name`)));
  productsRouter.post(`/meta/${path}`, requirePerm('products.manage'), async (req, res) => {
    const b = parse(z.object({ id: z.number().optional(), name: z.string().min(1) }).passthrough(), req.body);
    const fields = ['name', ...extra];
    const vals = fields.map((f) => (b as any)[f.replace(/_(\w)/g, (_, c) => c.toUpperCase())] ?? (b as any)[f] ?? null);
    if (b.id) await pool.query(`UPDATE ${table} SET ${fields.map((f, i) => `${f}=$${i + 1}`).join(',')} WHERE id=$${fields.length + 1}`, [...vals, b.id]);
    else await pool.query(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map((_, i) => '$' + (i + 1)).join(',')})`, vals);
    res.json({ ok: true });
  });
  productsRouter.delete(`/meta/${path}/:id`, requirePerm('products.manage'), async (req, res) => {
    await pool.query(`DELETE FROM ${table} WHERE id=$1`, [String(req.params.id)]);
    res.json({ ok: true });
  });
}
