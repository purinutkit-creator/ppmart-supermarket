import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, setSession, getSession } from '../lib/api';
import { Numpad, errMsg } from '../components/ui';

export default function Login() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [terminal, setTerminal] = useState(() => localStorage.getItem('ppmart.terminalCode') || '');
  const [mode, setMode] = useState<'pos' | 'admin'>(() => (sp.get('next')?.startsWith('/admin') ? 'admin' : 'pos'));
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [field, setField] = useState<'code' | 'pin'>('code');

  useEffect(() => {
    const s = getSession();
    if (s) nav(sp.get('next') || (s.terminalId ? '/pos' : '/admin'), { replace: true });
  }, []); // eslint-disable-line

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/api/auth/login', { body: { employeeCode: code.trim(), pin, terminalCode: mode === 'pos' ? terminal.trim().toUpperCase() || undefined : undefined }, token: null });
      if (mode === 'pos' && terminal) localStorage.setItem('ppmart.terminalCode', terminal.trim().toUpperCase());
      setSession({ token: r.token, staff: r.staff, terminalId: r.terminalId });
      nav(sp.get('next') || (mode === 'pos' && r.terminalId ? '/pos' : '/admin'), { replace: true });
    } catch (e) { setErr(errMsg(e)); setPin(''); } finally { setBusy(false); }
  };

  const key = (k: string) => {
    const set = field === 'code' ? setCode : setPin;
    const max = field === 'pin' ? 6 : 12;
    if (k === '⌫') set((v) => v.slice(0, -1)); else set((v) => (v + k).slice(0, max));
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg,#0f766e,#0f172a)', padding: 16 }}>
      <div className="card" style={{ width: 'min(420px,100%)', padding: '1.6rem' }}>
        <div className="center" style={{ marginBottom: '1rem' }}>
          <div style={{ fontSize: '2.2rem' }}>🛒</div>
          <h1 style={{ marginBottom: 0 }}>PPMart</h1>
          <div className="muted small">Supermarket POS & Management</div>
        </div>
        <div className="tabs" style={{ justifyContent: 'center' }}>
          <button className={mode === 'pos' ? 'on' : ''} onClick={() => setMode('pos')}>หน้าขาย (POS)</button>
          <button className={mode === 'admin' ? 'on' : ''} onClick={() => setMode('admin')}>หลังร้าน</button>
        </div>
        <form className="grid" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {mode === 'pos' && (
            <label className="f"><span>รหัสเครื่อง POS</span><input className="in" value={terminal} onChange={(e) => setTerminal(e.target.value.toUpperCase())} placeholder="เช่น POS01" /></label>
          )}
          <label className="f"><span>รหัสพนักงาน</span><input className="in" autoFocus value={code} onFocus={() => setField('code')} onChange={(e) => setCode(e.target.value)} autoComplete="username" /></label>
          <label className="f"><span>PIN (4–6 หลัก)</span><input className="in" type="password" inputMode="numeric" value={pin} onFocus={() => setField('pin')} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="current-password" /></label>
          <Numpad onKey={key} />
          {err && <div className="err small">{err}</div>}
          <button className="btn primary lg block" disabled={busy || !code || pin.length < 4}>เข้าสู่ระบบ</button>
        </form>
        <div className="row small" style={{ marginTop: '1rem', justifyContent: 'center' }}>
          <a href="/display">หน้าจอลูกค้า</a>·<a href="/member">เว็บไซต์สมาชิก</a>
        </div>
      </div>
    </div>
  );
}
