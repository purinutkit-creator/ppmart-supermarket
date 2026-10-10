import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { api, ApiError } from '../lib/api';

// ---------- Modal ----------
export function Modal({ open = true, title, onClose, children, footer, width }: { open?: boolean; title: ReactNode; onClose?: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open || !onClose) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-modal>
        <header><h3 style={{ margin: 0 }}>{title}</h3>{onClose && <button className="btn ghost sm" onClick={onClose} aria-label="ปิด">✕</button>}</header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

// ---------- Toasts ----------
type Toast = { id: number; msg: string; kind?: 'ok' | 'err' | 'warn' };
const ToastCtx = createContext<(msg: string, kind?: Toast['kind']) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((msg: string, kind?: Toast['kind']) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, msg, kind }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), kind === 'err' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">{list.map((t) => <div key={t.id} className={`toast ${t.kind ?? ''}`}>{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
export const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

// ---------- Async data hook ----------
export function useApi<T = any>(path: string | null, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try { setData(await api<T>(path)); setError(null); } catch (e) { setError(errMsg(e)); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload, setData };
}

// ---------- Manager approval (code + PIN) ----------
type ApprovalReq = { permission: string; reason?: string; resolve: (id: string | null) => void };
const ApprovalCtx = createContext<(permission: string, reason?: string) => Promise<string | null>>(async () => null);
export function ApprovalProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<ApprovalReq | null>(null);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const ask = useCallback((permission: string, reason?: string) => new Promise<string | null>((resolve) => { setCode(''); setPin(''); setErr(''); setReq({ permission, reason, resolve }); }), []);
  const close = (v: string | null) => { req?.resolve(v); setReq(null); };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api('/api/auth/approve', { body: { employeeCode: code, pin, permission: req!.permission, reason: req!.reason } });
      close(r.approvalId);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <ApprovalCtx.Provider value={ask}>
      {children}
      {req && (
        <Modal title="🔐 ต้องได้รับการอนุมัติจากผู้จัดการ" onClose={() => close(null)} width={420}
          footer={<><button className="btn" onClick={() => close(null)}>ยกเลิก</button><button className="btn primary" disabled={busy || !code || pin.length < 4} onClick={submit}>อนุมัติ</button></>}>
          <p className="muted small">สิทธิ์: <b>{req.permission}</b>{req.reason ? ` — ${req.reason}` : ''}</p>
          <div className="grid">
            <label className="f"><span>รหัสพนักงานผู้อนุมัติ</span><input className="in" autoFocus value={code} onChange={(e) => setCode(e.target.value)} /></label>
            <label className="f"><span>PIN</span><input className="in" type="password" inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && submit()} /></label>
            {err && <div className="err small">{err}</div>}
          </div>
        </Modal>
      )}
    </ApprovalCtx.Provider>
  );
}
export const useApproval = () => useContext(ApprovalCtx);

/** Run an API action; on APPROVAL_REQUIRED, ask a manager and retry with approvalId. */
export function useWithApproval() {
  const ask = useApproval();
  return async <T,>(perm: string, reason: string | undefined, fn: (approvalId: string | null) => Promise<T>): Promise<T | null> => {
    try { return await fn(null); } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') {
        const id = await ask(e.details?.permission ?? perm, reason);
        if (!id) return null;
        return fn(id);
      }
      throw e;
    }
  };
}

// ---------- Barcode & QR ----------
export function BarcodeSvg({ value, height = 50, width = 2, displayValue = true, fontSize = 14 }: { value: string; height?: number; width?: number; displayValue?: boolean; fontSize?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!ref.current || !value) return;
    try { JsBarcode(ref.current, value, { format: /^\d{13}$/.test(value) ? 'EAN13' : /^\d{8}$/.test(value) ? 'EAN8' : 'CODE128', height, width, displayValue, fontSize, margin: 4 }); }
    catch { JsBarcode(ref.current, value, { format: 'CODE128', height, width, displayValue, fontSize, margin: 4 }); }
  }, [value, height, width, displayValue, fontSize]);
  return <svg ref={ref} style={{ maxWidth: '100%' }} />;
}

export function QrCanvas({ value, size = 200 }: { value: string; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current && value) QRCode.toCanvas(ref.current, value, { width: size, margin: 1 }); }, [value, size]);
  return <canvas ref={ref} />;
}

export function Numpad({ onKey }: { onKey: (k: string) => void }) {
  return (
    <div className="numpad">
      {['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '⌫'].map((k) => <button key={k} type="button" onClick={() => onKey(k)}>{k}</button>)}
    </div>
  );
}

export function StatusBadge({ s }: { s: string }) { return <span className={`badge ${s}`}>{s}</span>; }

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="f"><span>{label}</span>{children}</label>;
}

export function Empty({ text = 'ไม่มีข้อมูล' }: { text?: string }) { return <div className="muted center" style={{ padding: '2rem' }}>{text}</div>; }

/** Money input in baht that reports satang */
export function MoneyInput({ value, onChange, ...rest }: { value: number | null | undefined; onChange: (satang: number | null) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [txt, setTxt] = useState(value == null ? '' : String(value / 100));
  useEffect(() => { const cur = txt === '' ? null : Math.round(Number(txt) * 100); if (cur !== value) setTxt(value == null ? '' : String(value / 100)); /* eslint-disable-next-line */ }, [value]);
  return <input className="in num" inputMode="decimal" {...rest} value={txt} onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ''); setTxt(v); onChange(v === '' ? null : Math.round(Number(v) * 100)); }} />;
}
