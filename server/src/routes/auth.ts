import { Router } from 'express';
import { z } from 'zod';
import { pool, one } from '../db';
import { verifyPin, createSession, requireStaff, loadStaff, can } from '../auth';
import { parse, forbidden, bad } from '../util';
import { audit } from '../audit';
import { APPROVABLE, type Permission } from '../../../shared/permissions';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const b = parse(z.object({ employeeCode: z.string().min(1), pin: z.string().regex(/^\d{4,6}$/, 'PIN ต้องเป็นตัวเลข 4–6 หลัก'), terminalCode: z.string().optional() }), req.body);
  let terminalId: number | null = null;
  if (b.terminalCode) {
    const t = await one('SELECT id, branch_id, is_active FROM terminals WHERE code=$1', [b.terminalCode]);
    if (!t || !t.is_active) throw bad('ไม่พบเครื่อง POS นี้', 'TERMINAL_NOT_FOUND');
    terminalId = t.id;
  }
  const s = await verifyPin(b.employeeCode, b.pin);
  if (terminalId) {
    const t = await one('SELECT branch_id FROM terminals WHERE id=$1', [terminalId]);
    if (s.branch_id && t.branch_id !== s.branch_id) throw forbidden('พนักงานไม่ได้สังกัดสาขาของเครื่องนี้');
  }
  const token = await createSession(s.id, terminalId);
  const staff = await loadStaff(s.id);
  await audit({ staffId: s.id, staffName: s.name, action: 'auth.login', terminalId, ip: req.ip });
  res.json({ token, staff: staffOut(staff), terminalId });
});

authRouter.post('/logout', requireStaff, async (req, res) => {
  await pool.query('UPDATE staff_sessions SET revoked=true WHERE token_hash=$1', [req.staff!.tokenHash]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'auth.logout', terminalId: req.staff!.terminalId, ip: req.ip });
  res.json({ ok: true });
});

authRouter.get('/me', requireStaff, async (req, res) => {
  const s = req.staff!;
  const terminal = s.terminalId ? await one('SELECT t.*, b.name AS branch_name FROM terminals t JOIN branches b ON b.id=t.branch_id WHERE t.id=$1', [s.terminalId]) : null;
  res.json({ staff: { id: s.id, name: s.name, employeeCode: s.employeeCode, role: s.roleKey, roleName: s.roleName, permissions: s.roleKey === 'owner' ? ['*', ...s.permissions] : s.permissions, maxDiscountPct: s.maxDiscountPct, branchId: s.branchId }, terminal });
});

/** Re-verify PIN to unlock an auto-locked POS screen (same staff only). */
authRouter.post('/unlock', requireStaff, async (req, res) => {
  const b = parse(z.object({ pin: z.string() }), req.body);
  await verifyPin(req.staff!.employeeCode, b.pin);
  res.json({ ok: true });
});

/**
 * Manager approval: a supervisor/manager enters their code + PIN on the cashier's screen.
 * Returns a single-use approval id valid for 5 minutes, bound to one permission.
 */
authRouter.post('/approve', requireStaff, async (req, res) => {
  const b = parse(z.object({ employeeCode: z.string(), pin: z.string(), permission: z.string(), reason: z.string().optional() }), req.body);
  if (!APPROVABLE.includes(b.permission as Permission)) throw bad('สิทธิ์นี้ไม่สามารถขออนุมัติได้');
  const a = await verifyPin(b.employeeCode, b.pin);
  const approver = await loadStaff(a.id);
  const ctx = { roleKey: approver.role_key, permissions: approver.permissions } as any;
  if (!approver.is_active || !can(ctx, b.permission as Permission)) {
    throw forbidden(`${approver.name} ไม่มีสิทธิ์อนุมัติรายการนี้`);
  }
  const r = await one(
    `INSERT INTO approvals (approver_id, requested_by, permission, reason, expires_at) VALUES ($1,$2,$3,$4, now() + interval '5 minutes') RETURNING id`,
    [a.id, req.staff!.id, b.permission, b.reason ?? null]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'approval.granted', approvedBy: a.id, reason: b.reason, terminalId: req.staff!.terminalId, details: { permission: b.permission, approver: approver.name }, ip: req.ip });
  res.json({ approvalId: r.id, approverName: approver.name, permission: b.permission });
});

export function staffOut(s: any) {
  return { id: s.id, name: s.name, employeeCode: s.employee_code, role: s.role_key, roleName: s.role_name, permissions: s.role_key === 'owner' ? ['*', ...s.permissions] : s.permissions, maxDiscountPct: Number(s.max_discount_pct), branchId: s.branch_id };
}
