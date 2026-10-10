import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { fmtMoney, fmtDate } from '../lib/format';
import { t, localName, type Lang } from '../lib/i18n';
import { applyAreaFonts } from '../lib/fonts';
import { BarcodeSvg, QrCanvas, errMsg, useToast, Modal } from '../components/ui';
import { ProfileFields, genderLabel, type RegisterProfile } from '../components/MemberForms';

const TOKEN = 'ppmart.member';
const PW_PROMPT = 'ppmart.member.pwPrompt';

export default function MemberPortal() {
  const toast = useToast();
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('ppmart.member.lang') as Lang) || 'th');
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN));
  const [info, setInfo] = useState<any>(null);
  const [me, setMe] = useState<any>(null);
  const [tab, setTab] = useState<'card' | 'coupons' | 'history' | 'benefits' | 'profile'>('card');
  // after the first login with the initial password: ask to change it, then ask for extra profile details
  const [step, setStep] = useState<null | 'askPw' | 'changePw' | 'profile'>(null);
  const [coupons, setCoupons] = useState<any[]>([]);
  const [history, setHistory] = useState<any>(null);
  const L = lang;
  const mApi = (p: string, body?: any, method?: string) => api(p, { body, token, method: method ?? (body ? 'POST' : 'GET') });
  const reloadMe = () => mApi('/api/member/me').then(setMe);

  useEffect(() => { localStorage.setItem('ppmart.member.lang', lang); }, [lang]);
  useEffect(() => { api('/api/member/info', { token: null }).then((i) => { setInfo(i); applyAreaFonts({ member: i.fonts?.member || 'Sarabun' }); }).catch(() => {}); }, []);
  useEffect(() => {
    if (!token) return;
    mApi('/api/member/me').then((m) => {
      setMe(m);
      if (!m.has_password && sessionStorage.getItem(PW_PROMPT) !== '0') setStep('askPw');
      else if (!m.profile_completed_at && sessionStorage.getItem(PW_PROMPT + '.profile') !== '0') setStep('profile');
    }).catch(() => { localStorage.removeItem(TOKEN); setToken(null); });
    mApi('/api/member/coupons').then(setCoupons).catch(() => {});
    mApi('/api/member/history').then(setHistory).catch(() => {});
  }, [token]); // eslint-disable-line

  const LangBar = () => (
    <div className="row" style={{ justifyContent: 'flex-end' }}>
      {(['th', 'en', 'zh'] as Lang[]).map((k) => <button key={k} className={`btn sm ${k === lang ? 'primary' : ''}`} onClick={() => setLang(k)}>{k === 'th' ? 'ไทย' : k === 'en' ? 'EN' : '中文'}</button>)}
    </div>
  );

  if (!token) return <div className="ms"><div className="ms-wrap"><LangBar /><Auth lang={L} info={info} onToken={(tk) => { localStorage.setItem(TOKEN, tk); setToken(tk); }} /></div></div>;
  if (!me) return <div className="ms"><div className="ms-wrap center muted">…</div></div>;

  const next = me.nextTier;
  const progress = next && Number(next.min_spend) > 0 ? Math.min(1, Number(me.total_spend) / Number(next.min_spend)) : 1;

  return (
    <div className="ms">
      <div className="ms-wrap grid" style={{ gap: '1rem' }}>
        <div className="row between"><b style={{ fontSize: '1.2rem' }}>{info?.store?.name}</b><LangBar /></div>
        <div className="mcard" style={{ background: `linear-gradient(135deg, ${me.tier_color || '#0f766e'}, #0f172a)` }}>
          <div className="row between"><div><div style={{ opacity: .8 }}>{t('card', L)}</div><div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{me.first_name} {me.last_name}</div></div><div style={{ fontSize: '1.3rem', fontWeight: 800 }}>{me.tier_name}</div></div>
          <div style={{ fontSize: '2.4rem', fontWeight: 800, margin: '.6rem 0' }}>{me.points.toLocaleString()} <span style={{ fontSize: '1rem' }}>{t('points', L)}</span></div>
          <div className="mono" style={{ opacity: .85 }}>{me.member_no}</div>
          {me.expiringPoints?.pts > 0 && <div className="small" style={{ marginTop: 6 }}>⚠ {t('pointsExpiring', L)}: {me.expiringPoints.pts} ({fmtDate(me.expiringPoints.at, false)})</div>}
        </div>
        {next && (
          <div className="card">
            <div className="row between small"><span>{t('nextTier', L)}: <b>{next.name}</b></span><span>{t('spendMore', L)} {fmtMoney(Math.max(0, Number(next.min_spend) - Number(me.total_spend)))}</span></div>
            <div style={{ background: '#e2e8f0', borderRadius: 8, height: 10, marginTop: 6 }}><div className="hbar" style={{ width: `${progress * 100}%` }} /></div>
          </div>
        )}
        <div className="tabs">
          {(['card', 'coupons', 'history', 'benefits', 'profile'] as const).map((k) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{t(k === 'card' ? 'card' : k, L)}</button>)}
        </div>
        {tab === 'card' && (
          <div className="card center grid">
            <BarcodeSvg value={me.member_no} height={70} />
            <QrCanvas value={me.member_no} size={160} />
            <div className="muted">{t('showAtCashier', L)}</div>
          </div>
        )}
        {tab === 'coupons' && (
          <div className="grid">
            {coupons.length === 0 && <div className="card center muted">{t('noData', L)}</div>}
            {coupons.map((c) => (
              <div key={c.id} className="card" style={{ opacity: c.status === 'ACTIVE' ? 1 : .55, borderLeft: '6px solid #7c3aed' }}>
                <div className="row between"><b>🎁 {c.rewardText}</b><span className={`badge ${c.status}`}>{c.status}</span></div>
                {c.minSpend > 0 && <div className="small muted">min {fmtMoney(c.minSpend)}</div>}
                {c.status === 'ACTIVE' && <div className="center"><BarcodeSvg value={c.barcodeValue} height={60} /></div>}
                <div className="small muted">{t('expires', L)} {fmtDate(c.expiresAt, false)}</div>
              </div>
            ))}
          </div>
        )}
        {tab === 'history' && (
          <div className="card">
            {(history?.sales ?? []).length === 0 && <div className="muted center">{t('noData', L)}</div>}
            {(history?.sales ?? []).map((s: any) => (
              <details key={s.id} style={{ borderBottom: '1px solid var(--line)', padding: '.5rem 0' }}>
                <summary className="row between" style={{ cursor: 'pointer' }}><span>{fmtDate(s.created_at)} · {s.branch_name}</span><b>{fmtMoney(s.total)}</b><span className="small ok">+{s.points_earned}</span></summary>
                <table className="t"><tbody>{(s.items ?? []).map((i: any, k: number) => <tr key={k}><td>{i.name}</td><td>{i.qty}</td><td className="right">{fmtMoney(i.total)}</td></tr>)}</tbody></table>
              </details>
            ))}
            <h3 style={{ marginTop: 12 }}>{t('points', L)}</h3>
            <table className="t"><tbody>{(history?.ledger ?? []).map((l: any, i: number) => <tr key={i}><td className="small">{fmtDate(l.created_at)}</td><td>{l.note}</td><td className={`right ${l.points > 0 ? 'ok' : 'err'}`}>{l.points > 0 ? '+' : ''}{l.points}</td></tr>)}</tbody></table>
          </div>
        )}
        {tab === 'benefits' && (
          <div className="grid">
            {(info?.tiers ?? []).map((tr: any) => (
              <div key={tr.id} className="card" style={{ borderLeft: `6px solid ${tr.color}`, background: tr.id === me.tier_id ? '#f0fdf4' : undefined }}>
                <div className="row between"><b>{tr.name}</b>{tr.id === me.tier_id && <span className="badge ok">✓</span>}</div>
                <div className="small">{tr.benefits}</div>
                <div className="xs muted">≥ {fmtMoney(Number(tr.min_spend))} · x{tr.point_multiplier} {Number(tr.discount_pct) > 0 ? `· -${tr.discount_pct}%` : ''}</div>
              </div>
            ))}
            <h3>{t('promo', L)}</h3>
            {(info?.promotions ?? []).map((p: any) => <div key={p.id} className="card"><b>{localName(p, L)}</b>{p.description && <div className="small muted">{p.description}</div>}</div>)}
          </div>
        )}
        {tab === 'profile' && (
          <div className="grid">
            <ProfileEditor lang={L} me={me} onSave={async (p) => { try { await mApi('/api/member/profile', p, 'PUT'); toast('✓', 'ok'); reloadMe(); } catch (e) { toast(errMsg(e), 'err'); } }} />
            <div className="card"><h3>{t('changePw', L)}</h3><ChangePassword lang={L} needCurrent={me.has_password} onDone={() => { toast('✓', 'ok'); reloadMe(); }} token={token} /></div>
          </div>
        )}
        {step === 'askPw' && (
          <Modal title={`🔐 ${t('changePwAsk', L)}`} width={460}
            footer={<><button className="btn" onClick={() => { sessionStorage.setItem(PW_PROMPT, '0'); setStep(me.profile_completed_at ? null : 'profile'); }}>{t('later', L)}</button><button className="btn primary" onClick={() => setStep('changePw')}>{t('changePw', L)}</button></>}>
            <p>{t('changePwWhy', L)}</p>
          </Modal>
        )}
        {step === 'changePw' && (
          <Modal title={`🔐 ${t('changePw', L)}`} width={460} onClose={() => setStep(me.profile_completed_at ? null : 'profile')}>
            <ChangePassword lang={L} needCurrent={false} token={token} onDone={() => { toast('✓', 'ok'); reloadMe(); setStep(me.profile_completed_at ? null : 'profile'); }} />
          </Modal>
        )}
        {step === 'profile' && (
          <Modal title={`📝 ${t('moreInfo', L)}`} width={640} onClose={() => { sessionStorage.setItem(PW_PROMPT + '.profile', '0'); setStep(null); }}>
            <ProfileEditor lang={L} me={me} onSave={async (p) => { try { await mApi('/api/member/profile', p, 'PUT'); reloadMe(); setStep(null); } catch (e) { toast(errMsg(e), 'err'); } }}
              onLater={() => { sessionStorage.setItem(PW_PROMPT + '.profile', '0'); setStep(null); }} />
          </Modal>
        )}
        <button className="btn" onClick={async () => { await mApi('/api/member/logout', {}).catch(() => {}); localStorage.removeItem(TOKEN); setToken(null); setMe(null); toast('ออกจากระบบแล้ว'); }}>{t('logout', L)}</button>
      </div>
    </div>
  );
}

function ProfileEditor({ lang: L, me, onSave, onLater }: { lang: Lang; me: any; onSave: (p: any) => void; onLater?: () => void }) {
  const [v, setV] = useState<Partial<RegisterProfile>>({ birthday: me.birthday ?? '', gender: me.gender ?? '', nationality: me.nationality ?? '', country: me.country ?? '', address: me.address ?? '', email: me.email ?? '' });
  return (
    <div className="card grid">
      <div className="small muted">{me.first_name} {me.last_name} · {me.phone} · {genderLabel(me.gender, L)}</div>
      <label className="f"><span>{t('email', L)}</span><input className="in" type="email" value={v.email ?? ''} onChange={(e) => setV({ ...v, email: e.target.value })} /></label>
      <ProfileFields lang={L} withIdentity={false} v={v} set={(p) => setV({ ...v, ...p })} />
      <div className="row">{onLater && <button className="btn" onClick={onLater}>{t('later', L)}</button>}<button className="btn primary" onClick={() => onSave({ ...v, gender: v.gender || null })}>{t('save', L)}</button></div>
    </div>
  );
}

function ChangePassword({ lang: L, needCurrent, token, onDone }: { lang: Lang; needCurrent: boolean; token: string | null; onDone: () => void }) {
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  return (
    <div className="grid">
      {needCurrent && <label className="f"><span>{t('currentPassword', L)}</span><input className="in" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></label>}
      <label className="f"><span>{t('newPassword', L)}</span><input className="in" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></label>
      <label className="f"><span>{t('confirmPassword', L)}</span><input className="in" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></label>
      {pw2 && pw !== pw2 && <div className="err small">{t('pwMismatch', L)}</div>}
      <button className="btn primary" disabled={pw.length < 6 || pw !== pw2} onClick={async () => {
        try { await api('/api/member/password', { body: { current: cur || undefined, password: pw }, token }); setCur(''); setPw(''); setPw2(''); onDone(); } catch (e) { toast(errMsg(e), 'err'); }
      }}>{t('changePw', L)}</button>
    </div>
  );
}

function PasswordLogin({ lang: L, onToken }: { lang: Lang; onToken: (t: string) => void }) {
  const toast = useToast();
  const [id, setId] = useState(() => new URLSearchParams(location.search).get('id') ?? '');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const login = async () => {
    setBusy(true);
    try { const r = await api('/api/member/login', { body: { identifier: id.trim(), password: pw }, token: null }); sessionStorage.removeItem(PW_PROMPT); sessionStorage.removeItem(PW_PROMPT + '.profile'); onToken(r.token); }
    catch (e) { toast(errMsg(e), 'err'); setPw(''); } finally { setBusy(false); }
  };
  return (
    <form className="grid" onSubmit={(e) => { e.preventDefault(); login(); }}>
      <label className="f"><span>{t('loginId', L)}</span><input className="in" value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" /></label>
      <label className="f"><span>{t('password', L)}</span><input className="in" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></label>
      <div className="banner info small">ℹ️ {t('firstPwHint', L)}</div>
      <button className="btn primary lg" disabled={busy || id.trim().length < 3 || pw.length < 4}>{t('login', L)}</button>
    </form>
  );
}

function Auth({ lang: L, info, onToken }: { lang: Lang; info: any; onToken: (t: string) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [how, setHow] = useState<'password' | 'otp'>('password');
  const [target, setTarget] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [profile, setProfile] = useState<any>({ firstName: '', lastName: '', phone: '', email: '', birthday: '', gender: '', nationality: 'ไทย', country: 'Thailand', address: '', lang: L });

  const send = async () => {
    setBusy(true);
    try {
      const tgt = mode === 'register' ? profile.phone : target;
      if (mode === 'register') setTarget(tgt);
      await api('/api/member/otp/request', { body: { target: tgt, purpose: mode, profile: mode === 'register' ? { ...profile, gender: profile.gender || null, lang: L } : undefined }, token: null });
      setSent(true);
      toast('ส่ง OTP แล้ว', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true);
    try { const r = await api('/api/member/otp/verify', { body: { target: mode === 'register' ? profile.phone : target, purpose: mode, code }, token: null }); onToken(r.token); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };

  return (
    <div className="card grid" style={{ marginTop: '2rem', gap: '1rem' }}>
      <div className="center"><div style={{ fontSize: '2.4rem' }}>🛒</div><h1>{info?.store?.name ?? 'PPMart'}</h1><div className="muted">{t('card', L)}</div></div>
      <div className="tabs" style={{ justifyContent: 'center' }}>
        <button className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setSent(false); }}>{t('login', L)}</button>
        <button className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setSent(false); }}>{t('register', L)}</button>
      </div>
      {mode === 'login' && how === 'password' ? (
        <>
          <PasswordLogin lang={L} onToken={onToken} />
          <button className="btn ghost" onClick={() => setHow('otp')}>{t('withOtp', L)}</button>
        </>
      ) : !sent ? (
        mode === 'login' ? (
          <>
            <label className="f"><span>{t('phoneOrEmail', L)}</span><input className="in" value={target} onChange={(e) => setTarget(e.target.value)} /></label>
            <button className="btn primary lg" disabled={busy || target.length < 5} onClick={send}>{t('sendOtp', L)}</button>
            <button className="btn ghost" onClick={() => setHow('password')}>{t('withPassword', L)}</button>
          </>
        ) : (
          <div className="grid">
            <ProfileFields lang={L} v={profile as any} set={(p) => setProfile({ ...profile, ...(p as any) })} />
            <button className="btn primary lg" style={{ alignSelf: 'end' }} disabled={busy || !profile.firstName || profile.phone.length < 9} onClick={send}>{t('sendOtp', L)}</button>
          </div>
        )
      ) : (
        <>
          <label className="f"><span>{t('otp', L)}</span><input className="in mono center" style={{ fontSize: '1.8rem', letterSpacing: '.4em' }} inputMode="numeric" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
          <button className="btn primary lg" disabled={busy || code.length !== 6} onClick={verify}>{t('verify', L)}</button>
          <button className="btn ghost" onClick={() => setSent(false)}>←</button>
        </>
      )}
      <p className="xs muted center">OTP 6 หลักใช้ได้ 5 นาที · จำกัดจำนวนครั้ง · ระบบไม่ใช้เบอร์โทรเพียงอย่างเดียวในการเข้าถึงข้อมูลส่วนตัว</p>
    </div>
  );
}
