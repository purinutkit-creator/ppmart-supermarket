import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: any) {
    super(message);
  }
}
export const bad = (msg: string, code = 'BAD_REQUEST', details?: any) => new HttpError(400, msg, code, details);
export const notFound = (msg = 'ไม่พบข้อมูล') => new HttpError(404, msg, 'NOT_FOUND');
export const forbidden = (msg = 'ไม่มีสิทธิ์ดำเนินการ', code = 'FORBIDDEN', details?: any) => new HttpError(403, msg, code, details);
export const conflict = (msg: string, code = 'CONFLICT', details?: any) => new HttpError(409, msg, code, details);

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const hmac = (data: string, secret: string) => crypto.createHmac('sha256', secret).update(data).digest('hex');

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// Crockford-like alphabet without ambiguous characters (0/O, 1/I/L)
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function randomCode(len: number, alphabet = ALPHA) {
  const out: string[] = [];
  const max = 256 - (256 % alphabet.length);
  while (out.length < len) {
    for (const b of crypto.randomBytes(len * 2)) {
      if (b < max && out.length < len) out.push(alphabet[b % alphabet.length]);
    }
  }
  return out.join('');
}

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) throw bad('ข้อมูลไม่ถูกต้อง: ' + e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'VALIDATION', e.issues);
    throw e;
  }
}

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'ไฟล์/ข้อมูลมีขนาดใหญ่เกินไป', code: 'TOO_LARGE' });
  if (err?.code === '23505') return res.status(409).json({ error: 'ข้อมูลซ้ำ: ' + (err.detail || ''), code: 'DUPLICATE' });
  if (err?.code === '23503') return res.status(409).json({ error: 'ข้อมูลถูกอ้างอิงอยู่ ไม่สามารถดำเนินการได้', code: 'FK' });
  console.error('[error]', err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในระบบ', code: 'INTERNAL' });
}

export const pad = (n: number, w: number) => String(n).padStart(w, '0');

export function docNo(prefix: string) {
  const d = new Date();
  return `${prefix}${d.getFullYear().toString().slice(2)}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}-${randomCode(5)}`;
}
