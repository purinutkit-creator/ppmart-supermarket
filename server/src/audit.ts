import type { Db } from './db';
import { pool } from './db';

export interface AuditEntry {
  staffId?: number | null;
  staffName?: string | null;
  action: string;
  entity?: string;
  entityId?: string | number | null;
  billNo?: string | null;
  reason?: string | null;
  approvedBy?: number | null;
  terminalId?: number | null;
  branchId?: number | null;
  details?: any;
  ip?: string | null;
}

export async function audit(e: AuditEntry, db: Db = pool) {
  await db.query(
    `INSERT INTO audit_logs (staff_id, staff_name, action, entity, entity_id, bill_no, reason, approved_by, terminal_id, branch_id, details, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [e.staffId ?? null, e.staffName ?? null, e.action, e.entity ?? null, e.entityId != null ? String(e.entityId) : null, e.billNo ?? null,
     e.reason ?? null, e.approvedBy ?? null, e.terminalId ?? null, e.branchId ?? null, JSON.stringify(e.details ?? {}), e.ip ?? null],
  );
}
