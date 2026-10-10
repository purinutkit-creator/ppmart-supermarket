import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { pool, q, one, tx, type Db } from '../db';
import { requireStaff, requirePerm } from '../auth';
import { parse, bad, notFound, randomCode, randomToken, sha256, HttpError } from '../util';
import { earnPoints, spendPoints, recalcTier } from '../services/points';
import { generateUniqueCoupon, couponEvent, couponPublic } from '../services/coupons';
import { issueOtp, verifyOtp } from '../services/otp';
import { audit } from '../audit';
import { getAllSettings } from '../settings';
import bcrypt from 'bcryptjs';

const phoneRe = /^0\d{8,9}$/;
/** Never send password hashes / lockout internals to staff clients. */
const safeMember = ({ password_hash, failed_logins, locked_until, ...m }: any) => ({ ...m, has_password: password_hash != null });
const memberSchema = z.object({
  firstName: z.string().min(1), lastName: z.string().optional().nullable(),
  phone: z.string().regex(phoneRe, 'เบอร์โทรศัพท์ไม่ถูกต้อง'),
  email: z.string().email().optional().nullable().or(z.literal('')),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal('')),
  lang: z.enum(['th', 'en', 'zh']).optional(),
  tierId: z.number().nullable().optional(),
  isActive: z.boolean().optional(),
  address: z.string().max(500).optional().nullable(),
  gender: z.enum(['male', 'female', 'other', 'unspecified']).optional().nullable().or(z.literal('')),
  nationality: z.string().max(80).optional().nullable(),
  country: z.string().max(80).optional().nullable(),
});

/** Extra profile fields asked after the first login (and on self-registration). */
export const profileSchema = z.object({
  address: z.string().max(500).optional().nullable(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable().or(z.literal('')),
  gender: z.enum(['male', 'female', 'other', 'unspecified']).optional().nullable().or(z.literal('')),
  nationality: z.string().max(80).optional().nullable(),
  country: z.string().max(80).optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
});

export const MEMBER_PUBLIC_COLS = `m.id, m.member_no, m.first_name, m.last_name, m.phone, m.points, m.birthday, m.tier_id, m.created_at, m.address, m.gender, m.nationality, m.country`;

export async function createMember(db: Db, m: z.infer<typeof memberSchema>, branchId: number | null) {
  const lowest = (await db.query('SELECT id FROM tiers ORDER BY rank LIMIT 1')).rows[0];
  for (let i = 0; i < 10; i++) {
    const no = 'M' + randomCode(9, '0123456789');
    const r = await db.query(
      `INSERT INTO members (member_no, first_name, last_name, phone, email, birthday, tier_id, branch_id, lang, address, gender, nationality, country)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (member_no) DO NOTHING RETURNING *`,
      [no, m.firstName, m.lastName || null, m.phone, m.email || null, m.birthday || null, m.tierId ?? lowest?.id ?? null, branchId, m.lang ?? 'th',
       m.address || null, m.gender || null, m.nationality || null, m.country || null]);
    if (r.rowCount) return r.rows[0];
  }
  throw new Error('member no generation failed');
}

// ================= Staff side =================
export const membersRouter = Router();
membersRouter.use(requireStaff);

membersRouter.get('/', requirePerm('members.manage', 'pos.sell'), async (req, res) => {
  const term = String(req.query.q || '').trim();
  res.json(await q(`SELECT m.*, t.name AS tier_name, t.color AS tier_color FROM members m LEFT JOIN tiers t ON t.id=m.tier_id
    WHERE ($1 = '' OR m.member_no ILIKE '%'||$1||'%' OR m.phone LIKE '%'||$1||'%' OR (m.first_name||' '||coalesce(m.last_name,'')) ILIKE '%'||$1||'%' OR m.email ILIKE '%'||$1||'%')
    ORDER BY m.created_at DESC LIMIT 300`, [term]).then((r) => r.map(safeMember)));
});

membersRouter.get('/tiers', async (_req, res) => res.json(await q('SELECT * FROM tiers ORDER BY rank')));
membersRouter.post('/tiers', requirePerm('members.manage'), async (req, res) => {
  const b = parse(z.object({ id: z.number().optional(), name: z.string().min(1), rank: z.number().int(), minSpend: z.number().int().nonnegative(), minPoints: z.number().int().nonnegative(), minVisits: z.number().int().nonnegative(), pointMultiplier: z.number().positive(), discountPct: z.number().min(0).max(100), color: z.string(), benefits: z.string().optional().nullable() }), req.body);
  const vals = [b.name, b.rank, b.minSpend, b.minPoints, b.minVisits, b.pointMultiplier, b.discountPct, b.color, b.benefits ?? null];
  if (b.id) await pool.query('UPDATE tiers SET name=$1, rank=$2, min_spend=$3, min_points=$4, min_visits=$5, point_multiplier=$6, discount_pct=$7, color=$8, benefits=$9 WHERE id=$10', [...vals, b.id]);
  else await pool.query('INSERT INTO tiers (name, rank, min_spend, min_points, min_visits, point_multiplier, discount_pct, color, benefits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', vals);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: b.id ? 'tier.update' : 'tier.create', entity: 'tier', entityId: b.id ?? null, details: b });
  res.json({ ok: true });
});
membersRouter.delete('/tiers/:id', requirePerm('members.manage'), async (req, res) => {
  const inUse = await one('SELECT COUNT(*)::int n FROM members WHERE tier_id=$1', [String(req.params.id)]);
  if (inUse.n) throw bad(`มีสมาชิก ${inUse.n} คนอยู่ใน Tier นี้ กรุณาย้ายก่อนลบ`);
  await pool.query('DELETE FROM tiers WHERE id=$1', [String(req.params.id)]);
  res.json({ ok: true });
});
membersRouter.post('/tiers/recalculate', requirePerm('members.manage'), async (_req, res) => {
  const ids = await q('SELECT id FROM members');
  await tx(async (db) => { for (const m of ids) await recalcTier(db, m.id); });
  res.json({ ok: true, members: ids.length });
});

membersRouter.get('/:id', requirePerm('members.manage', 'pos.sell'), async (req, res) => {
  const m = await one(`SELECT m.*, t.name AS tier_name FROM members m LEFT JOIN tiers t ON t.id=m.tier_id WHERE m.id=$1`, [String(req.params.id)]);
  if (!m) throw notFound();
  const sales = await q(`SELECT id, bill_no, total, status, created_at, points_earned, points_redeemed FROM sales WHERE member_id=$1 ORDER BY created_at DESC LIMIT 100`, [m.id]);
  const ledger = await q(`SELECT * FROM points_ledger WHERE member_id=$1 ORDER BY created_at DESC LIMIT 200`, [m.id]);
  const coupons = (await q(`SELECT * FROM coupons WHERE member_id=$1 ORDER BY issued_at DESC`, [m.id])).map(couponPublic);
  res.json({ ...safeMember(m), sales, ledger, coupons });
});

membersRouter.post('/', requirePerm('members.manage', 'pos.sell'), async (req, res) => {
  const b = parse(memberSchema, req.body);
  const exists = await one('SELECT id FROM members WHERE phone=$1', [b.phone]);
  if (exists) throw bad('เบอร์โทรนี้เป็นสมาชิกอยู่แล้ว', 'PHONE_TAKEN');
  const branchId = req.staff!.terminalId ? (await one('SELECT branch_id FROM terminals WHERE id=$1', [req.staff!.terminalId]))?.branch_id : req.staff!.branchId;
  const m = await tx((db) => createMember(db, b, branchId ?? null));
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'member.create', entity: 'member', entityId: m.id });
  res.json(safeMember(m));
});

membersRouter.put('/:id', requirePerm('members.manage'), async (req, res) => {
  const b = parse(memberSchema, req.body);
  await pool.query(`UPDATE members SET first_name=$1, last_name=$2, phone=$3, email=$4, birthday=$5, lang=COALESCE($6, lang), tier_id=COALESCE($7, tier_id), is_active=COALESCE($8, is_active),
      address=$10, gender=$11, nationality=$12, country=$13 WHERE id=$9`,
    [b.firstName, b.lastName || null, b.phone, b.email || null, b.birthday || null, b.lang ?? null, b.tierId ?? null, b.isActive ?? null, String(req.params.id),
     b.address || null, b.gender || null, b.nationality || null, b.country || null]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'member.update', entity: 'member', entityId: String(req.params.id) });
  res.json({ ok: true });
});

membersRouter.post('/:id/points', requirePerm('members.manage'), async (req, res) => {
  const b = parse(z.object({ points: z.number().int().refine((v) => v !== 0), reason: z.string().min(2) }), req.body);
  await tx(async (db) => {
    await db.query('SELECT id FROM members WHERE id=$1 FOR UPDATE', [String(req.params.id)]);
    if (b.points > 0) await earnPoints(db, Number(String(req.params.id)), b.points, null, `ปรับคะแนน: ${b.reason}`, req.staff!.id);
    else await spendPoints(db, Number(String(req.params.id)), -b.points, 'adjust', null, `ปรับคะแนน: ${b.reason}`, req.staff!.id);
    await recalcTier(db, Number(String(req.params.id)));
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'member.points_adjust', entity: 'member', entityId: String(req.params.id), reason: b.reason, details: { points: b.points } }, db);
  });
  res.json({ ok: true });
});

// ---- member cards (printed number / barcode / RFID-NFC UID) ----
export async function linkCard(db: Db, memberId: number, code: string, kind: string, staffId: number) {
  const c = code.trim();
  if (c.length < 4) throw bad('เลขบัตรสั้นเกินไป');
  const taken = (await db.query('SELECT member_id FROM member_cards WHERE code=$1', [c])).rows[0];
  if (taken && taken.member_id !== memberId) throw bad('บัตรนี้ผูกกับสมาชิกคนอื่นอยู่แล้ว', 'CARD_TAKEN');
  await db.query(`INSERT INTO member_cards (code, kind, member_id, linked_by) VALUES ($1,$2,$3,$4)
    ON CONFLICT (code) DO UPDATE SET status='active', kind=EXCLUDED.kind, linked_by=EXCLUDED.linked_by, linked_at=now()`, [c, kind, memberId, staffId]);
}
membersRouter.get('/:id/cards', requirePerm('members.manage', 'pos.sell'), async (req, res) => {
  res.json(await q('SELECT code, kind, status, linked_at FROM member_cards WHERE member_id=$1 ORDER BY linked_at', [String(req.params.id)]));
});
membersRouter.post('/:id/cards', requirePerm('members.manage', 'pos.sell'), async (req, res) => {
  const b = parse(z.object({ code: z.string().min(4).max(64), kind: z.enum(['number', 'barcode', 'rfid']).default('number') }), req.body);
  await linkCard(pool, Number(req.params.id), b.code, b.kind, req.staff!.id);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'member.card_link', entity: 'member', entityId: String(req.params.id), details: { kind: b.kind, code: b.code.slice(-4) } });
  res.json({ ok: true });
});
membersRouter.delete('/:id/cards/:code', requirePerm('members.manage'), async (req, res) => {
  await pool.query('DELETE FROM member_cards WHERE member_id=$1 AND code=$2', [String(req.params.id), String(req.params.code)]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'member.card_unlink', entity: 'member', entityId: String(req.params.id) });
  res.json({ ok: true });
});
/** Reset website password back to "last 4 digits of phone" (member must change it after login). */
membersRouter.post('/:id/reset-password', requirePerm('members.manage', 'pos.sell'), async (req, res) => {
  await pool.query('UPDATE members SET password_hash=NULL, password_changed_at=NULL, failed_logins=0, locked_until=NULL WHERE id=$1', [String(req.params.id)]);
  await pool.query('DELETE FROM member_sessions WHERE member_id=$1', [String(req.params.id)]);
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'member.password_reset', entity: 'member', entityId: String(req.params.id) });
  res.json({ ok: true });
});

/** Issue a member coupon (e.g. birthday / goodwill). */
membersRouter.post('/:id/coupons', requirePerm('coupons.manage'), async (req, res) => {
  const b = parse(z.object({ title: z.string(), reward: z.object({ type: z.string(), value: z.number(), valueType: z.enum(['amount', 'percent']).optional(), productIds: z.array(z.number()).optional(), categoryIds: z.array(z.number()).optional(), maxDiscount: z.number().optional() }), minSpend: z.number().int().default(0), validDays: z.number().int().positive().default(30) }), req.body);
  const c = await tx(async (db) => {
    const c = await generateUniqueCoupon(db, { member_id: Number(String(req.params.id)), source: 'member', reward: JSON.stringify(b.reward), title: b.title, min_spend: b.minSpend, status: 'ACTIVE', expires_at: new Date(Date.now() + b.validDays * 86400000) });
    await couponEvent(db, { couponId: c.id, to: 'ACTIVE', staffId: req.staff!.id, reason: 'member coupon issued' });
    await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: 'coupon.issue_member', entity: 'coupon', entityId: c.id, details: b }, db);
    return c;
  });
  res.json(couponPublic(c));
});

// ================= Member self-service website =================
export const memberPortalRouter = Router();

async function requireMember(req: Request, _res: Response, next: NextFunction) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = t ? await one(`SELECT member_id FROM member_sessions WHERE token_hash=$1 AND expires_at > now()`, [sha256(t)]) : null;
  if (!s) return next(new HttpError(401, 'กรุณาเข้าสู่ระบบ', 'UNAUTHENTICATED'));
  req.member = { id: s.member_id };
  next();
}

memberPortalRouter.get('/info', async (_req, res) => {
  const s = await getAllSettings();
  const tiers = await q('SELECT id, name, rank, min_spend, min_points, min_visits, point_multiplier, discount_pct, color, benefits FROM tiers ORDER BY rank');
  const promos = await q(`SELECT id, name, name_en, name_zh, description, image_url, type, ends_at FROM promotions WHERE is_active AND (ends_at IS NULL OR ends_at > now()) ORDER BY priority LIMIT 30`);
  res.json({ store: { name: s.store.name, nameEn: s.store.nameEn, logo: s.store.logo, phone: s.store.phone }, fonts: s.fonts, points: s.points, tiers, promotions: promos });
});

memberPortalRouter.post('/otp/request', async (req, res) => {
  const b = parse(z.object({
    target: z.string().min(5), purpose: z.enum(['login', 'register']),
    profile: memberSchema.omit({ tierId: true, isActive: true }).optional(),
  }), req.body);
  const target = b.target.trim().toLowerCase();
  if (b.purpose === 'login') {
    const m = await one('SELECT id FROM members WHERE is_active AND (phone=$1 OR lower(email)=$1)', [target]);
    // Do not reveal whether the account exists.
    if (m) await issueOtp(target, 'login', req.ip);
    return res.json({ sent: true, message: 'หากข้อมูลถูกต้อง ระบบได้ส่ง OTP ไปแล้ว' });
  }
  if (!b.profile) throw bad('กรุณากรอกข้อมูลสมัครสมาชิก');
  if (b.profile.phone !== target && (b.profile.email || '').toLowerCase() !== target) throw bad('ต้องยืนยัน OTP ผ่านเบอร์โทรหรืออีเมลที่สมัคร');
  const ex = await one('SELECT id FROM members WHERE phone=$1', [b.profile.phone]);
  if (ex) throw bad('เบอร์โทรนี้เป็นสมาชิกอยู่แล้ว กรุณาเข้าสู่ระบบ', 'PHONE_TAKEN');
  const r = await issueOtp(target, 'register', req.ip, b.profile);
  res.json({ sent: true, ...r });
});

memberPortalRouter.post('/otp/verify', async (req, res) => {
  const b = parse(z.object({ target: z.string(), purpose: z.enum(['login', 'register']), code: z.string().regex(/^\d{6}$/) }), req.body);
  const target = b.target.trim().toLowerCase();
  const payload = await verifyOtp(target, b.purpose, b.code);
  let memberId: number;
  if (b.purpose === 'register') {
    const m = await tx((db) => createMember(db, payload, null));
    memberId = m.id;
  } else {
    const m = await one('SELECT id FROM members WHERE is_active AND (phone=$1 OR lower(email)=$1)', [target]);
    if (!m) throw bad('ไม่พบสมาชิก');
    memberId = m.id;
  }
  res.json({ token: await newMemberSession(memberId), mustChangePassword: false });
});

async function newMemberSession(memberId: number) {
  const token = randomToken();
  await pool.query(`INSERT INTO member_sessions (token_hash, member_id, expires_at) VALUES ($1,$2, now() + interval '30 days')`, [sha256(token), memberId]);
  return token;
}

const MAX_FAILS = 5, LOCK_MIN = 15;
/**
 * Password login (alternative to OTP). Identifier: phone, member number or member card number.
 * Until the member sets a password, the initial password is the last 4 digits of their phone number;
 * the site then asks them to change it. Accounts lock for 15 minutes after 5 failed attempts.
 */
memberPortalRouter.post('/login', async (req, res) => {
  const b = parse(z.object({ identifier: z.string().min(3).max(64), password: z.string().min(4).max(100) }), req.body);
  const id = b.identifier.trim();
  const m = await one(`SELECT m.* FROM members m WHERE m.is_active AND (m.phone=$1 OR m.member_no=upper($1)
      OR m.id = (SELECT member_id FROM member_cards c WHERE c.code=$1 AND c.status='active'))`, [id]);
  const generic = () => new HttpError(401, 'ข้อมูลเข้าสู่ระบบไม่ถูกต้อง', 'INVALID_LOGIN');
  if (!m) { await bcrypt.compare(b.password, '$2a$10$abcdefghijklmnopqrstuuJ2tY2bJ9yG2v4m2Q1rQ6sYH8xJm9cKa'); throw generic(); }
  if (m.locked_until && new Date(m.locked_until) > new Date()) throw new HttpError(423, `เข้าสู่ระบบผิดหลายครั้ง กรุณาลองใหม่หลัง ${new Date(m.locked_until).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })}`, 'LOCKED');
  const ok = m.password_hash ? await bcrypt.compare(b.password, m.password_hash) : b.password === String(m.phone).slice(-4);
  if (!ok) {
    const fails = m.failed_logins + 1;
    const lock = fails >= MAX_FAILS;
    await pool.query(`UPDATE members SET failed_logins=$2, locked_until=CASE WHEN $3 THEN now() + interval '${LOCK_MIN} minutes' ELSE locked_until END WHERE id=$1`, [m.id, lock ? 0 : fails, lock]);
    if (lock) throw new HttpError(423, `เข้าสู่ระบบผิด ${MAX_FAILS} ครั้ง บัญชีถูกล็อก ${LOCK_MIN} นาที`, 'LOCKED');
    throw generic();
  }
  await pool.query('UPDATE members SET failed_logins=0, locked_until=NULL WHERE id=$1', [m.id]);
  res.json({ token: await newMemberSession(m.id), mustChangePassword: !m.password_hash });
});

memberPortalRouter.post('/password', requireMember, async (req, res) => {
  const b = parse(z.object({ current: z.string().optional(), password: z.string().min(6, 'รหัสผ่านอย่างน้อย 6 ตัวอักษร').max(100) }), req.body);
  const m = await one('SELECT phone, password_hash FROM members WHERE id=$1', [req.member!.id]);
  if (m.password_hash && !(b.current && (await bcrypt.compare(b.current, m.password_hash)))) throw bad('รหัสผ่านปัจจุบันไม่ถูกต้อง', 'BAD_PASSWORD');
  if (b.password === String(m.phone).slice(-4) || /^(\d)\1+$/.test(b.password) || /^(123456|654321|password)/i.test(b.password)) throw bad('รหัสผ่านนี้คาดเดาง่ายเกินไป', 'WEAK_PASSWORD');
  await pool.query('UPDATE members SET password_hash=$2, password_changed_at=now() WHERE id=$1', [req.member!.id, await bcrypt.hash(b.password, 10)]);
  // sign out other devices
  const t = (req.headers.authorization || '').slice(7);
  await pool.query('DELETE FROM member_sessions WHERE member_id=$1 AND token_hash<>$2', [req.member!.id, sha256(t)]);
  res.json({ ok: true });
});

memberPortalRouter.put('/profile', requireMember, async (req, res) => {
  const b = parse(profileSchema, req.body);
  await pool.query(`UPDATE members SET address=$2, birthday=COALESCE($3::date, birthday), gender=$4, nationality=$5, country=$6, email=COALESCE($7, email), profile_completed_at=now() WHERE id=$1`,
    [req.member!.id, b.address || null, b.birthday || null, b.gender || null, b.nationality || null, b.country || null, b.email || null]);
  res.json({ ok: true });
});

memberPortalRouter.post('/logout', requireMember, async (req, res) => {
  const t = (req.headers.authorization || '').slice(7);
  await pool.query('DELETE FROM member_sessions WHERE token_hash=$1', [sha256(t)]);
  res.json({ ok: true });
});

memberPortalRouter.get('/me', requireMember, async (req, res) => {
  const m = await one(`SELECT m.id, m.member_no, m.first_name, m.last_name, m.phone, m.email, m.birthday, m.points, m.total_spend, m.visit_count, m.created_at, m.lang,
    m.address, m.gender, m.nationality, m.country, m.profile_completed_at, (m.password_hash IS NOT NULL) AS has_password,
    t.id AS tier_id, t.name AS tier_name, t.color AS tier_color, t.benefits AS tier_benefits, t.discount_pct, t.point_multiplier
    FROM members m LEFT JOIN tiers t ON t.id=m.tier_id WHERE m.id=$1`, [req.member!.id]);
  const nextTier = await one(`SELECT * FROM tiers WHERE rank > COALESCE((SELECT rank FROM tiers WHERE id=$1), -1) ORDER BY rank LIMIT 1`, [m.tier_id]);
  const expiring = await one(`SELECT COALESCE(SUM(remaining),0)::int AS pts, MIN(expires_at) AS at FROM points_ledger WHERE member_id=$1 AND remaining>0 AND expires_at < now() + interval '60 days'`, [m.id]);
  res.json({ ...m, phone: m.phone.replace(/^(\d{3})\d+(\d{3})$/, '$1-xxx-$2'), nextTier, expiringPoints: expiring });
});

memberPortalRouter.put('/me', requireMember, async (req, res) => {
  const b = parse(z.object({ lang: z.enum(['th', 'en', 'zh']).optional(), email: z.string().email().optional() }), req.body);
  await pool.query('UPDATE members SET lang=COALESCE($2, lang), email=COALESCE($3, email) WHERE id=$1', [req.member!.id, b.lang ?? null, b.email ?? null]);
  res.json({ ok: true });
});

memberPortalRouter.get('/history', requireMember, async (req, res) => {
  const sales = await q(`SELECT s.id, s.bill_no, s.total, s.status, s.created_at, s.points_earned, s.points_redeemed, b.name AS branch_name,
    (SELECT json_agg(json_build_object('name', si.name, 'qty', si.qty, 'total', si.line_total)) FROM sale_items si WHERE si.sale_id=s.id) AS items
    FROM sales s JOIN branches b ON b.id=s.branch_id WHERE s.member_id=$1 ORDER BY s.created_at DESC LIMIT 100`, [req.member!.id]);
  const ledger = await q(`SELECT type, points, note, created_at, expires_at FROM points_ledger WHERE member_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.member!.id]);
  res.json({ sales, ledger });
});

memberPortalRouter.get('/coupons', requireMember, async (req, res) => {
  // member-bound coupons + receipt coupons issued from this member's bills
  const rows = await q(`SELECT c.* FROM coupons c LEFT JOIN sales s ON s.id=c.issued_sale_id
    WHERE (c.member_id=$1 OR s.member_id=$1) ORDER BY c.status='ACTIVE' DESC, c.expires_at`, [req.member!.id]);
  res.json(rows.map(couponPublic));
});
