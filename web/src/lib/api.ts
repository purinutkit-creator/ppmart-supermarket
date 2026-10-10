export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public details?: any) { super(message); }
}

const KEY = 'ppmart.session';
export interface Session {
  token: string;
  staff: { id: number; name: string; employeeCode: string; role: string; roleName: string; permissions: string[]; maxDiscountPct: number; branchId: number | null };
  terminalId: number | null;
}

export function getSession(): Session | null {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; }
}
export function setSession(s: Session | null) {
  if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY);
  window.dispatchEvent(new Event('ppmart-session'));
}
export const can = (perm: string) => {
  const s = getSession();
  return !!s && (s.staff.permissions.includes('*') || s.staff.permissions.includes(perm));
};

export async function api<T = any>(path: string, opts: { method?: string; body?: any; token?: string | null; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const token = opts.token === undefined ? getSession()?.token : opts.token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  let r: Response;
  try {
    r = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: { ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e: any) {
    throw new ApiError(0, e?.name === 'AbortError' ? 'หมดเวลาเชื่อมต่อเซิร์ฟเวอร์' : 'ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ (ออฟไลน์?)', 'NETWORK');
  } finally { clearTimeout(timer); }
  const text = await r.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!r.ok) {
    if (r.status === 401 && data?.code === 'UNAUTHENTICATED' && token === getSession()?.token) setSession(null);
    throw new ApiError(r.status, data?.error || `HTTP ${r.status}`, data?.code, data?.details);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body: any = {}) => api<T>(p, { method: 'POST', body });
export const put = <T = any>(p: string, body: any = {}) => api<T>(p, { method: 'PUT', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });
