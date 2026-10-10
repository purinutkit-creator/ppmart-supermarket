import type { Db } from '../db';
import { bad } from '../util';
import { getSetting } from '../settings';

export async function pointsConfig(db: Db) {
  return getSetting('points', db) as Promise<{ enabled: boolean; spendPerPoint: number; pointValue: number; minRedeem: number; expiryMonths: number }>;
}

/** Earn points (FIFO lot with expiry). */
export async function earnPoints(db: Db, memberId: number, points: number, saleId: number | null, note: string, staffId?: number | null) {
  if (points <= 0) return;
  const cfg = await pointsConfig(db);
  await db.query(
    `INSERT INTO points_ledger (member_id, type, points, remaining, expires_at, sale_id, note, staff_id)
     VALUES ($1,'earn',$2,$2, CASE WHEN $3 > 0 THEN now() + ($3 || ' months')::interval END, $4, $5, $6)`,
    [memberId, points, cfg.expiryMonths || 0, saleId, note, staffId ?? null]);
  await db.query('UPDATE members SET points = points + $2 WHERE id=$1', [memberId, points]);
}

/** Consume points FIFO from non-expired earn lots. Member row must be locked by caller. */
export async function spendPoints(db: Db, memberId: number, points: number, type: 'redeem' | 'refund' | 'adjust', saleId: number | null, note: string, staffId?: number | null) {
  if (points <= 0) return;
  const m = await db.query('SELECT points FROM members WHERE id=$1', [memberId]);
  if (Number(m.rows[0]?.points ?? 0) < points) throw bad('คะแนนสะสมไม่เพียงพอ', 'POINTS_INSUFFICIENT');
  let need = points;
  const lots = await db.query(
    `SELECT id, remaining FROM points_ledger WHERE member_id=$1 AND type IN ('earn','adjust') AND remaining > 0 AND (expires_at IS NULL OR expires_at > now())
     ORDER BY expires_at NULLS LAST, id FOR UPDATE`, [memberId]);
  for (const l of lots.rows) {
    if (need <= 0) break;
    const take = Math.min(need, l.remaining);
    await db.query('UPDATE points_ledger SET remaining = remaining - $2 WHERE id=$1', [l.id, take]);
    need -= take;
  }
  await db.query(`INSERT INTO points_ledger (member_id, type, points, sale_id, note, staff_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [memberId, type, -points, saleId, note, staffId ?? null]);
  await db.query('UPDATE members SET points = GREATEST(points - $2, 0) WHERE id=$1', [memberId, points]);
}

/** Expire points lots past expiry; returns number of members affected. */
export async function expirePoints(db: Db) {
  const lots = await db.query(
    `SELECT id, member_id, remaining FROM points_ledger WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now() FOR UPDATE`);
  const byMember = new Map<number, number>();
  for (const l of lots.rows) {
    await db.query('UPDATE points_ledger SET remaining = 0 WHERE id=$1', [l.id]);
    byMember.set(l.member_id, (byMember.get(l.member_id) || 0) + l.remaining);
  }
  for (const [memberId, pts] of byMember) {
    await db.query(`INSERT INTO points_ledger (member_id, type, points, note) VALUES ($1,'expire',$2,'คะแนนหมดอายุ')`, [memberId, -pts]);
    await db.query('UPDATE members SET points = GREATEST(points - $2, 0) WHERE id=$1', [memberId, pts]);
  }
  return byMember.size;
}

/** Re-evaluate member tier: highest-ranked tier whose (non-zero) criteria are all satisfied. */
export async function recalcTier(db: Db, memberId: number) {
  const m = (await db.query('SELECT total_spend, points, visit_count, tier_id FROM members WHERE id=$1', [memberId])).rows[0];
  if (!m) return null;
  const tiers = (await db.query('SELECT * FROM tiers ORDER BY rank DESC')).rows;
  for (const t of tiers) {
    if (Number(m.total_spend) >= Number(t.min_spend) && m.points >= t.min_points && m.visit_count >= t.min_visits) {
      if (t.id !== m.tier_id) await db.query('UPDATE members SET tier_id=$2 WHERE id=$1', [memberId, t.id]);
      return t;
    }
  }
  return null;
}
