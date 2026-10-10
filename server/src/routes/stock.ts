import { Router } from 'express';
import { z } from 'zod';
import { q, one, tx } from '../db';
import { requireStaff, requirePerm } from '../auth';
import { parse, bad, conflict, notFound, docNo } from '../util';
import { moveStock } from '../services/stock';
import { audit } from '../audit';
import { broadcastStaff } from '../realtime';

export const stockRouter = Router();
stockRouter.use(requireStaff);

stockRouter.get('/levels', requirePerm('stock.view', 'stock.adjust'), async (req, res) => {
  const branchId = Number(req.query.branchId);
  res.json(await q(`SELECT p.id AS product_id, p.sku, p.name, p.min_stock, COALESCE(sl.qty,0) AS qty, u.name AS unit_name,
      (SELECT MIN(expiry_date) FROM stock_lots l WHERE l.product_id=p.id AND l.branch_id=$1 AND l.qty>0) AS next_expiry
    FROM products p LEFT JOIN stock_levels sl ON sl.product_id=p.id AND sl.branch_id=$1 LEFT JOIN units u ON u.id=p.unit_id
    WHERE p.track_stock AND p.is_active ORDER BY p.name`, [branchId]));
});

stockRouter.get('/low', requirePerm('stock.view', 'stock.adjust', 'purchasing.manage'), async (req, res) => {
  res.json(await q(`SELECT p.id AS product_id, p.sku, p.name, p.min_stock, b.id AS branch_id, b.name AS branch_name, COALESCE(sl.qty,0) AS qty
    FROM products p CROSS JOIN branches b LEFT JOIN stock_levels sl ON sl.product_id=p.id AND sl.branch_id=b.id
    WHERE p.track_stock AND p.is_active AND b.is_active AND p.min_stock > 0 AND COALESCE(sl.qty,0) <= p.min_stock
      AND ($1::int IS NULL OR b.id=$1) ORDER BY (COALESCE(sl.qty,0) - p.min_stock)`, [req.query.branchId ? Number(req.query.branchId) : null]));
});

stockRouter.get('/expiring', requirePerm('stock.view', 'stock.adjust', 'reports.view'), async (req, res) => {
  const days = Number(req.query.days || 30);
  res.json(await q(`SELECT l.*, p.name, p.sku, b.name AS branch_name, (l.expiry_date - CURRENT_DATE) AS days_left
    FROM stock_lots l JOIN products p ON p.id=l.product_id JOIN branches b ON b.id=l.branch_id
    WHERE l.qty > 0 AND l.expiry_date IS NOT NULL AND l.expiry_date <= CURRENT_DATE + $1::int
      AND ($2::int IS NULL OR l.branch_id=$2) ORDER BY l.expiry_date`, [days, req.query.branchId ? Number(req.query.branchId) : null]));
});

stockRouter.get('/lots/:productId', requirePerm('stock.view', 'stock.adjust'), async (req, res) => {
  res.json(await q(`SELECT l.*, b.name AS branch_name FROM stock_lots l JOIN branches b ON b.id=l.branch_id WHERE product_id=$1 AND qty <> 0 ORDER BY expiry_date NULLS LAST`, [String(req.params.productId)]));
});

stockRouter.get('/movements', requirePerm('stock.view', 'stock.adjust'), async (req, res) => {
  res.json(await q(`SELECT m.*, p.name, p.sku, b.name AS branch_name, s.name AS staff_name, l.lot_no, l.expiry_date
    FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN branches b ON b.id=m.branch_id LEFT JOIN staff s ON s.id=m.staff_id LEFT JOIN stock_lots l ON l.id=m.lot_id
    WHERE ($1::int IS NULL OR m.product_id=$1) AND ($2::int IS NULL OR m.branch_id=$2) AND ($3::text IS NULL OR m.type=$3)
    ORDER BY m.created_at DESC, m.id DESC LIMIT 500`, [req.query.productId ? Number(req.query.productId) : null, req.query.branchId ? Number(req.query.branchId) : null, req.query.type || null]));
});

stockRouter.post('/adjust', requirePerm('stock.adjust'), async (req, res) => {
  const b = parse(z.object({
    branchId: z.number().int(), productId: z.number().int(), qty: z.number().refine((v) => v !== 0, 'จำนวนต้องไม่เป็น 0'),
    reason: z.string().min(2, 'กรุณาระบุเหตุผล'), lotNo: z.string().optional(), expiryDate: z.string().optional(), lotId: z.number().optional(),
  }), req.body);
  const r = await tx(async (db) => {
    const m = await moveStock(db, {
      branchId: b.branchId, productId: b.productId, qty: b.qty, type: 'adjust', reason: b.reason, staffId: req.staff!.id, allowNegative: false,
      lot: b.qty > 0 && !b.lotId ? { lotNo: b.lotNo, expiryDate: b.expiryDate } : undefined, lotId: b.qty > 0 ? b.lotId : undefined,
    });
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'stock.adjust', entity: 'product', entityId: b.productId, reason: b.reason, branchId: b.branchId, details: { qty: b.qty, balance: m.balance } }, db);
    return m;
  });
  broadcastStaff('stock.changed', { productIds: [b.productId], branchId: b.branchId });
  res.json(r);
});

// ---- transfers ----
stockRouter.get('/transfers', requirePerm('stock.transfer', 'stock.view'), async (_req, res) => {
  res.json(await q(`SELECT t.*, fb.name AS from_name, tb.name AS to_name, cs.name AS created_by_name,
    (SELECT json_agg(json_build_object('id',i.id,'productId',i.product_id,'name',p.name,'qty',i.qty,'receivedQty',i.received_qty)) FROM stock_transfer_items i JOIN products p ON p.id=i.product_id WHERE i.transfer_id=t.id) AS items
    FROM stock_transfers t JOIN branches fb ON fb.id=t.from_branch_id JOIN branches tb ON tb.id=t.to_branch_id LEFT JOIN staff cs ON cs.id=t.created_by ORDER BY t.created_at DESC LIMIT 200`));
});

stockRouter.post('/transfers', requirePerm('stock.transfer'), async (req, res) => {
  const b = parse(z.object({ fromBranchId: z.number(), toBranchId: z.number(), note: z.string().optional(), items: z.array(z.object({ productId: z.number(), qty: z.number().positive() })).min(1) }), req.body);
  if (b.fromBranchId === b.toBranchId) throw bad('สาขาต้นทางและปลายทางต้องต่างกัน');
  const id = await tx(async (db) => {
    const t = (await db.query(`INSERT INTO stock_transfers (transfer_no, from_branch_id, to_branch_id, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [docNo('TR'), b.fromBranchId, b.toBranchId, b.note ?? null, req.staff!.id])).rows[0];
    for (const it of [...b.items].sort((x, y) => x.productId - y.productId)) {
      await moveStock(db, { branchId: b.fromBranchId, productId: it.productId, qty: -it.qty, type: 'transfer_out', refType: 'transfer', refId: t.id, staffId: req.staff!.id });
      // remember which lots (lot no / expiry) left the source branch so they arrive with the same expiry
      const lots = (await db.query(`SELECT -m.qty AS qty, l.lot_no, l.expiry_date, l.cost FROM stock_movements m LEFT JOIN stock_lots l ON l.id=m.lot_id
        WHERE m.ref_type='transfer' AND m.ref_id=$1 AND m.product_id=$2 AND m.type='transfer_out'`, [String(t.id), it.productId])).rows;
      await db.query('INSERT INTO stock_transfer_items (transfer_id, product_id, qty, lots) VALUES ($1,$2,$3,$4)', [t.id, it.productId, it.qty, JSON.stringify(lots)]);
    }
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'stock.transfer_out', entity: 'transfer', entityId: t.id, branchId: b.fromBranchId, details: b }, db);
    return t.id;
  });
  res.json({ id });
});

stockRouter.post('/transfers/:id/receive', requirePerm('stock.transfer'), async (req, res) => {
  const b = parse(z.object({ items: z.array(z.object({ id: z.number(), receivedQty: z.number().nonnegative() })).optional() }), req.body ?? {});
  await tx(async (db) => {
    const t = (await db.query('SELECT * FROM stock_transfers WHERE id=$1 FOR UPDATE', [String(req.params.id)])).rows[0];
    if (!t) throw notFound();
    if (t.status !== 'in_transit') throw conflict('ใบโอนนี้ถูกรับแล้ว');
    const items = (await db.query('SELECT * FROM stock_transfer_items WHERE transfer_id=$1 ORDER BY product_id', [t.id])).rows;
    for (const it of items) {
      const rq = b.items?.find((x) => x.id === it.id)?.receivedQty ?? Number(it.qty);
      await db.query('UPDATE stock_transfer_items SET received_qty=$2 WHERE id=$1', [it.id, rq]);
      let left = rq;
      for (const l of (it.lots as any[]) || []) {
        if (left <= 0) break;
        const take = Math.min(left, Number(l.qty));
        await moveStock(db, { branchId: t.to_branch_id, productId: it.product_id, qty: take, type: 'transfer_in', refType: 'transfer', refId: t.id, staffId: req.staff!.id, lot: { lotNo: l.lot_no, expiryDate: l.expiry_date, cost: l.cost } });
        left -= take;
      }
      if (left > 0) await moveStock(db, { branchId: t.to_branch_id, productId: it.product_id, qty: left, type: 'transfer_in', refType: 'transfer', refId: t.id, staffId: req.staff!.id, lot: {} });
      if (rq < Number(it.qty)) {
        await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'stock.transfer_short', entity: 'transfer', entityId: t.id, details: { productId: it.product_id, sent: it.qty, received: rq } }, db);
      }
    }
    await db.query(`UPDATE stock_transfers SET status='received', received_by=$2, received_at=now() WHERE id=$1`, [t.id, req.staff!.id]);
  });
  res.json({ ok: true });
});

// ---- stock counts ----
stockRouter.get('/counts', requirePerm('stock.adjust'), async (_req, res) => {
  res.json(await q(`SELECT c.*, b.name AS branch_name, s.name AS created_by_name, (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id=c.id)::int AS lines FROM stock_counts c JOIN branches b ON b.id=c.branch_id LEFT JOIN staff s ON s.id=c.created_by ORDER BY c.created_at DESC`));
});
stockRouter.post('/counts', requirePerm('stock.adjust'), async (req, res) => {
  const b = parse(z.object({ branchId: z.number(), note: z.string().optional() }), req.body);
  res.json(await one(`INSERT INTO stock_counts (branch_id, note, created_by) VALUES ($1,$2,$3) RETURNING *`, [b.branchId, b.note ?? null, req.staff!.id]));
});
stockRouter.get('/counts/:id', requirePerm('stock.adjust'), async (req, res) => {
  const c = await one('SELECT * FROM stock_counts WHERE id=$1', [String(req.params.id)]);
  if (!c) throw notFound();
  const items = await q(`SELECT i.*, p.name, p.sku, COALESCE(sl.qty,0) AS current_qty FROM stock_count_items i JOIN products p ON p.id=i.product_id
    LEFT JOIN stock_levels sl ON sl.product_id=i.product_id AND sl.branch_id=$2 WHERE count_id=$1 ORDER BY p.name`, [c.id, c.branch_id]);
  res.json({ ...c, items });
});
stockRouter.post('/counts/:id/items', requirePerm('stock.adjust'), async (req, res) => {
  const b = parse(z.object({ productId: z.number(), countedQty: z.number().nonnegative(), reason: z.string().optional() }), req.body);
  const c = await one(`SELECT * FROM stock_counts WHERE id=$1 AND status='open'`, [String(req.params.id)]);
  if (!c) throw conflict('ใบตรวจนับนี้ปิดแล้ว');
  await q(`INSERT INTO stock_count_items (count_id, product_id, counted_qty, reason) VALUES ($1,$2,$3,$4)
    ON CONFLICT (count_id, product_id) DO UPDATE SET counted_qty=EXCLUDED.counted_qty, reason=EXCLUDED.reason`, [c.id, b.productId, b.countedQty, b.reason ?? null]);
  res.json({ ok: true });
});
stockRouter.post('/counts/:id/apply', requirePerm('stock.adjust'), async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(2, 'กรุณาระบุเหตุผลการปรับยอด') }), req.body);
  const result = await tx(async (db) => {
    const c = (await db.query(`SELECT * FROM stock_counts WHERE id=$1 FOR UPDATE`, [String(req.params.id)])).rows[0];
    if (!c || c.status !== 'open') throw conflict('ใบตรวจนับนี้ปิดแล้ว');
    const items = (await db.query('SELECT * FROM stock_count_items WHERE count_id=$1 ORDER BY product_id', [c.id])).rows;
    const diffs: any[] = [];
    for (const it of items) {
      await db.query(`INSERT INTO stock_levels (branch_id, product_id, qty) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [c.branch_id, it.product_id]);
      const cur = Number((await db.query('SELECT qty FROM stock_levels WHERE branch_id=$1 AND product_id=$2 FOR UPDATE', [c.branch_id, it.product_id])).rows[0].qty);
      const diff = Number(it.counted_qty) - cur;
      await db.query('UPDATE stock_count_items SET system_qty=$2 WHERE id=$1', [it.id, cur]);
      if (Math.abs(diff) > 1e-9) {
        await moveStock(db, { branchId: c.branch_id, productId: it.product_id, qty: diff, type: 'count', refType: 'stock_count', refId: c.id, reason: it.reason || b.reason, staffId: req.staff!.id, allowNegative: true, lot: diff > 0 ? {} : undefined });
        diffs.push({ productId: it.product_id, system: cur, counted: it.counted_qty, diff });
      }
    }
    await db.query(`UPDATE stock_counts SET status='applied', applied_by=$2, applied_at=now() WHERE id=$1`, [c.id, req.staff!.id]);
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'stock.count_apply', entity: 'stock_count', entityId: c.id, reason: b.reason, branchId: c.branch_id, details: { diffs } }, db);
    return { adjusted: diffs.length, diffs };
  });
  broadcastStaff('stock.changed', {});
  res.json(result);
});
