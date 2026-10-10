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
  description: z.string().max(20000).nullable().optional(),
  online: z.boolean().optional().default(true),
  sizeChart: z.object({ columns: z.array(z.string().max(60)).max(12), rows: z.array(z.array(z.string().max(60)).max(12)).max(60), note: z.string().max(500).optional().nullable() }).nullable().optional(),
  barcodes: z.array(z.object({ barcode: z.string().min(1), packQty: z.number().positive().default(1), packPrice: money.nullable().optional() })).optional().default([]),
});

const LIST_SQL = `
  SELECT p.*, u.name AS unit_name, c.name AS category_name, b.name AS brand_name,
    COALESCE((SELECT json_agg(json_build_object('barcode', pb.barcode, 'packQty', pb.pack_qty, 'packPrice', pb.pack_price)) FROM product_barcodes pb WHERE pb.product_id=p.id), '[]') AS barcodes,
    (SELECT COALESCE(SUM(qty),0) FROM stock_levels sl WHERE sl.product_id=p.id AND ($1::int IS NULL OR sl.branch_id=$1)) AS stock,
    COALESCE((SELECT json_agg(json_build_object('branchId', b.id, 'branch', b.name, 'qty', COALESCE(sl.qty,0)) ORDER BY b.id)
      FROM branches b LEFT JOIN stock_levels sl ON sl.branch_id=b.id AND sl.product_id=p.id WHERE b.is_active), '[]') AS branch_stock,
    COALESCE((SELECT array_agg(pi.id ORDER BY pi.sort_order, pi.id) FROM product_images pi WHERE pi.product_id=p.id), '{}') AS image_ids,
    (SELECT COUNT(*) FROM products v WHERE v.parent_id=p.id AND v.is_active) AS variant_count
  FROM products p LEFT JOIN units u ON u.id=p.unit_id LEFT JOIN categories c ON c.id=p.category_id LEFT JOIN brands b ON b.id=p.brand_id`;

productsRouter.get('/', async (req, res) => {
  const branchId = req.query.branchId ? Number(req.query.branchId) : null;
  const term = String(req.query.q || '').trim();
  const rows = await q(`${LIST_SQL} WHERE ($2 = '' OR p.name ILIKE '%'||$2||'%' OR p.sku ILIKE '%'||$2||'%' OR EXISTS (SELECT 1 FROM product_barcodes z WHERE z.product_id=p.id AND z.barcode LIKE $2||'%'))
    AND ($3::int IS NULL OR p.category_id=$3) ORDER BY p.name LIMIT 2000`, [branchId, term, req.query.categoryId ? Number(req.query.categoryId) : null]);
  const canCost = req.staff!.roleKey === 'owner' || req.staff!.permissions.includes('reports.cost') || req.staff!.permissions.includes('products.manage');
  res.json(rows.map((r) => ({ ...productPublic(r), cost: canCost ? r.cost : undefined, branchStock: r.branch_stock })));
});

// ---------- product images (uploaded, unlimited, ordered; first = cover) ----------
async function syncCover(db: any, productId: number) {
  await db.query(`UPDATE products SET image_url=(SELECT '/api/shop/images/'||id FROM product_images WHERE product_id=$1 ORDER BY sort_order, id LIMIT 1), updated_at=now() WHERE id=$1`, [productId]);
}
productsRouter.get('/:id/images', async (req, res) => {
  res.json(await q('SELECT id, mime, width, height, sort_order FROM product_images WHERE product_id=$1 ORDER BY sort_order, id', [Number(req.params.id)]));
});
productsRouter.post('/:id/images', requirePerm('products.manage'), async (req, res) => {
  const b = parse(z.object({ dataBase64: z.string().min(10).max(8_000_000), mime: z.enum(['image/jpeg', 'image/png', 'image/webp']), width: z.number().int().optional(), height: z.number().int().optional() }), req.body);
  const data = Buffer.from(b.dataBase64, 'base64');
  const sig = data.subarray(0, 12);
  const okSig = b.mime === 'image/jpeg' ? sig[0] === 0xff && sig[1] === 0xd8 : b.mime === 'image/png' ? sig.subarray(1, 4).toString() === 'PNG' : sig.subarray(8, 12).toString() === 'WEBP';
  if (!okSig) throw bad('ไฟล์รูปภาพไม่ถูกต้อง');
  const id = Number(req.params.id);
  const r = await one(`INSERT INTO product_images (product_id, mime, data, width, height, sort_order)
    VALUES ($1,$2,$3,$4,$5, COALESCE((SELECT MAX(sort_order)+1 FROM product_images WHERE product_id=$1),0)) RETURNING id, sort_order`, [id, b.mime, data, b.width ?? null, b.height ?? null]);
  await syncCover(pool, id);
  broadcastStaff('catalog.changed', { productId: id });
  res.json(r);
});
productsRouter.put('/:id/images/order', requirePerm('products.manage'), async (req, res) => {
  const b = parse(z.object({ ids: z.array(z.number().int()).max(500) }), req.body);
  const id = Number(req.params.id);
  await tx(async (db) => {
    for (let i = 0; i < b.ids.length; i++) await db.query('UPDATE product_images SET sort_order=$3 WHERE id=$1 AND product_id=$2', [b.ids[i], id, i]);
    await syncCover(db, id);
  });
  broadcastStaff('catalog.changed', { productId: id });
  res.json({ ok: true });
});
productsRouter.delete('/:id/images/:imageId', requirePerm('products.manage'), async (req, res) => {
  const id = Number(req.params.id);
  await pool.query('DELETE FROM product_images WHERE id=$1 AND product_id=$2', [Number(req.params.imageId), id]);
  await syncCover(pool, id);
  broadcastStaff('catalog.changed', { productId: id });
  res.json({ ok: true });
});

// ---------- size variants: each size is a real product (own SKU, barcode, price, stock) ----------
productsRouter.get('/:id/variants', async (req, res) => {
  const branchId = req.query.branchId ? Number(req.query.branchId) : null;
  const rows = await q(`${LIST_SQL} WHERE p.parent_id=$2 ORDER BY p.variant_sort, p.id`, [branchId, Number(req.params.id)]);
  res.json(rows.map((r) => ({ ...productPublic(r), cost: r.cost, branchStock: r.branch_stock })));
});
productsRouter.put('/:id/variants', requirePerm('products.manage'), async (req, res) => {
  const b = parse(z.object({ variants: z.array(z.object({
    id: z.number().int().optional(), label: z.string().min(1).max(30), sku: z.string().min(1).max(60), barcode: z.string().max(60).optional().nullable(),
    price: z.number().int().nonnegative(), memberPrice: z.number().int().nonnegative().nullable().optional(), isActive: z.boolean().default(true),
  })).max(100) }), req.body);
  const parentId = Number(req.params.id);
  const result = await tx(async (db) => {
    const parent = (await db.query('SELECT * FROM products WHERE id=$1 AND parent_id IS NULL', [parentId])).rows[0];
    if (!parent) throw notFound('ไม่พบสินค้าหลัก');
    const keep: number[] = [];
    for (let i = 0; i < b.variants.length; i++) {
      const v = b.variants[i];
      const name = `${parent.name} (${v.label})`;
      let vid = v.id;
      if (vid) {
        const r = await db.query(`UPDATE products SET sku=$2, name=$3, name_en=$4, name_zh=$5, category_id=$6, brand_id=$7, unit_id=$8, price=$9, member_price=$10, cost=COALESCE(NULLIF(cost,0),$11),
            variant_label=$12, variant_sort=$13, is_active=$14, online=$15, vat_exempt=$16, updated_at=now() WHERE id=$1 AND parent_id=$17 RETURNING id`,
          [vid, v.sku, name, parent.name_en ? `${parent.name_en} (${v.label})` : null, parent.name_zh ? `${parent.name_zh} (${v.label})` : null, parent.category_id, parent.brand_id, parent.unit_id,
           v.price, v.memberPrice ?? null, parent.cost, v.label, i, v.isActive, parent.online, parent.vat_exempt, parentId]);
        if (!r.rowCount) throw bad('ข้อมูลไซส์ไม่ถูกต้อง');
      } else {
        vid = (await db.query(`INSERT INTO products (sku,name,name_en,name_zh,category_id,brand_id,unit_id,price,cost,member_price,min_stock,vat_exempt,online,parent_id,variant_label,variant_sort,is_active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
          [v.sku, name, parent.name_en ? `${parent.name_en} (${v.label})` : null, parent.name_zh ? `${parent.name_zh} (${v.label})` : null, parent.category_id, parent.brand_id, parent.unit_id,
           v.price, parent.cost, v.memberPrice ?? null, parent.min_stock, parent.vat_exempt, parent.online, parentId, v.label, i, v.isActive])).rows[0].id;
      }
      keep.push(vid!);
      if (v.barcode) {
        const taken = (await db.query('SELECT product_id FROM product_barcodes WHERE barcode=$1', [v.barcode])).rows[0];
        if (taken && taken.product_id !== vid) throw bad(`บาร์โค้ด ${v.barcode} ถูกใช้กับสินค้าอื่นแล้ว`, 'BARCODE_TAKEN');
        await db.query('DELETE FROM product_barcodes WHERE product_id=$1 AND pack_qty=1 AND barcode<>$2', [vid, v.barcode]);
        if (!taken) await db.query('INSERT INTO product_barcodes (barcode, product_id) VALUES ($1,$2)', [v.barcode, vid]);
      }
    }
    // sizes removed from the list: delete if never used, otherwise deactivate (history stays intact)
    const gone = (await db.query('SELECT id FROM products WHERE parent_id=$1 AND NOT (id = ANY($2))', [parentId, keep])).rows;
    for (const g of gone) {
      const used = (await db.query('SELECT 1 FROM sale_items WHERE product_id=$1 UNION SELECT 1 FROM online_order_items WHERE product_id=$1 UNION SELECT 1 FROM stock_movements WHERE product_id=$1 LIMIT 1', [g.id])).rowCount;
      if (used) await db.query('UPDATE products SET is_active=false, updated_at=now() WHERE id=$1', [g.id]);
      else await db.query('DELETE FROM products WHERE id=$1', [g.id]);
    }
    // a product with sizes is sold by size: the parent itself is not stock-tracked
    await db.query('UPDATE products SET track_stock=$2, updated_at=now() WHERE id=$1', [parentId, keep.length === 0]);
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'product.variants', entity: 'product', entityId: parentId, details: { sizes: b.variants.map((v) => v.label) } }, db);
    return { ids: keep };
  });
  broadcastStaff('catalog.changed', { productId: parentId });
  res.json(result);
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
  p.saleBlocked, p.blockReason ?? null, p.minStock, p.imageUrl ?? null, p.description ?? null, p.online, p.sizeChart ? JSON.stringify(p.sizeChart) : null];

productsRouter.post('/', requirePerm('products.manage'), async (req, res) => {
  const p = parse(productSchema, req.body);
  const id = await tx(async (db) => {
    const r = (await db.query(`INSERT INTO products (sku,name,name_en,name_zh,category_id,brand_id,unit_id,price,cost,member_price,wholesale_price,wholesale_min_qty,
      is_weighted,track_stock,vat_exempt,is_active,sale_blocked,block_reason,min_stock,image_url,description,online,size_chart) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING id`, cols(p))).rows[0];
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
      wholesale_min_qty=$12,is_weighted=$13,track_stock=$14,vat_exempt=$15,is_active=$16,sale_blocked=$17,block_reason=$18,min_stock=$19,
      image_url=COALESCE((SELECT '/api/shop/images/'||pi.id FROM product_images pi WHERE pi.product_id=$24 ORDER BY pi.sort_order, pi.id LIMIT 1), $20),
      description=$21,online=$22,size_chart=$23,updated_at=now() WHERE id=$24`, [...cols(p), id]);
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
