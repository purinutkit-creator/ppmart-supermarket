import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { RealtimeClient } from '../lib/ws';
import { fmtMoney, fmtQty } from '../lib/format';
import { t, localName, type Lang } from '../lib/i18n';
import { applyAreaFonts, loadFont } from '../lib/fonts';
import { QrCanvas } from '../components/ui';

const KEY = 'ppmart.display';

export default function CustomerDisplay() {
  const [cred, setCred] = useState<{ displayId: string; displayToken: string } | null>(() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } });
  const [code, setCode] = useState<string | null>(null);
  const [cfg, setCfg] = useState<any>(null);
  const [lang, setLang] = useState<Lang | null>(() => (sessionStorage.getItem('ppmart.display.lang') as Lang) || null);
  const [state, setState] = useState<any>({ status: 'idle', lines: [] });
  const [connected, setConnected] = useState(false);
  const [slide, setSlide] = useState(0);
  const wsRef = useRef<RealtimeClient | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const thanksTimer = useRef<any>(null);

  // obtain a display identity + pairing code
  const requestPair = async () => {
    const r = await api('/api/display/pair-request', { body: { lang: lang ?? 'th', name: 'Customer Display ' + (navigator.platform || '') }, token: null });
    const c = { displayId: r.displayId, displayToken: r.displayToken };
    localStorage.setItem(KEY, JSON.stringify(c));
    setCred(c);
    setCode(r.code);
  };
  useEffect(() => { if (!cred) requestPair(); }, []); // eslint-disable-line

  const loadCfg = async () => {
    if (!cred) return;
    try {
      const c = await api(`/api/display/config?token=${encodeURIComponent(cred.displayToken)}`, { token: null });
      setCfg(c);
      applyAreaFonts({ display: c.display_settings?.font || c.fonts?.display || 'Kanit' });
      if (c.display_settings?.font) loadFont(c.display_settings.font);
    } catch (e: any) {
      if (e.status === 404) { localStorage.removeItem(KEY); setCred(null); requestPair(); }
    }
  };
  useEffect(() => { loadCfg(); }, [cred]); // eslint-disable-line

  useEffect(() => {
    if (!cred) return;
    const ws = new RealtimeClient(`display=${encodeURIComponent(cred.displayToken)}`);
    wsRef.current = ws;
    const offs = [
      ws.on('_status', (s) => setConnected(s.connected)),
      ws.on('_unauthorized', () => { localStorage.removeItem(KEY); setCred(null); requestPair(); }),
      ws.on('display.paired', () => { setCode(null); loadCfg(); }),
      ws.on('display.unpaired', () => { localStorage.removeItem(KEY); setCred(null); requestPair(); }),
      ws.on('display.state', (s) => {
        clearTimeout(thanksTimer.current);
        setState(s);
        if (s.status === 'paid') thanksTimer.current = setTimeout(() => setState({ status: 'idle', lines: [] }), (cfg?.display_settings?.thankYouSeconds ?? 8) * 1000);
      }),
    ];
    return () => { offs.forEach((f) => f()); ws.close(); };
  }, [cred]); // eslint-disable-line

  useEffect(() => { if (lang) { sessionStorage.setItem('ppmart.display.lang', lang); wsRef.current?.send('display.lang', { lang }); } }, [lang]);
  useEffect(() => { listRef.current?.scrollTo({ top: 1e6, behavior: 'smooth' }); }, [state.lines?.length, state.lastLineId]);

  const ds = cfg?.display_settings ?? {};
  const promos: any[] = cfg?.promotions ?? [];
  const images: string[] = (ds.promoImages ?? []).filter(Boolean);
  const slides = images.length ? images.map((src: string) => ({ src })) : promos.map((p) => ({ promo: p }));
  useEffect(() => {
    if (state.status !== 'idle' || slides.length < 2) return;
    const iv = setInterval(() => setSlide((s) => (s + 1) % slides.length), (ds.slideSeconds ?? 6) * 1000);
    return () => clearInterval(iv);
  }, [state.status, slides.length, ds.slideSeconds]);

  const fullscreen = () => document.documentElement.requestFullscreen?.().catch(() => {});
  const L: Lang = lang ?? 'th';
  const head = { background: ds.primaryColor || '#0f766e' };
  const bodyBg = ds.background ? { backgroundImage: `url(${ds.background})`, backgroundSize: 'cover' } : { background: ds.bgColor || '#f1f5f9' };

  // ----- pairing screen -----
  const paired = cfg?.display?.terminalId;
  if (!paired) {
    return (
      <div className="cd" style={{ ...bodyBg, alignItems: 'center', justifyContent: 'center', textAlign: 'center' }} onDoubleClick={fullscreen}>
        <div className="card" style={{ padding: '2.5rem', minWidth: 360 }}>
          <div style={{ fontSize: '2rem' }}>🖥️</div>
          <h2>{t('pairing', L)}</h2>
          <div className="mono" style={{ fontSize: '4.5rem', letterSpacing: '.25em', fontWeight: 800, color: '#0f766e' }}>{code ?? '······'}</div>
          <p className="muted">{t('pairHint', L)}</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={() => { localStorage.removeItem(KEY); setCred(null); requestPair(); }}>ขอรหัสใหม่</button>
            <button className="btn" onClick={fullscreen}>⛶ เต็มจอ</button>
          </div>
          <p className="xs muted"><span className={`dot ${connected ? 'on' : 'off'}`} /> {connected ? 'connected' : 'connecting…'}</p>
        </div>
      </div>
    );
  }

  // ----- language selection -----
  if (!lang) {
    return (
      <div className="cd" style={{ ...bodyBg, alignItems: 'center', justifyContent: 'center' }} onDoubleClick={fullscreen}>
        {cfg?.store?.logo && <img src={cfg.store.logo} style={{ height: 90, marginBottom: 20 }} />}
        <h1 style={{ fontSize: '2.4rem' }}>{cfg?.store?.name} · ยินดีต้อนรับ · Welcome · 欢迎</h1>
        <div className="row" style={{ gap: 20, marginTop: 30 }}>
          {([['th', '🇹🇭 ภาษาไทย'], ['en', '🇬🇧 English'], ['zh', '🇨🇳 中文']] as const).map(([k, l]) => (
            <button key={k} className="btn lg" style={{ fontSize: '1.8rem', padding: '1.5rem 2.5rem', borderRadius: 20 }} onClick={() => { setLang(k); fullscreen(); }}>{l}</button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="cd" style={bodyBg} onDoubleClick={fullscreen}>
      <div className="cd-head" style={head}>
        {cfg?.store?.logo && <img src={cfg.store.logo} />}
        <div style={{ fontSize: '1.7rem', fontWeight: 700 }}>{cfg?.store?.name}</div>
        <div className="spacer" />
        {state.member && <div style={{ background: 'rgba(255,255,255,.18)', padding: '.4rem .9rem', borderRadius: 999 }}>👤 {t('member', L)}: {state.member.name} {state.member.tier ? `· ${state.member.tier}` : ''}</div>}
        <div className="row">{(['th', 'en', 'zh'] as Lang[]).map((k) => <button key={k} className="btn sm" style={{ opacity: k === L ? 1 : .6 }} onClick={() => setLang(k)}>{k.toUpperCase()}</button>)}</div>
        <span className={`dot ${connected ? 'on' : 'off'}`} />
      </div>

      {state.status === 'idle' ? (
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {slides.length === 0 && <div className="center" style={{ paddingTop: '20vh', fontSize: '3rem', fontWeight: 700 }}>{t('welcome', L)}</div>}
          {slides.map((s: any, i: number) => (
            <div key={i} className="cd-slide" style={{ opacity: i === slide ? 1 : 0, backgroundImage: s.src || s.promo?.image_url ? `url(${s.src || s.promo.image_url})` : undefined, display: 'flex', alignItems: 'flex-end' }}>
              {s.promo && (
                <div style={{ margin: '3rem', background: 'rgba(255,255,255,.94)', borderRadius: 24, padding: '2rem 2.5rem', maxWidth: 900, borderLeft: `10px solid ${ds.accentColor || '#f59e0b'}` }}>
                  <div className="muted" style={{ fontSize: '1.2rem' }}>{t('promo', L)}</div>
                  <div style={{ fontSize: '3rem', fontWeight: 700 }}>{localName(s.promo, L)}</div>
                  {s.promo.description && <div style={{ fontSize: '1.4rem' }}>{s.promo.description}</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : state.status === 'paid' ? (
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', textAlign: 'center' }}>
          <div className="card" style={{ padding: '3rem 4rem' }}>
            <div style={{ fontSize: '4rem' }}>🙏</div>
            <div style={{ fontSize: '3rem', fontWeight: 700 }}>{t('thankYou', L)}</div>
            <div style={{ fontSize: '1.6rem', marginTop: 10 }}>{t('total', L)} {fmtMoney(state.total)}</div>
            {state.change > 0 && <div style={{ fontSize: '3.4rem', fontWeight: 800, color: '#16a34a' }}>{t('change', L)} {fmtMoney(state.change)}</div>}
            {state.pointsEarned > 0 && <div style={{ fontSize: '1.5rem' }}>⭐ +{state.pointsEarned} {t('points', L)}</div>}
            {state.coupons?.length > 0 && <div style={{ fontSize: '1.4rem', marginTop: 10, color: '#7c3aed' }}>🎁 {t('couponGot', L)}: {state.coupons.map((c: any) => c.rewardText).join(', ')}</div>}
            <div className="muted" style={{ marginTop: 10 }}>{t('seeYou', L)}</div>
          </div>
        </div>
      ) : (
        <div className="cd-body">
          <div className="cd-list" ref={listRef}>
            <div className="cd-line" style={{ fontSize: '1rem', color: '#64748b' }}><span>{t('item', L)}</span><span>{t('qty', L)}</span><span>{t('price', L)}</span></div>
            {state.lines.map((l: any) => (
              <div key={l.id} className={`cd-line ${l.id === state.lastLineId ? 'flash' : ''}`}>
                <div>{localName(l, L)}{l.discount > 0 && <div style={{ fontSize: '1rem', color: '#dc2626' }}>{t('discount', L)} -{fmtMoney(l.discount)}</div>}</div>
                <div className="num">{fmtQty(l.qty, l.isWeighted)}{l.isWeighted ? ' kg' : ''}</div>
                <div className="num right" style={{ fontWeight: 600 }}>{fmtMoney(l.total)}</div>
              </div>
            ))}
          </div>
          <div className="cd-total">
            <div className="row between" style={{ fontSize: '1.4rem' }}><span>{t('subtotal', L)} ({fmtQty(state.itemsCount ?? 0)} {t('items', L)})</span><span className="num">{fmtMoney(state.subtotal ?? 0)}</span></div>
            {state.discount > 0 && <div className="row between" style={{ fontSize: '1.4rem', color: '#dc2626' }}><span>{t('discount', L)}</span><span className="num">-{fmtMoney(state.discount)}</span></div>}
            <div style={{ fontSize: '1.5rem', marginTop: 8 }}>{t('total', L)}</div>
            <div className="big num" style={{ color: ds.primaryColor || '#0f766e' }}>{fmtMoney(state.status === 'payment' ? state.payment?.amount ?? state.total : state.total)}</div>
            {state.pointsToEarn > 0 && <div style={{ fontSize: '1.3rem' }}>⭐ {t('pointsEarn', L)}: +{state.pointsToEarn}</div>}
            {state.status === 'payment' && state.payment && (
              <div style={{ marginTop: 10, textAlign: 'center' }}>
                {state.payment.qrPayload && <><div style={{ fontSize: '1.4rem', fontWeight: 600 }}>{t('scanToPay', L)}</div><QrCanvas value={state.payment.qrPayload} size={260} /><div className="muted">PromptPay</div></>}
                {state.payment.qrImageUrl && <img src={state.payment.qrImageUrl} style={{ width: 260 }} />}
                {state.payment.method === 'cash' && state.payment.received > 0 && (
                  <div style={{ fontSize: '1.6rem' }}>
                    <div className="row between"><span>{t('received', L)}</span><span className="num">{fmtMoney(state.payment.received)}</span></div>
                    <div className="row between" style={{ fontWeight: 800, color: '#16a34a', fontSize: '2.2rem' }}><span>{t('change', L)}</span><span className="num">{fmtMoney(state.payment.change)}</span></div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
