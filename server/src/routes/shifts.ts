import { Router } from 'express';
import { z } from 'zod';
import { pool, q, one, tx, type Db } from '../db';
import { requireStaff, requirePerm, authorizeOrApproval, verifyPin, can } from '../auth';
import { parse, bad, conflict, notFound, forbidden } from '../util';
import { audit } from '../audit';
import { broadcastStaff } from '../realtime';

export const shiftsRouter = Router();
shiftsRouter.use(requireStaff);

export async function shiftSummary(shiftId: number, db: Db = pool) {
  const s = await one(`SELECT sh.*, st.name AS staff_name, t.code AS terminal_code, b.name AS branch_name, cb.name AS closed_by_name
    FROM shifts sh JOIN staff st ON st.id=sh.staff_id JOIN terminals t ON t.id=sh.terminal_id JOIN branches b ON b.id=sh.branch_id
    LEFT JOIN staff cb ON cb.id=sh.closed_by WHERE sh.id=$1`, [shiftId], db);
  if (!s) return null;
  const byMethod = await q(`SELECT sp.method, COUNT(DISTINCT sp.sale_id)::int AS bills, SUM(sp.amount)::bigint AS amount
    FROM sale_payments sp JOIN sales sa ON sa.id=sp.sale_id WHERE sa.shift_id=$1 GROUP BY sp.method ORDER BY sp.method`, [shiftId], db);
  const totals = await one(`SELECT COUNT(*)::int AS bills, COALESCE(SUM(total),0)::bigint AS total, COALESCE(SUM(discount_total),0)::bigint AS discounts,
    COUNT(*) FILTER (WHERE status='voided')::int AS voided FROM sales WHERE shift_id=$1`, [shiftId], db);
  const refunds = await one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::bigint AS total FROM refunds WHERE shift_id=$1`, [shiftId], db);
  const cash = await q(`SELECT cm.*, st.name AS staff_name FROM cash_movements cm LEFT JOIN staff st ON st.id=cm.staff_id WHERE shift_id=$1 ORDER BY created_at`, [shiftId], db);
  const sum = (t: string) => cash.filter((c) => c.type === t).reduce((a, c) => a + Number(c.amount), 0);
  const cashSales = Number(byMethod.find((m) => m.method === 'cash')?.amount ?? 0);
  const expected = Number(s.opening_float) + cashSales + sum('pay_in') - sum('pay_out') - sum('refund_cash');
  return {
    shift: s, byMethod, totals, refunds, cashMovements: cash,
    cash: { openingFloat: Number(s.opening_float), cashSales, payIn: sum('pay_in'), payOut: sum('pay_out'), refundCash: sum('refund_cash'), expected, drawerOpens: cash.filter((c) => c.type === 'drawer_open').length },
  };
}

shiftsRouter.get('/current', async (req, res) => {
  if (!req.staff!.terminalId) return res.json(null);
  const s = await one(`SELECT id FROM shifts WHERE terminal_id=$1 AND status='open'`, [req.staff!.terminalId]);
  res.json(s ? await shiftSummary(s.id) : null);
});

shiftsRouter.post('/open', requirePerm('shifts.manage', 'pos.sell'), async (req, res) => {
  const b = parse(z.object({ openingFloat: z.number().int().nonnegative() }), req.body);
  if (!req.staff!.terminalId) throw bad('ไม่ได้ผูกเครื่อง POS');
  const t = await one('SELECT branch_id FROM terminals WHERE id=$1', [req.staff!.terminalId]);
  try {
    const s = await one(`INSERT INTO shifts (terminal_id, branch_id, staff_id, opening_float) VALUES ($1,$2,$3,$4) RETURNING id`, [req.staff!.terminalId, t.branch_id, req.staff!.id, b.openingFloat]);
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'shift.open', entity: 'shift', entityId: s.id, terminalId: req.staff!.terminalId, details: { openingFloat: b.openingFloat } });
    res.json(await shiftSummary(s.id));
  } catch (e: any) {
    if (e.code === '23505') throw conflict('มีกะที่เปิดอยู่แล้วสำหรับเครื่องนี้', 'SHIFT_OPEN');
    throw e;
  }
});

shiftsRouter.post('/:id/cash', requirePerm('shifts.manage', 'pos.sell'), async (req, res) => {
  const b = parse(z.object({ type: z.enum(['pay_in', 'pay_out']), amount: z.number().int().positive(), reason: z.string().min(2), approvalId: z.string().nullable().optional() }), req.body);
  const sh = await one(`SELECT * FROM shifts WHERE id=$1 AND status='open'`, [String(req.params.id)]);
  if (!sh) throw notFound('ไม่พบกะที่เปิดอยู่');
  const approver = await authorizeOrApproval(pool, req.staff!, 'pos.open_drawer', b.approvalId);
  await pool.query(`INSERT INTO cash_movements (shift_id, type, amount, reason, staff_id, approved_by) VALUES ($1,$2,$3,$4,$5,$6)`, [sh.id, b.type, b.amount, b.reason, req.staff!.id, approver]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'cash.' + b.type, entity: 'shift', entityId: sh.id, reason: b.reason, approvedBy: approver, terminalId: sh.terminal_id, details: { amount: b.amount } });
  res.json(await shiftSummary(sh.id));
});

/** Every drawer kick is logged. reason 'sale' (cash sale with bill number) needs no extra permission. */
shiftsRouter.post('/drawer-open', async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(2), saleId: z.number().optional(), approvalId: z.string().nullable().optional() }), req.body);
  const sh = await one(`SELECT * FROM shifts WHERE terminal_id=$1 AND status='open'`, [req.staff!.terminalId]);
  let approver: number | null = null;
  let ref: string | null = null;
  if (b.saleId) {
    const s = await one('SELECT bill_no, terminal_id FROM sales WHERE id=$1', [b.saleId]);
    if (!s || s.terminal_id !== req.staff!.terminalId) throw forbidden('บิลไม่ตรงกับเครื่อง');
    ref = s.bill_no;
  } else {
    approver = await authorizeOrApproval(pool, req.staff!, 'pos.open_drawer', b.approvalId);
  }
  if (sh) await pool.query(`INSERT INTO cash_movements (shift_id, type, amount, reason, ref, staff_id, approved_by) VALUES ($1,'drawer_open',0,$2,$3,$4,$5)`, [sh.id, b.reason, ref, req.staff!.id, approver]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'drawer.open', billNo: ref, reason: b.reason, approvedBy: approver, terminalId: req.staff!.terminalId });
  res.json({ ok: true });
});

shiftsRouter.post('/:id/close', async (req, res) => {
  const b = parse(z.object({
    countedCash: z.number().int().nonnegative(), note: z.string().optional(),
    handover: z.object({ employeeCode: z.string(), pin: z.string(), openingFloat: z.number().int().nonnegative().optional() }).optional(),
  }), req.body);
  const result = await tx(async (db) => {
    const sh = (await db.query(`SELECT * FROM shifts WHERE id=$1 FOR UPDATE`, [String(req.params.id)])).rows[0];
    if (!sh || sh.status !== 'open') throw conflict('กะนี้ถูกปิดไปแล้ว');
    if (sh.staff_id !== req.staff!.id && !can(req.staff, 'shifts.view_all')) throw forbidden('ปิดได้เฉพาะกะของตนเอง หรือผู้มีสิทธิ์');
    const sum = await shiftSummary(sh.id, db);
    const diff = b.countedCash - sum!.cash.expected;
    await db.query(`UPDATE shifts SET status='closed', closed_at=now(), closed_by=$2, expected_cash=$3, counted_cash=$4, difference=$5, note=$6 WHERE id=$1`,
      [sh.id, req.staff!.id, sum!.cash.expected, b.countedCash, diff, b.note ?? null]);
    let newShiftId: number | null = null;
    if (b.handover) {
      const next = await verifyPin(b.handover.employeeCode, b.handover.pin);
      const ns = (await db.query(`INSERT INTO shifts (terminal_id, branch_id, staff_id, opening_float, handover_from_shift_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [sh.terminal_id, sh.branch_id, next.id, b.handover.openingFloat ?? b.countedCash, sh.id])).rows[0];
      await db.query('UPDATE shifts SET handover_to_staff_id=$2 WHERE id=$1', [sh.id, next.id]);
      newShiftId = ns.id;
    }
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'shift.close', entity: 'shift', entityId: sh.id, terminalId: sh.terminal_id, reason: b.note,
      details: { expected: sum!.cash.expected, counted: b.countedCash, difference: diff, handoverShiftId: newShiftId } }, db);
    return { shiftId: sh.id, newShiftId };
  });
  broadcastStaff('shift.closed', result);
  res.json({ ...(await shiftSummary(result.shiftId)), newShiftId: result.newShiftId });
});

shiftsRouter.get('/:id/summary', async (req, res) => {
  const s = await shiftSummary(Number(String(req.params.id)));
  if (!s) throw notFound();
  if (s.shift.staff_id !== req.staff!.id && !can(req.staff, 'shifts.view_all')) throw forbidden();
  res.json(s);
});

shiftsRouter.get('/', requirePerm('shifts.view_all'), async (req, res) => {
  res.json(await q(`SELECT sh.*, st.name AS staff_name, t.code AS terminal_code, b.name AS branch_name FROM shifts sh JOIN staff st ON st.id=sh.staff_id
    JOIN terminals t ON t.id=sh.terminal_id JOIN branches b ON b.id=sh.branch_id ORDER BY sh.opened_at DESC LIMIT 200`));
});
