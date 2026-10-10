import type { Db } from '../db';
import { conflict } from '../util';
import { roundQty } from '../../../shared/money';

export interface MoveOpts {
  branchId: number;
  productId: number;
  qty: number; // signed: negative = out, positive = in
  type: string; // sale | refund | receive | adjust | transfer_out | transfer_in | count | purchase_return | void
  refType?: string;
  refId?: string | number;
  reason?: string | null;
  staffId?: number | null;
  allowNegative?: boolean;
  productName?: string;
  /** for inbound: create a lot */
  lot?: { lotNo?: string | null; expiryDate?: string | null; cost?: number | null };
  /** for inbound into an existing lot (refund / transfer) */
  lotId?: number | null;
}

/**
 * Atomically move stock (must be called inside a transaction).
 * Locks the stock_levels row (SELECT ... FOR UPDATE) so concurrent POS sales cannot oversell.
 * Outbound movements consume lots FEFO (first-expiry-first-out).
 */
export async function moveStock(db: Db, o: MoveOpts): Promise<{ balance: number; lotIds: number[] }> {
  await db.query(`INSERT INTO stock_levels (branch_id, product_id, qty) VALUES ($1,$2,0) ON CONFLICT DO NOTHING`, [o.branchId, o.productId]);
  const cur = await db.query(`SELECT qty FROM stock_levels WHERE branch_id=$1 AND product_id=$2 FOR UPDATE`, [o.branchId, o.productId]);
  const before = Number(cur.rows[0].qty);
  const after = roundQty(before + o.qty);
  if (o.qty < 0 && after < 0 && !o.allowNegative) {
    throw conflict(`สต็อกไม่พอ: ${o.productName ?? 'สินค้า #' + o.productId} คงเหลือ ${before}`, 'OUT_OF_STOCK', { productId: o.productId, available: before });
  }
  await db.query(`UPDATE stock_levels SET qty=$3 WHERE branch_id=$1 AND product_id=$2`, [o.branchId, o.productId, after]);

  const lotIds: number[] = [];
  const insertMove = async (qty: number, lotId: number | null, bal: number) => {
    await db.query(
      `INSERT INTO stock_movements (branch_id, product_id, lot_id, type, qty, balance_after, ref_type, ref_id, reason, staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [o.branchId, o.productId, lotId, o.type, qty, bal, o.refType ?? null, o.refId != null ? String(o.refId) : null, o.reason ?? null, o.staffId ?? null]);
  };

  if (o.qty < 0) {
    let need = -o.qty;
    const lots = await db.query(
      `SELECT id, qty FROM stock_lots WHERE branch_id=$1 AND product_id=$2 AND qty > 0
       ORDER BY expiry_date NULLS LAST, received_at, id FOR UPDATE`, [o.branchId, o.productId]);
    let bal = before;
    for (const l of lots.rows) {
      if (need <= 0) break;
      const take = Math.min(need, Number(l.qty));
      await db.query('UPDATE stock_lots SET qty = qty - $2 WHERE id=$1', [l.id, take]);
      bal = roundQty(bal - take);
      await insertMove(-take, l.id, bal);
      lotIds.push(l.id);
      need = roundQty(need - take);
    }
    if (need > 0) await insertMove(-need, null, after);
  } else if (o.qty > 0) {
    let lotId = o.lotId ?? null;
    if (!lotId && o.lot) {
      const r = await db.query(
        `INSERT INTO stock_lots (branch_id, product_id, lot_no, expiry_date, qty, cost) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [o.branchId, o.productId, o.lot.lotNo || null, o.lot.expiryDate || null, o.qty, o.lot.cost ?? null]);
      lotId = r.rows[0].id;
    } else if (lotId) {
      await db.query('UPDATE stock_lots SET qty = qty + $2 WHERE id=$1', [lotId, o.qty]);
    }
    if (lotId) lotIds.push(lotId);
    await insertMove(o.qty, lotId, after);
  }
  return { balance: after, lotIds };
}
