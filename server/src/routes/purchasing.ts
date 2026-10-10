import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, tx } from '../db';
import { requireStaff, requirePerm } from '../auth';
import { parse, bad, conflict, notFound, docNo } from '../util';
import { moveStock } from '../services/stock';
import { audit } from '../audit';
import { broadcastStaff } from '../realtime';

export const purchasingRouter = Router();
purchasingRouter.use(requireStaff, requirePerm('purchasing.manage'));

// ---- suppliers ----
const supplierSchema = z.object({ code: z.string().min(1), name: z.string().min(1), contactName: z.string().nullable().optional(), phone: z.string().nullable().optional(), email: z.string().nullable().optional(), address: z.string().nullable().optional(), taxId: z.string().nullable().optional(), leadTimeDays: z.number().int().nonnegative().default(3), paymentTermsDays: z.number().int().nonnegative().default(30), isActive: z.boolean().default(true) });
purchasingRouter.get('/suppliers', async (_req, res) => res.json(await q('SELECT * FROM suppliers ORDER BY name')));
purchasingRouter.post('/suppliers', async (req, res) => {
  const s = parse(supplierSchema, req.body);
  res.json(await one(`INSERT INTO suppliers (code,name,contact_name,phone,email,address,tax_id,lead_time_days,payment_terms_days,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [s.code, s.name, s.contactName ?? null, s.phone ?? null, s.email ?? null, s.address ?? null, s.taxId ?? null, s.leadTimeDays, s.paymentTermsDays, s.isActive]));
});
purchasingRouter.put('/suppliers/:id', async (req, res) => {
  const s = parse(supplierSchema, req.body);
  await pool.query(`UPDATE suppliers SET code=$1,name=$2,contact_name=$3,phone=$4,email=$5,address=$6,tax_id=$7,lead_time_days=$8,payment_terms_days=$9,is_active=$10 WHERE id=$11`,
    [s.code, s.name, s.contactName ?? null, s.phone ?? null, s.email ?? null, s.address ?? null, s.taxId ?? null, s.leadTimeDays, s.paymentTermsDays, s.isActive, String(req.params.id)]);
  res.json({ ok: true });
});

// ---- purchase orders ----
const poSchema = z.object({ supplierId: z.number(), branchId: z.number(), expectedDate: z.string().nullable().optional(), note: z.string().nullable().optional(), status: z.enum(['draft', 'ordered']).default('draft'), items: z.array(z.object({ productId: z.number(), qty: z.number().positive(), unitCost: z.number().int().nonnegative() })).min(1) });

purchasingRouter.get('/orders', async (_req, res) => {
  res.json(await q(`SELECT po.*, s.name AS supplier_name, b.name AS branch_name, st.name AS created_by_name FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id
    JOIN branches b ON b.id=po.branch_id LEFT JOIN staff st ON st.id=po.created_by ORDER BY po.created_at DESC LIMIT 300`));
});
purchasingRouter.get('/orders/:id', async (req, res) => {
  const po = await one(`SELECT po.*, s.name AS supplier_name, b.name AS branch_name FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN branches b ON b.id=po.branch_id WHERE po.id=$1`, [String(req.params.id)]);
  if (!po) throw notFound();
  const items = await q(`SELECT i.*, p.name, p.sku, p.cost AS current_cost FROM purchase_order_items i JOIN products p ON p.id=i.product_id WHERE po_id=$1 ORDER BY i.id`, [po.id]);
  const receipts = await q(`SELECT * FROM goods_receipts WHERE po_id=$1 ORDER BY created_at`, [po.id]);
  res.json({ ...po, items, receipts });
});
purchasingRouter.post('/orders', async (req, res) => {
  const b = parse(poSchema, req.body);
  const id = await tx(async (db) => {
    const total = b.items.reduce((a, i) => a + Math.round(i.qty * i.unitCost), 0);
    const po = (await db.query(`INSERT INTO purchase_orders (po_no, supplier_id, branch_id, expected_date, note, status, total, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [docNo('PO'), b.supplierId, b.branchId, b.expectedDate || null, b.note ?? null, b.status, total, req.staff!.id])).rows[0];
    for (const i of b.items) await db.query('INSERT INTO purchase_order_items (po_id, product_id, qty, unit_cost) VALUES ($1,$2,$3,$4)', [po.id, i.productId, i.qty, i.unitCost]);
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'po.create', entity: 'purchase_order', entityId: po.id, details: { total } }, db);
    return po.id;
  });
  res.json({ id });
});
purchasingRouter.post('/orders/:id/status', async (req, res) => {
  const b = parse(z.object({ status: z.enum(['ordered', 'cancelled']) }), req.body);
  const r = await one(`UPDATE purchase_orders SET status=$2 WHERE id=$1 AND status IN ('draft','ordered') RETURNING id`, [String(req.params.id), b.status]);
  if (!r) throw conflict('ไม่สามารถเปลี่ยนสถานะได้');
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'po.' + b.status, entity: 'purchase_order', entityId: String(req.params.id) });
  res.json({ ok: true });
});

// ---- goods receiving (partial receipts supported) ----
purchasingRouter.post('/receipts', async (req, res) => {
  const b = parse(z.object({
    poId: z.number().nullable().optional(), supplierId: z.number(), branchId: z.number(), invoiceNo: z.string().nullable().optional(), note: z.string().nullable().optional(),
    updateCost: z.boolean().default(true),
    items: z.array(z.object({ poItemId: z.number().nullable().optional(), productId: z.number(), qty: z.number().positive(), unitCost: z.number().int().nonnegative(), lotNo: z.string().nullable().optional(), expiryDate: z.string().nullable().optional() })).min(1),
    invoice: z.object({ amount: z.number().int(), dueDate: z.string().nullable().optional() }).optional(),
  }), req.body);
  const result = await tx(async (db) => {
    let po: any = null;
    if (b.poId) {
      po = (await db.query('SELECT * FROM purchase_orders WHERE id=$1 FOR UPDATE', [b.poId])).rows[0];
      if (!po || !['ordered', 'partial', 'draft'].includes(po.status)) throw conflict('ใบสั่งซื้อนี้ไม่สามารถรับสินค้าได้');
    }
    const total = b.items.reduce((a, i) => a + Math.round(i.qty * i.unitCost), 0);
    const grn = (await db.query(`INSERT INTO goods_receipts (grn_no, po_id, supplier_id, branch_id, invoice_no, note, total, received_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [docNo('GR'), b.poId ?? null, b.supplierId, b.branchId, b.invoiceNo ?? null, b.note ?? null, total, req.staff!.id])).rows[0];
    const costWarnings: any[] = [];
    for (const i of [...b.items].sort((x, y) => x.productId - y.productId)) {
      if (i.poItemId) {
        const pi = (await db.query('SELECT * FROM purchase_order_items WHERE id=$1 AND po_id=$2 FOR UPDATE', [i.poItemId, b.poId])).rows[0];
        if (!pi) throw bad('รายการไม่อยู่ในใบสั่งซื้อ');
        if (Number(pi.received_qty) + i.qty > Number(pi.qty) * 1.1) throw bad(`รับเกินจำนวนที่สั่ง (สั่ง ${pi.qty}, รับแล้ว ${pi.received_qty})`, 'OVER_RECEIVE');
        if (Number(pi.unit_cost) !== i.unitCost) costWarnings.push({ productId: i.productId, poCost: pi.unit_cost, invoiceCost: i.unitCost });
        await db.query('UPDATE purchase_order_items SET received_qty = received_qty + $2 WHERE id=$1', [pi.id, i.qty]);
      }
      const m = await moveStock(db, { branchId: b.branchId, productId: i.productId, qty: i.qty, type: 'receive', refType: 'grn', refId: grn.id, staffId: req.staff!.id, lot: { lotNo: i.lotNo, expiryDate: i.expiryDate, cost: i.unitCost } });
      await db.query(`INSERT INTO goods_receipt_items (grn_id, po_item_id, product_id, qty, unit_cost, lot_no, expiry_date, lot_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [grn.id, i.poItemId ?? null, i.productId, i.qty, i.unitCost, i.lotNo ?? null, i.expiryDate || null, m.lotIds[0] ?? null]);
      if (b.updateCost) {
        // moving average cost
        const p = (await db.query('SELECT cost FROM products WHERE id=$1 FOR UPDATE', [i.productId])).rows[0];
        const before = Math.max(0, m.balance - i.qty);
        const avg = before + i.qty > 0 ? Math.round((Number(p.cost) * before + i.unitCost * i.qty) / (before + i.qty)) : i.unitCost;
        await db.query('UPDATE products SET cost=$2, updated_at=now() WHERE id=$1', [i.productId, avg]);
      }
    }
    if (po) {
      const st = (await db.query('SELECT bool_and(received_qty >= qty) AS done FROM purchase_order_items WHERE po_id=$1', [po.id])).rows[0];
      await db.query('UPDATE purchase_orders SET status=$2 WHERE id=$1', [po.id, st.done ? 'received' : 'partial']);
    }
    if (b.invoiceNo && b.invoice) {
      await db.query(`INSERT INTO supplier_invoices (supplier_id, invoice_no, grn_id, amount, due_date) VALUES ($1,$2,$3,$4,$5)`, [b.supplierId, b.invoiceNo, grn.id, b.invoice.amount, b.invoice.dueDate || null]);
    }
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'grn.create', entity: 'goods_receipt', entityId: grn.id, branchId: b.branchId, details: { total, costWarnings } }, db);
    return { id: grn.id, grnNo: grn.grn_no, costWarnings };
  });
  broadcastStaff('stock.changed', { branchId: b.branchId });
  res.json(result);
});
purchasingRouter.get('/receipts', async (_req, res) => {
  res.json(await q(`SELECT g.*, s.name AS supplier_name, b.name AS branch_name, po.po_no, st.name AS received_by_name,
    (SELECT json_agg(json_build_object('name',p.name,'qty',i.qty,'unitCost',i.unit_cost,'lotNo',i.lot_no,'expiryDate',i.expiry_date)) FROM goods_receipt_items i JOIN products p ON p.id=i.product_id WHERE i.grn_id=g.id) AS items
    FROM goods_receipts g JOIN suppliers s ON s.id=g.supplier_id JOIN branches b ON b.id=g.branch_id LEFT JOIN purchase_orders po ON po.id=g.po_id LEFT JOIN staff st ON st.id=g.received_by ORDER BY g.created_at DESC LIMIT 300`));
});

// ---- supplier invoices ----
purchasingRouter.get('/invoices', async (_req, res) => {
  res.json(await q(`SELECT i.*, s.name AS supplier_name, g.grn_no FROM supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id LEFT JOIN goods_receipts g ON g.id=i.grn_id ORDER BY i.invoice_date DESC LIMIT 300`));
});
purchasingRouter.post('/invoices', async (req, res) => {
  const b = parse(z.object({ supplierId: z.number(), invoiceNo: z.string(), grnId: z.number().nullable().optional(), amount: z.number().int(), invoiceDate: z.string().optional(), dueDate: z.string().nullable().optional() }), req.body);
  res.json(await one(`INSERT INTO supplier_invoices (supplier_id, invoice_no, grn_id, amount, invoice_date, due_date) VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6) RETURNING *`,
    [b.supplierId, b.invoiceNo, b.grnId ?? null, b.amount, b.invoiceDate ?? null, b.dueDate || null]));
});
purchasingRouter.post('/invoices/:id/pay', async (req, res) => {
  await pool.query(`UPDATE supplier_invoices SET status='paid', paid_at=now() WHERE id=$1`, [String(req.params.id)]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'supplier_invoice.paid', entity: 'supplier_invoice', entityId: String(req.params.id) });
  res.json({ ok: true });
});

// ---- purchase returns ----
purchasingRouter.get('/returns', async (_req, res) => {
  res.json(await q(`SELECT r.*, s.name AS supplier_name, b.name AS branch_name FROM purchase_returns r JOIN suppliers s ON s.id=r.supplier_id JOIN branches b ON b.id=r.branch_id ORDER BY r.created_at DESC LIMIT 300`));
});
purchasingRouter.post('/returns', async (req, res) => {
  const b = parse(z.object({ supplierId: z.number(), branchId: z.number(), grnId: z.number().nullable().optional(), reason: z.string().min(2), items: z.array(z.object({ productId: z.number(), qty: z.number().positive(), unitCost: z.number().int().nonnegative() })).min(1) }), req.body);
  const r = await tx(async (db) => {
    const total = b.items.reduce((a, i) => a + Math.round(i.qty * i.unitCost), 0);
    const pr = (await db.query(`INSERT INTO purchase_returns (return_no, supplier_id, branch_id, grn_id, reason, total, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [docNo('RT'), b.supplierId, b.branchId, b.grnId ?? null, b.reason, total, req.staff!.id])).rows[0];
    for (const i of [...b.items].sort((x, y) => x.productId - y.productId)) {
      await db.query('INSERT INTO purchase_return_items (return_id, product_id, qty, unit_cost) VALUES ($1,$2,$3,$4)', [pr.id, i.productId, i.qty, i.unitCost]);
      await moveStock(db, { branchId: b.branchId, productId: i.productId, qty: -i.qty, type: 'purchase_return', refType: 'purchase_return', refId: pr.id, reason: b.reason, staffId: req.staff!.id });
    }
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'purchase_return.create', entity: 'purchase_return', entityId: pr.id, reason: b.reason, details: { total } }, db);
    return pr;
  });
  res.json(r);
});

/**
 * Reorder suggestion: avg daily sales over N days * (lead time + cover days) + min stock - on hand - on order.
 */
purchasingRouter.get('/suggestions', async (req, res) => {
  const branchId = Number(req.query.branchId);
  const days = Number(req.query.days || 30);
  const cover = Number(req.query.coverDays || 7);
  const supplierId = req.query.supplierId ? Number(req.query.supplierId) : null;
  const lead = supplierId ? (await one('SELECT lead_time_days FROM suppliers WHERE id=$1', [supplierId]))?.lead_time_days ?? 3 : 3;
  const rows = await q(`
    WITH sold AS (
      SELECT si.product_id, SUM((si.qty - si.refunded_qty) * si.pack_qty) AS qty FROM sale_items si JOIN sales s ON s.id=si.sale_id
      WHERE s.branch_id=$1 AND s.created_at > now() - ($2 || ' days')::interval AND s.status <> 'voided' GROUP BY si.product_id
    ), onorder AS (
      SELECT i.product_id, SUM(i.qty - i.received_qty) AS qty FROM purchase_order_items i JOIN purchase_orders po ON po.id=i.po_id
      WHERE po.branch_id=$1 AND po.status IN ('ordered','partial') GROUP BY i.product_id
    ), last_cost AS (
      SELECT DISTINCT ON (product_id) product_id, unit_cost FROM goods_receipt_items ORDER BY product_id, id DESC
    )
    SELECT p.id AS product_id, p.sku, p.name, p.min_stock, p.cost, COALESCE(sl.qty,0) AS on_hand, COALESCE(sold.qty,0) AS sold, COALESCE(onorder.qty,0) AS on_order,
      ROUND(COALESCE(sold.qty,0) / $2::numeric, 3) AS avg_daily, COALESCE(lc.unit_cost, p.cost) AS last_cost
    FROM products p LEFT JOIN stock_levels sl ON sl.product_id=p.id AND sl.branch_id=$1 LEFT JOIN sold ON sold.product_id=p.id
    LEFT JOIN onorder ON onorder.product_id=p.id LEFT JOIN last_cost lc ON lc.product_id=p.id
    WHERE p.is_active AND p.track_stock`, [branchId, String(days)]);
  const out = rows.map((r) => {
    const target = Number(r.avg_daily) * (lead + cover) + Number(r.min_stock);
    const suggest = Math.ceil(Math.max(0, target - Number(r.on_hand) - Number(r.on_order)));
    return { ...r, leadTimeDays: lead, coverDays: cover, target: Math.round(target * 100) / 100, suggestedQty: suggest };
  }).filter((r) => r.suggestedQty > 0).sort((a, b) => b.suggestedQty * b.last_cost - a.suggestedQty * a.last_cost);
  res.json(out);
});
