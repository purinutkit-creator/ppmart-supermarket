import type { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { pool, one, type Db } from './db';
import { config } from './config';
import { forbidden, HttpError, randomToken, sha256 } from './util';
import type { Permission } from '../../shared/permissions';

export interface StaffCtx {
  id: number;
  name: string;
  employeeCode: string;
  roleKey: string;
  roleName: string;
  permissions: string[];
  maxDiscountPct: number;
  branchId: number | null;
  terminalId: number | null;
  tokenHash: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { staff?: StaffCtx; member?: { id: number } }
  }
}

export const hashPin = (pin: string) => bcrypt.hash(pin, 10);

export async function loadStaff(staffId: number, db: Db = pool) {
  return one(
    `SELECT s.id, s.name, s.employee_code, s.branch_id, s.is_active, r.key AS role_key, r.name AS role_name, r.permissions, r.max_discount_pct
     FROM staff s JOIN roles r ON r.id = s.role_id WHERE s.id = $1`, [staffId], db);
}

/** Verify employee code + PIN with lockout. Returns staff row. */
export async function verifyPin(employeeCode: string, pin: string) {
  const s = await one(`SELECT * FROM staff WHERE employee_code = $1`, [employeeCode]);
  if (!s || !s.is_active) {
    await bcrypt.compare(pin, '$2a$10$abcdefghijklmnopqrstuuJ2tY2bJ9yG2v4m2Q1rQ6sYH8xJm9cKa'); // timing equalisation
    throw new HttpError(401, 'รหัสพนักงานหรือ PIN ไม่ถูกต้อง', 'INVALID_LOGIN');
  }
  if (s.locked_until && new Date(s.locked_until) > new Date()) {
    throw new HttpError(423, `บัญชีถูกล็อกชั่วคราว ลองใหม่หลัง ${new Date(s.locked_until).toLocaleTimeString('th-TH')}`, 'LOCKED');
  }
  const ok = await bcrypt.compare(pin, s.pin_hash);
  if (!ok) {
    const attempts = s.failed_attempts + 1;
    const lock = attempts >= config.pinMaxAttempts;
    await pool.query(
      `UPDATE staff SET failed_attempts = $2, locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END WHERE id = $1`,
      [s.id, lock ? 0 : attempts, lock, String(config.pinLockMinutes)],
    );
    throw new HttpError(401, lock ? `PIN ผิดเกิน ${config.pinMaxAttempts} ครั้ง บัญชีถูกล็อก ${config.pinLockMinutes} นาที` : `รหัสพนักงานหรือ PIN ไม่ถูกต้อง (เหลือ ${config.pinMaxAttempts - attempts} ครั้ง)`, lock ? 'LOCKED' : 'INVALID_LOGIN');
  }
  if (s.failed_attempts || s.locked_until) await pool.query('UPDATE staff SET failed_attempts=0, locked_until=NULL WHERE id=$1', [s.id]);
  return s;
}

export async function createSession(staffId: number, terminalId: number | null) {
  const token = randomToken();
  await pool.query(
    `INSERT INTO staff_sessions (token_hash, staff_id, terminal_id, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval)`,
    [sha256(token), staffId, terminalId, String(config.sessionHours)],
  );
  return token;
}

export async function resolveToken(token: string): Promise<StaffCtx | null> {
  const h = sha256(token);
  const row = await one(
    `SELECT ss.token_hash, ss.terminal_id, s.id, s.name, s.employee_code, s.branch_id, r.key AS role_key, r.name AS role_name, r.permissions, r.max_discount_pct
     FROM staff_sessions ss JOIN staff s ON s.id = ss.staff_id JOIN roles r ON r.id = s.role_id
     WHERE ss.token_hash = $1 AND NOT ss.revoked AND ss.expires_at > now() AND s.is_active`, [h]);
  if (!row) return null;
  pool.query('UPDATE staff_sessions SET last_active_at = now() WHERE token_hash = $1', [h]).catch(() => {});
  return {
    id: row.id, name: row.name, employeeCode: row.employee_code, roleKey: row.role_key, roleName: row.role_name,
    permissions: row.permissions, maxDiscountPct: Number(row.max_discount_pct), branchId: row.branch_id,
    terminalId: row.terminal_id, tokenHash: h,
  };
}

export function bearer(req: Request) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.query.token as string | undefined);
}

export async function requireStaff(req: Request, _res: Response, next: NextFunction) {
  const t = bearer(req);
  const s = t ? await resolveToken(t) : null;
  if (!s) return next(new HttpError(401, 'กรุณาเข้าสู่ระบบ', 'UNAUTHENTICATED'));
  req.staff = s;
  next();
}

export const can = (s: StaffCtx | undefined, p: Permission) => !!s && (s.roleKey === 'owner' || s.permissions.includes(p));

export function requirePerm(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (perms.some((p) => can(req.staff, p))) return next();
    next(forbidden(`ต้องมีสิทธิ์: ${perms.join(' หรือ ')}`, 'FORBIDDEN'));
  };
}

/**
 * Ensure the actor may perform `perm`. If not, a valid unused manager approval token for that permission
 * must be supplied; it is consumed atomically. Returns approver id (or null when actor has permission).
 */
export async function authorizeOrApproval(db: Db, staff: StaffCtx, perm: Permission, approvalId?: string | null): Promise<number | null> {
  if (can(staff, perm)) return null;
  if (!approvalId) throw forbidden('ต้องได้รับการอนุมัติจากผู้จัดการ', 'APPROVAL_REQUIRED', { permission: perm });
  const r = await db.query(
    `UPDATE approvals SET used_at = now() WHERE id = $1 AND permission = $2 AND used_at IS NULL AND expires_at > now() RETURNING approver_id`,
    [approvalId, perm]);
  if (!r.rowCount) throw forbidden('การอนุมัติไม่ถูกต้องหรือหมดอายุ', 'APPROVAL_INVALID', { permission: perm });
  return r.rows[0].approver_id;
}
