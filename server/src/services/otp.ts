import nodemailer from 'nodemailer';
import { pool, one } from '../db';
import { config } from '../config';
import { bad, HttpError, randomCode, sha256, hmac } from '../util';

const hashOtp = (target: string, code: string) => hmac(`${target}:${code}`, config.appSecret);

export async function deliver(target: string, channel: 'sms' | 'email', message: string) {
  let delivered = false;
  if (channel === 'email' && config.smtp.host) {
    const t = nodemailer.createTransport({ host: config.smtp.host, port: config.smtp.port, secure: config.smtp.port === 465, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined });
    await t.sendMail({ from: config.smtp.from, to: target, subject: 'รหัส OTP PPMart', text: message });
    delivered = true;
  }
  if (channel === 'sms' && config.sms.url) {
    const r = await fetch(config.sms.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.sms.token}` }, body: JSON.stringify({ to: target, message }) });
    if (!r.ok) throw new HttpError(502, 'ส่ง SMS ไม่สำเร็จ', 'SMS_FAILED');
    delivered = true;
  }
  if (!config.production) {
    console.log(`[otp:dev] ${channel} -> ${target}: ${message}`);
    delivered = true;
  }
  if (!delivered) throw new HttpError(503, 'ระบบส่ง OTP ยังไม่ได้ตั้งค่า (SMTP หรือ SMS)', 'OTP_NOT_CONFIGURED');
}

/** Rate limited: max 3 OTPs per target per 10 minutes, 10 per IP per hour. */
export async function issueOtp(target: string, purpose: string, ip: string | undefined, payload?: any) {
  const recent = await one(`SELECT COUNT(*)::int n FROM member_otps WHERE target=$1 AND created_at > now() - interval '10 minutes'`, [target]);
  if (recent.n >= 3) throw new HttpError(429, 'ขอ OTP บ่อยเกินไป กรุณารอสักครู่', 'OTP_RATE');
  if (ip) {
    const byIp = await one(`SELECT COUNT(*)::int n FROM member_otps WHERE ip=$1 AND created_at > now() - interval '1 hour'`, [ip]);
    if (byIp.n >= 10) throw new HttpError(429, 'ขอ OTP บ่อยเกินไปจากอุปกรณ์นี้', 'OTP_RATE');
  }
  const code = randomCode(6, '0123456789');
  const ref = randomCode(4);
  await pool.query(`INSERT INTO member_otps (target, purpose, code_hash, payload, expires_at, ip) VALUES ($1,$2,$3,$4, now() + interval '5 minutes', $5)`,
    [target, purpose, hashOtp(target, code), payload ? JSON.stringify(payload) : null, ip ?? null]);
  const channel = target.includes('@') ? 'email' : 'sms';
  await deliver(target, channel, `PPMart OTP: ${code} (Ref ${ref}) ใช้ได้ 5 นาที ห้ามบอกรหัสนี้กับผู้อื่น`);
  return { ref, channel, expiresInSec: 300 };
}

/** Verify (max 5 attempts per OTP). Returns stored payload. */
export async function verifyOtp(target: string, purpose: string, code: string) {
  const r = await one(`SELECT * FROM member_otps WHERE target=$1 AND purpose=$2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`, [target, purpose]);
  if (!r || new Date(r.expires_at) < new Date()) throw bad('OTP หมดอายุหรือไม่ถูกต้อง กรุณาขอรหัสใหม่', 'OTP_INVALID');
  if (r.attempts >= 5) throw bad('กรอก OTP ผิดเกินกำหนด กรุณาขอรหัสใหม่', 'OTP_LOCKED');
  if (r.code_hash !== hashOtp(target, code)) {
    await pool.query('UPDATE member_otps SET attempts = attempts + 1 WHERE id=$1', [r.id]);
    throw bad('OTP ไม่ถูกต้อง', 'OTP_INVALID');
  }
  const c = await pool.query('UPDATE member_otps SET consumed_at=now() WHERE id=$1 AND consumed_at IS NULL', [r.id]);
  if (!c.rowCount) throw bad('OTP ถูกใช้ไปแล้ว', 'OTP_INVALID');
  return r.payload;
}

export const otpTokenHash = sha256;
