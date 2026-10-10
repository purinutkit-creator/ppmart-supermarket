import { z } from 'zod';
import { tx, one } from '../db';
import { bad, conflict } from '../util';
import { authorizeOrApproval, type StaffCtx } from '../auth';
import { moveStock } from './stock';
import { spendPoints, earnPoints, recalcTier } from './points';
import { applyRefundCouponPolicies } from './coupons';
import { audit } from '../audit';

export const refundSchema = z.object({
  idempotencyKey: z.string().min(8),
  type: z.enum(['refund', 'void']),
  reason: z.string().min(2, 'กรุณาระบุเหตุผล'),
  items: z.array(z.object({ saleItemId: z.number().int(), qty: z.number().positive(), restock: z.boolean().default(true) })).optional(),
  restockAll: z.boolean().optional().default(true),
  method: z.enum(['cash', 'original']).default('cash'),
  approvalId: z.string().nullable().optional(),
});

export async function refundSale(staff: StaffCtx, saleId: number, input: z.infer<typeof refundSchema>, ip?: string) {
  const dup = await one('SELECT id, sale_id FROM refunds WHERE idempotency_key=$1', [input.idempotencyKey]);
  if (dup) return { duplicate: true, refundId: dup.id };

  return tx(async (db) => {
    const perm = input.type === 'void' ? 'pos.void_bill' : 'pos.refund';
    const approver = await authorizeOrApproval(db, staff, perm, input.approvalId);
    const sale = (await db.query('SELECT * FROM sales WHERE id=$1 FOR UPDATE', [saleId])).rows[0];
    if (!sale) throw bad('ไม่พบบิล');
    if (sale.status === 'refunded' || sale.status === 'voided') throw conflict('บิลนี้ถูกคืนเงิน/ยกเลิกไปแล้ว', 'ALREADY_REFUNDED');
    const items = (await db.query('SELECT si.*, p.track_stock FROM sale_items si JOIN products p ON p.id=si.product_id WHERE sale_id=$1 ORDER BY si.id FOR UPDATE OF si', [saleId])).rows;

    if (input.type === 'void') {
      if (items.some((i) => Number(i.refunded_qty) > 0)) throw conflict('บิลที่มีการคืนสินค้าบางส่วนแล้ว ไม่สามารถ Void ได้', 'PARTIAL_REFUNDED');
      const openShift = (await db.query(`SELECT id FROM shifts WHERE terminal_id=$1 AND status='open'`, [sale.terminal_id])).rows[0];
      if (!openShift || openShift.id !== sale.shift_id) throw conflict('Void ได้เฉพาะบิลในกะที่ยังเปิดอยู่ กรุณาใช้การคืนเงินแทน', 'VOID_SHIFT_CLOSED');
    }

    const req = input.type === 'void' || !input.items?.length
      ? items.map((i) => ({ saleItemId: i.id, qty: Number(i.qty) - Number(i.refunded_qty), restock: input.restockAll }))
      : input.items!;

    let total = 0;
    const done: { item: any; qty: number; amount: number; restock: boolean }[] = [];
    for (const r of req) {
      const it = items.find((i) => i.id === r.saleItemId);
      if (!it) throw bad(`ไม่พบรายการ #${r.saleItemId} ในบิล`);
      const remaining = Number(it.qty) - Number(it.refunded_qty);
      if (r.qty > remaining + 1e-9) throw conflict(`${it.name} คืนได้สูงสุด ${remaining}`, 'REFUND_QTY');
      if (r.qty <= 0) continue;
      // proportional amount; the final remaining qty takes the exact remainder
      const alreadyAmount = Math.round((Number(it.line_total) * Number(it.refunded_qty)) / Number(it.qty));
      const amount = Math.abs(r.qty - remaining) < 1e-9 ? Number(it.line_total) - alreadyAmount : Math.round((Number(it.line_total) * r.qty) / Number(it.qty));
      done.push({ item: it, qty: r.qty, amount, restock: r.restock });
      total += amount;
    }
    if (!done.length) throw bad('ไม่มีรายการที่จะคืน');

    const shift = (await db.query(`SELECT id FROM shifts WHERE terminal_id=$1 AND status='open'`, [staff.terminalId ?? sale.terminal_id])).rows[0];
    const ref = (await db.query(
      `INSERT INTO refunds (idempotency_key, sale_id, type, total, method, reason, staff_id, approved_by, shift_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [input.idempotencyKey, saleId, input.type, total, input.method, input.reason, staff.id, approver, shift?.id ?? null])).rows[0];

    for (const d of done) {
      await db.query('INSERT INTO refund_items (refund_id, sale_item_id, qty, amount, restock) VALUES ($1,$2,$3,$4,$5)', [ref.id, d.item.id, d.qty, d.amount, d.restock]);
      await db.query('UPDATE sale_items SET refunded_qty = refunded_qty + $2 WHERE id=$1', [d.item.id, d.qty]);
      if (d.restock && d.item.track_stock) {
        const pack = Number(d.item.pack_qty || 1);
        await moveStock(db, { branchId: sale.branch_id, productId: d.item.product_id, qty: d.qty * pack, type: input.type === 'void' ? 'void' : 'refund', refType: 'refund', refId: ref.id, staffId: staff.id, reason: input.reason });
      }
    }

    const after = (await db.query('SELECT SUM(qty) q, SUM(refunded_qty) r FROM sale_items WHERE sale_id=$1', [saleId])).rows[0];
    const full = Number(after.r) >= Number(after.q) - 1e-9;
    const newStatus = input.type === 'void' ? 'voided' : full ? 'refunded' : 'partially_refunded';
    await db.query('UPDATE sales SET status=$2 WHERE id=$1', [saleId, newStatus]);

    // cash out of the drawer
    if (input.method === 'cash' && shift) {
      await db.query(`INSERT INTO cash_movements (shift_id, type, amount, reason, ref, staff_id, approved_by) VALUES ($1,'refund_cash',$2,$3,$4,$5,$6)`,
        [shift.id, total, input.reason, sale.bill_no, staff.id, approver]);
    }
    // gift card credit back
    if (input.method === 'original') {
      const gcs = (await db.query(`SELECT * FROM sale_payments WHERE sale_id=$1 AND method='gift_card'`, [saleId])).rows;
      let left = total;
      for (const g of gcs) {
        const back = Math.min(left, Number(g.amount));
        if (back <= 0) break;
        await db.query('UPDATE gift_cards SET balance = balance + $2 WHERE id=$1', [g.gift_card_id, back]);
        await db.query('INSERT INTO gift_card_txns (gift_card_id, amount, sale_id) VALUES ($1,$2,$3)', [g.gift_card_id, back, saleId]);
        left -= back;
      }
    }

    // member: reverse earned points proportionally, return redeemed points on full refund
    if (sale.member_id) {
      await db.query('SELECT id FROM members WHERE id=$1 FOR UPDATE', [sale.member_id]);
      const ratio = Number(sale.total) > 0 ? total / Number(sale.total) : 1;
      const reverse = full ? sale.points_earned - (await alreadyReversed(db, saleId)) : Math.floor(sale.points_earned * ratio);
      if (reverse > 0) {
        const bal = (await db.query('SELECT points FROM members WHERE id=$1', [sale.member_id])).rows[0].points;
        const take = Math.min(reverse, bal);
        if (take > 0) await spendPoints(db, sale.member_id, take, 'refund', saleId, `ปรับคะแนนจากการคืนสินค้าบิล ${sale.bill_no}`, staff.id);
      }
      if (full && sale.points_redeemed > 0) await earnPoints(db, sale.member_id, sale.points_redeemed, saleId, `คืนคะแนนที่แลกในบิล ${sale.bill_no}`, staff.id);
      await db.query('UPDATE members SET total_spend = GREATEST(total_spend - $2, 0) WHERE id=$1', [sale.member_id, total]);
      await recalcTier(db, sale.member_id);
    }

    const couponNotes = await applyRefundCouponPolicies(db, saleId, full, staff);

    await audit({
      staffId: staff.id, staffName: staff.name, action: input.type === 'void' ? 'sale.void' : 'sale.refund', entity: 'sale', entityId: saleId,
      billNo: sale.bill_no, reason: input.reason, approvedBy: approver, terminalId: staff.terminalId, branchId: sale.branch_id, ip,
      details: { refundId: ref.id, total, items: done.map((d) => ({ saleItemId: d.item.id, qty: d.qty, amount: d.amount, restock: d.restock })), couponNotes },
    }, db);
    return { duplicate: false, refundId: ref.id, total, status: newStatus, couponNotes, billNo: sale.bill_no };
  });
}

async function alreadyReversed(db: any, saleId: number) {
  const r = await db.query(`SELECT COALESCE(-SUM(points),0) AS p FROM points_ledger WHERE sale_id=$1 AND type='refund'`, [saleId]);
  return Number(r.rows[0].p);
}
