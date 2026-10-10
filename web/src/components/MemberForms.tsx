import { useEffect, useRef, useState } from 'react';
import { t, type Lang } from '../lib/i18n';
import { Numpad } from './ui';
import { CameraScanner } from './CameraScanner';
import { readNfcOnce, webNfcSupported } from '../lib/nfc';

export type IdentifyMethod = 'phone' | 'card' | 'barcode' | 'tap';
export const IDENTIFY_METHODS: { m: IdentifyMethod; icon: string; key: string }[] = [
  { m: 'phone', icon: '📱', key: 'byPhone' }, { m: 'card', icon: '🔢', key: 'byCard' },
  { m: 'barcode', icon: '🏷️', key: 'byBarcode' }, { m: 'tap', icon: '💳', key: 'byTap' },
];

/**
 * The 4 ways to identify a member: phone number, card number, card barcode, card tap.
 * Barcode scanners and RFID/NFC readers that act as keyboards type into the focused input + Enter;
 * camera scanning and Web NFC are offered where the device supports them.
 */
export function IdentifyMethods({ lang, onSubmit, big = false, initial }: { lang: Lang; onSubmit: (method: IdentifyMethod, value: string) => void; big?: boolean; initial?: IdentifyMethod }) {
  const [method, setMethod] = useState<IdentifyMethod | null>(initial ?? null);
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(false);
  const [nfcErr, setNfcErr] = useState('');
  const [nfcOn, setNfcOn] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { setValue(''); setNfcErr(''); inputRef.current?.focus(); return () => abort.current?.abort(); }, [method]);

  const submit = (v = value) => { const x = v.trim(); if (x.length >= 3 && method) { onSubmit(method, x); setValue(''); } };
  const startNfc = async () => {
    abort.current?.abort();
    const ac = new AbortController(); abort.current = ac;
    setNfcErr(''); setNfcOn(true);
    try { const uid = await readNfcOnce(ac.signal); setNfcOn(false); submit(uid); }
    catch (e: any) { setNfcOn(false); if (e?.message !== 'cancelled') setNfcErr(e?.message || String(e)); }
  };
  const fs = big ? '1.6rem' : '1.2rem';

  if (!method) {
    return (
      <div className="grid g2" style={{ gap: big ? 16 : 8 }}>
        {IDENTIFY_METHODS.map((x) => (
          <button key={x.m} type="button" className="btn lg" style={{ flexDirection: 'column', padding: big ? '2rem 1rem' : '1rem', fontSize: big ? '1.5rem' : '1.05rem' }} onClick={() => setMethod(x.m)}>
            <span style={{ fontSize: big ? '3rem' : '1.8rem' }}>{x.icon}</span>{t(x.key, lang)}
          </button>
        ))}
      </div>
    );
  }
  const numeric = method === 'phone';
  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="row between"><b style={{ fontSize: fs }}>{IDENTIFY_METHODS.find((x) => x.m === method)!.icon} {t(IDENTIFY_METHODS.find((x) => x.m === method)!.key, lang)}</b>
        <button type="button" className="btn sm" onClick={() => setMethod(null)}>← {t('back', lang)}</button></div>
      {method === 'tap' && <div className="banner info center" style={{ fontSize: fs }}>💳 {t('tapHint', lang)}</div>}
      {method === 'barcode' && <div className="banner info center">{t('scanHint', lang)}</div>}
      <input ref={inputRef} className="in mono center" style={{ fontSize: big ? '2rem' : '1.4rem', letterSpacing: '.1em' }} autoFocus
        inputMode={numeric || method === 'card' ? 'numeric' : 'text'} type={method === 'tap' ? 'password' : 'text'} autoComplete="off"
        value={value} onChange={(e) => setValue(numeric ? e.target.value.replace(/\D/g, '').slice(0, 10) : e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(); } }} />
      {(method === 'phone' || method === 'card') && <Numpad onKey={(k) => setValue((v) => (k === '⌫' ? v.slice(0, -1) : (v + k).slice(0, 20)))} />}
      {method === 'barcode' && <button type="button" className="btn" onClick={() => setCamera(true)}>📷 {t('useCamera', lang)}</button>}
      {method === 'tap' && webNfcSupported && <button type="button" className="btn" disabled={nfcOn} onClick={startNfc}>📡 {nfcOn ? '…' : t('useNfc', lang)}</button>}
      {nfcErr && <div className="err small">{nfcErr}</div>}
      {(method === 'phone' || method === 'card') && <button type="button" className="btn primary lg" style={{ fontSize: fs }} disabled={value.trim().length < (numeric ? 9 : 3)} onClick={() => submit()}>{t('confirm', lang)}</button>}
      {camera && <CameraScanner onClose={() => setCamera(false)} onScan={(c) => { setCamera(false); submit(c); }} />}
    </div>
  );
}

export interface RegisterProfile {
  firstName: string; lastName: string; phone: string; email: string; birthday: string;
  gender: '' | 'male' | 'female' | 'other' | 'unspecified'; nationality: string; country: string; address: string;
}
export const emptyProfile = (): RegisterProfile => ({ firstName: '', lastName: '', phone: '', email: '', birthday: '', gender: '', nationality: 'ไทย', country: 'Thailand', address: '' });
export const COUNTRIES = ['Thailand', 'China', 'Myanmar', 'Laos', 'Cambodia', 'Vietnam', 'Malaysia', 'Singapore', 'Japan', 'South Korea', 'India', 'United States', 'United Kingdom', 'Other'];
export const NATIONALITIES = ['ไทย', 'จีน', 'เมียนมา', 'ลาว', 'กัมพูชา', 'เวียดนาม', 'มาเลเซีย', 'สิงคโปร์', 'ญี่ปุ่น', 'เกาหลีใต้', 'อินเดีย', 'อเมริกัน', 'อังกฤษ', 'อื่น ๆ'];

/** Member profile fields (registration at the till / customer display / website). */
export function ProfileFields({ v, set, lang, withIdentity = true, big = false }: { v: Partial<RegisterProfile>; set: (p: Partial<RegisterProfile>) => void; lang: Lang; withIdentity?: boolean; big?: boolean }) {
  const st = big ? { fontSize: '1.15rem', padding: '.75rem' } : undefined;
  return (
    <div className="grid g2">
      {withIdentity && <>
        <label className="f"><span>{t('firstName', lang)} *</span><input className="in" style={st} value={v.firstName ?? ''} onChange={(e) => set({ firstName: e.target.value })} /></label>
        <label className="f"><span>{t('lastName', lang)}</span><input className="in" style={st} value={v.lastName ?? ''} onChange={(e) => set({ lastName: e.target.value })} /></label>
        <label className="f"><span>{t('phone', lang)} *</span><input className="in" style={st} inputMode="tel" value={v.phone ?? ''} onChange={(e) => set({ phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} /></label>
        <label className="f"><span>{t('email', lang)}</span><input className="in" style={st} type="email" value={v.email ?? ''} onChange={(e) => set({ email: e.target.value })} /></label>
      </>}
      <label className="f"><span>{t('birthday', lang)}</span><input className="in" style={st} type="date" value={v.birthday ?? ''} onChange={(e) => set({ birthday: e.target.value })} /></label>
      <label className="f"><span>{t('gender', lang)}</span>
        <select className="in" style={st} value={v.gender ?? ''} onChange={(e) => set({ gender: e.target.value as any })}>
          <option value="">-</option>{(['male', 'female', 'other', 'unspecified'] as const).map((g) => <option key={g} value={g}>{t(g, lang)}</option>)}
        </select></label>
      <label className="f"><span>{t('nationality', lang)}</span><input className="in" style={st} list="ppm-nat" value={v.nationality ?? ''} onChange={(e) => set({ nationality: e.target.value })} /></label>
      <label className="f"><span>{t('country', lang)}</span><input className="in" style={st} list="ppm-country" value={v.country ?? ''} onChange={(e) => set({ country: e.target.value })} /></label>
      <label className="f" style={{ gridColumn: '1/-1' }}><span>{t('address', lang)}</span><textarea className="in" style={st} rows={2} value={v.address ?? ''} onChange={(e) => set({ address: e.target.value })} /></label>
      <datalist id="ppm-nat">{NATIONALITIES.map((x) => <option key={x} value={x} />)}</datalist>
      <datalist id="ppm-country">{COUNTRIES.map((x) => <option key={x} value={x} />)}</datalist>
    </div>
  );
}

export const genderLabel = (g: string | null | undefined, lang: Lang = 'th') => (g ? t(g, lang) : '-');
