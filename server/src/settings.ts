import { pool, type Db } from './db';

export const DEFAULT_SETTINGS: Record<string, any> = {
  store: {
    name: 'PPMart Supermarket', nameEn: 'PPMart Supermarket', logo: null, address: '', phone: '', taxId: '',
    currency: 'THB', currencySymbol: '฿', timeZone: 'Asia/Bangkok', promptPayId: '',
  },
  tax: { mode: 'inclusive', rate: 7 },
  pos: {
    autoLockMinutes: 5, allowNegativeStock: false, requireShift: true, roundingSatang: 0,
    weightedBarcode: { prefixes: ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'], itemDigits: 5, mode: 'weight' },
    offlineAllowedMethods: ['cash'],
  },
  points: { enabled: true, spendPerPoint: 2500, pointValue: 10, minRedeem: 100, expiryMonths: 12 },
  coupons: {
    maxPerBill: 3,
    reservationMinutes: 15,
    onRedeemedOrderRefund: 'none', // none | reactivate | reissue
    onIssuedOrderRefund: 'cancel', // cancel | keep | review
  },
  fonts: { pos: 'Sarabun', dashboard: 'Sarabun', display: 'Kanit', member: 'Sarabun', receipt: 'Sarabun', report: 'Sarabun' },
  display: {
    logo: null, background: null, primaryColor: '#0f766e', accentColor: '#f59e0b', textColor: '#0f172a', bgColor: '#f8fafc',
    font: 'Kanit', promoImages: [], slideSeconds: 6, thankYouSeconds: 8,
  },
  receipt: null, // filled with default templates by seed / client
};

const cache = new Map<string, any>();

export async function getSetting<T = any>(key: string, db: Db = pool): Promise<T> {
  if (cache.has(key)) return cache.get(key);
  const r = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  const def = DEFAULT_SETTINGS[key];
  let v = r.rows[0]?.value ?? def;
  if (def && typeof def === 'object' && !Array.isArray(def) && v && typeof v === 'object') v = { ...def, ...v };
  cache.set(key, v);
  return v;
}

export async function setSetting(key: string, value: any, staffId: number | null, db: Db = pool) {
  await db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($1,$2,now(),$3)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [key, JSON.stringify(value), staffId],
  );
  cache.delete(key);
}

export function clearSettingsCache() { cache.clear(); }

export async function getAllSettings() {
  const out: Record<string, any> = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = await getSetting(k);
  const r = await pool.query('SELECT key, value FROM settings');
  for (const row of r.rows) if (!(row.key in out)) out[row.key] = row.value;
  return out;
}
