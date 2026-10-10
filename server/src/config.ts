import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader (no dependency)
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
}

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ppmart',
  appSecret: process.env.APP_SECRET || 'dev-secret-change-me',
  production: process.env.NODE_ENV === 'production',
  timeZone: process.env.TZ_STORE || 'Asia/Bangkok',
  sessionHours: 12,
  pinMaxAttempts: 5,
  pinLockMinutes: 15,
  couponReserveMinutes: 15,
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'PPMart <no-reply@example.com>',
  },
  sms: { url: process.env.SMS_WEBHOOK_URL || '', token: process.env.SMS_WEBHOOK_TOKEN || '' },
  omiseSecret: process.env.OMISE_SECRET_KEY || '',
  paymentWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET || '',
};

if (config.production && config.appSecret === 'dev-secret-change-me') {
  throw new Error('APP_SECRET must be set in production');
}
