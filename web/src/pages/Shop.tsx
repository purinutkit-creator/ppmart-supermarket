// Online ordering website: catalog, product page (gallery, sizes, size chart), cart, checkout and order tracking.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Routes, Route, Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Modal, QrCanvas, useToast, errMsg } from '../components/ui';
import { fmtMoney, fmtQty, fmtDate, uuid } from '../lib/format';
import { applyAreaFonts } from '../lib/fonts';

const CART = 'ppmart.shop.cart';
const ORDERS = 'ppmart.shop.orders';
const MEMBER = 'ppmart.member'; // shared with the member website

type CartLine = { productId: number; qty: number; name: string; label?: string | null; price: number; image?: string | null; parentId: number; isWeighted?: boolean };
const read = <T,>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k) || '') ?? d; } catch { return d; } };
const imgSrc = (p: { imageIds?: number[]; imageUrl?: string | null }) => (p.imageIds?.length ? `/api/shop/images/${p.imageIds[0]}` : p.imageUrl || null);
const STATUS: Record<string, string> = {
  pending_payment: 'รอชำระเงิน', paid: 'ชำระเงินแล้ว', preparing: 'กำลังจัดเตรียม', ready: 'พร้อมรับสินค้า', shipped: 'จัดส่งแล้ว', completed: 'สำเร็จ', cancelled: 'ยกเลิก',
};
const PAY: Record<string, string> = { promptpay: 'พร้อมเพย์ (QR)', pay_at_store: 'ชำระที่ร้านตอนรับสินค้า', cod: 'เก็บเงินปลายทาง' };

function useShopState() {
  const [cart, setCart] = useState<CartLine[]>(() => read(CART, []));
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(MEMBER));
  useEffect(() => { localStorage.setItem(CART, JSON.stringify(cart)); }, [cart]);
  useEffect(() => {
    const h = (e: StorageEvent) => { if (e.key === CART) setCart(read(CART, [])); if (e.key === MEMBER) setToken(localStorage.getItem(MEMBER)); };
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  }, []);
  const add = useCallback((l: CartLine) => setCart((c) => {
    const i = c.findIndex((x) => x.productId === l.productId);
    if (i < 0) return [...c, l];
    const n = [...c]; n[i] = { ...n[i], qty: +(n[i].qty + l.qty).toFixed(3) }; return n;
  }), []);
  const login = (t: string | null) => { if (t) localStorage.setItem(MEMBER, t); else localStorage.removeItem(MEMBER); setToken(t); };
  return { cart, setCart, add, token, login };
}
type ShopState = ReturnType<typeof useShopState>;

export default function Shop() {
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const st = useShopState();
  const [me, setMe] = useState<any>(null);
  useEffect(() => {
    api('/api/shop/info', { token: null }).then((i) => {
      setInfo(i);
      applyAreaFonts({ member: i.fonts?.member || 'Sarabun' });
      document.title = `${i.shop.title} · ${i.store.name}`;
    }).catch((e) => setErr(errMsg(e)));
  }, []);
  useEffect(() => {
    if (!st.token) { setMe(null); return; }
    api('/api/member/me', { token: st.token }).then(setMe).catch(() => st.login(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.token]);
  const count = st.cart.reduce((a, l) => a + (l.isWeighted ? 1 : l.qty), 0);
  const brand = info?.display?.primaryColor || '#0f766e';

  if (err) return <div className="shop"><div className="shop-wrap center" style={{ padding: '4rem 1rem' }}>{err}</div></div>;
  if (!info) return <div className="shop"><div className="center muted" style={{ padding: '4rem' }}>กำลังโหลด…</div></div>;
  return (
    <div className="shop" style={{ ['--shop' as any]: brand }}>
      <header className="shop-top">
        <div className="shop-wrap row between" style={{ flexWrap: 'nowrap' }}>
          <Link to="/shop" className="shop-logo">{info.store.logo ? <img src={info.store.logo} alt="" /> : '🛒'}<span><b>{info.store.name}</b><small>{info.shop.title}</small></span></Link>
          <nav className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <Link to="/shop/orders" className="shop-ic" title="คำสั่งซื้อของฉัน">📦<span className="hide-sm"> คำสั่งซื้อ</span></Link>
            {me ? <Link to="/member" className="shop-ic" title="บัญชีสมาชิก">👤<span className="hide-sm"> {me.firstName ?? me.first_name ?? 'สมาชิก'}</span></Link> : <Link to="/shop/login" className="shop-ic">👤<span className="hide-sm"> สมาชิก</span></Link>}
            <Link to="/shop/cart" className="shop-ic cart">🛍️<span className="hide-sm"> ตะกร้า</span>{count > 0 && <b className="shop-count">{fmtQty(count)}</b>}</Link>
          </nav>
        </div>
      </header>
      {info.shop.announcement && <div className="shop-ann">{info.shop.announcement}</div>}
      {!info.shop.enabled && <div className="shop-ann warn">ร้านค้าออนไลน์ปิดรับคำสั่งซื้อชั่วคราว</div>}
      <main className="shop-wrap">
        <Routes>
          <Route index element={<Catalog info={info} />} />
          <Route path="p/:id" element={<ProductPage st={st} />} />
          <Route path="cart" element={<CartPage st={st} info={info} />} />
          <Route path="checkout" element={<Checkout st={st} info={info} me={me} />} />
          <Route path="login" element={<MemberLogin st={st} />} />
          <Route path="order/:orderNo" element={<OrderPage st={st} />} />
          <Route path="orders" element={<MyOrders st={st} />} />
        </Routes>
      </main>
      <footer className="shop-foot"><div className="shop-wrap small muted">{info.store.name}{info.branch?.address ? ` · ${info.branch.address}` : ''}{info.store.phone ? ` · โทร ${info.store.phone}` : ''}</div></footer>
    </div>
  );
}

function Price({ p }: { p: any }) {
  if (p.hasSizes && p.maxPrice !== p.price) return <>{fmtMoney(p.price)} – {fmtMoney(p.maxPrice)}</>;
  return <>{fmtMoney(p.price)}{p.isWeighted ? <small>/กก.</small> : null}</>;
}

function Catalog({ info }: { info: any }) {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const cat = sp.get('c') ?? '';
  const sort = sp.get('s') ?? '';
  const [term, setTerm] = useState(q);
  const [items, setItems] = useState<any[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = async (offset: number) => {
    setLoading(true);
    try {
      const r = await api(`/api/shop/products?q=${encodeURIComponent(q)}&category=${cat}&sort=${sort}&offset=${offset}&limit=48`, { token: null });
      setItems((x) => (offset ? [...x, ...r.items] : r.items)); setMore(r.hasMore);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(0); /* eslint-disable-next-line */ }, [q, cat, sort]);
  useEffect(() => { const t = setTimeout(() => { if (term !== q) setSp((s) => { const n = new URLSearchParams(s); term ? n.set('q', term) : n.delete('q'); return n; }, { replace: true }); }, 350); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [term]);
  const setParam = (k: string, v: string) => setSp((s) => { const n = new URLSearchParams(s); v ? n.set(k, v) : n.delete(k); return n; });
  return (
    <>
      <div className="shop-search row">
        <input className="in" placeholder="ค้นหาสินค้า…" value={term} onChange={(e) => setTerm(e.target.value)} />
        <select className="in" style={{ width: 150 }} value={sort} onChange={(e) => setParam('s', e.target.value)}>
          <option value="">เรียงตามชื่อ</option><option value="new">มาใหม่</option><option value="price_asc">ราคาต่ำ → สูง</option><option value="price_desc">ราคาสูง → ต่ำ</option>
        </select>
      </div>
      <div className="shop-cats">
        <button className={!cat ? 'on' : ''} onClick={() => setParam('c', '')}>ทั้งหมด</button>
        {info.categories.map((c: any) => <button key={c.id} className={cat === String(c.id) ? 'on' : ''} onClick={() => setParam('c', String(c.id))}>{c.name} <small>{c.count}</small></button>)}
      </div>
      <div className="shop-grid">
        {items.map((p) => (
          <Link key={p.id} to={`/shop/p/${p.id}`} className={`shop-card ${p.available ? '' : 'out'}`}>
            <div className="ph">{imgSrc(p) ? <img src={imgSrc(p)!} alt={p.name} loading="lazy" /> : <span>🛒</span>}{!p.available && <em>สินค้าหมด</em>}</div>
            <div className="nm">{p.name}</div>
            <div className="pr"><Price p={p} /></div>
            {p.memberPrice != null && p.memberPrice < p.price && <div className="mp">สมาชิก {fmtMoney(p.memberPrice)}</div>}
            {p.hasSizes && <div className="xs muted">มีหลายไซส์</div>}
          </Link>
        ))}
      </div>
      {!loading && !items.length && <div className="center muted" style={{ padding: '3rem' }}>ไม่พบสินค้า</div>}
      {more && <div className="center" style={{ margin: 16 }}><button className="btn" disabled={loading} onClick={() => load(items.length)}>{loading ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}</button></div>}
    </>
  );
}

function Gallery({ ids, fallback, name }: { ids: number[]; fallback?: string | null; name: string }) {
  const [i, setI] = useState(0);
  const touch = useRef<number | null>(null);
  const srcs = ids.length ? ids.map((id) => `/api/shop/images/${id}`) : fallback ? [fallback] : [];
  useEffect(() => setI(0), [ids.join(',')]);
  if (!srcs.length) return <div className="shop-gal"><div className="main empty">🛒</div></div>;
  const go = (d: number) => setI((x) => (x + d + srcs.length) % srcs.length);
  return (
    <div className="shop-gal">
      <div className="main" onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => { if (touch.current == null) return; const dx = e.changedTouches[0].clientX - touch.current; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); touch.current = null; }}>
        <img src={srcs[i]} alt={name} />
        {srcs.length > 1 && <><button className="nav l" onClick={() => go(-1)} aria-label="ก่อนหน้า">‹</button><button className="nav r" onClick={() => go(1)} aria-label="ถัดไป">›</button><span className="cnt">{i + 1}/{srcs.length}</span></>}
      </div>
      {srcs.length > 1 && <div className="thumbs">{srcs.map((s, k) => <button key={k} className={k === i ? 'on' : ''} onClick={() => setI(k)}><img src={s} alt="" loading="lazy" /></button>)}</div>}
    </div>
  );
}

export function SizeChartTable({ chart }: { chart: { columns: string[]; rows: string[][]; note?: string | null } }) {
  return (
    <div>
      <div className="table-wrap"><table className="t size-chart">
        <thead><tr>{chart.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>{chart.rows.map((r, i) => <tr key={i}>{chart.columns.map((_, j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>)}</tbody>
      </table></div>
      {chart.note && <p className="small muted">{chart.note}</p>}
    </div>
  );
}

function ProductPage({ st }: { st: ShopState }) {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [p, setP] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [chart, setChart] = useState(false);
  useEffect(() => { setP(null); setSize(null); setQty(1); api(`/api/shop/products/${id}`, { token: null }).then(setP).catch((e) => setErr(errMsg(e))); }, [id]);
  if (err) return <div className="center muted" style={{ padding: '3rem' }}>{err} · <Link to="/shop">กลับหน้าร้าน</Link></div>;
  if (!p) return <div className="center muted" style={{ padding: '3rem' }}>กำลังโหลด…</div>;
  const v = p.variants.find((x: any) => x.id === size);
  const price = v ? v.price : p.price;
  const memberPrice = v ? v.memberPrice : p.memberPrice;
  const stock = v ? v.stock : p.hasSizes ? null : p.stock;
  const available = p.hasSizes ? (v ? v.available : p.available) : p.available;
  const step = p.isWeighted ? 0.1 : 1;
  const inCart = st.cart.find((l) => l.productId === (v?.id ?? p.id))?.qty ?? 0;
  const max = stock == null ? 999 : Math.max(0, stock - inCart);
  const addToCart = (go: boolean) => {
    if (p.hasSizes && !v) { toast('กรุณาเลือกไซส์', 'warn'); return; }
    if (qty > max) { toast(stock != null ? `เหลือสินค้า ${fmtQty(stock)} ชิ้น` : 'จำนวนไม่ถูกต้อง', 'warn'); return; }
    st.add({ productId: v?.id ?? p.id, parentId: p.id, qty, name: p.name, label: v?.label ?? null, price, image: imgSrc(p), isWeighted: p.isWeighted });
    toast(`เพิ่ม ${p.name}${v ? ` (${v.label})` : ''} ลงตะกร้าแล้ว`, 'ok');
    if (go) nav('/shop/cart');
  };
  return (
    <div className="shop-product">
      <Gallery ids={p.imageIds} fallback={p.imageUrl} name={p.name} />
      <div className="info">
        <div className="xs muted"><Link to="/shop">หน้าร้าน</Link>{p.categoryName && <> › <Link to={`/shop?c=${p.categoryId}`}>{p.categoryName}</Link></>}</div>
        <h1>{p.name}</h1>
        {p.nameEn && <div className="muted">{p.nameEn}</div>}
        <div className="price">{v || !p.hasSizes ? <>{fmtMoney(price)}{p.isWeighted && <small>/กก.</small>}</> : <Price p={p} />}</div>
        {memberPrice != null && memberPrice < price && <div className="mp">ราคาสมาชิก {fmtMoney(memberPrice)} {!st.token && <Link to="/shop/login" className="small">เข้าสู่ระบบ</Link>}</div>}
        {p.hasSizes && (
          <div className="sizes">
            <div className="row between"><b>เลือกไซส์</b>{p.sizeChart && <button className="link" onClick={() => setChart(true)}>📏 ตารางไซส์</button>}</div>
            <div className="row" style={{ gap: 8 }}>
              {p.variants.map((x: any) => (
                <button key={x.id} className={`size ${size === x.id ? 'on' : ''}`} disabled={!x.available} onClick={() => { setSize(x.id); setQty(1); }} title={x.available ? '' : 'สินค้าหมด'}>{x.label}</button>
              ))}
            </div>
          </div>
        )}
        {!p.hasSizes && p.sizeChart && <button className="link" onClick={() => setChart(true)}>📏 ตารางไซส์</button>}
        <div className="small" style={{ margin: '8px 0' }}>
          {!available ? <span className="err">สินค้าหมด</span> : stock != null ? <span className={stock <= 5 ? 'warn' : 'ok'}>{stock <= 5 ? `เหลือเพียง ${fmtQty(stock)} ชิ้น` : 'มีสินค้า'}</span> : null}
        </div>
        <div className="row" style={{ gap: 8 }}>
          <div className="qty">
            <button onClick={() => setQty((q) => Math.max(step, +(q - step).toFixed(3)))}>−</button>
            <input inputMode="decimal" value={qty} onChange={(e) => { const n = Number(e.target.value); if (n >= 0) setQty(p.isWeighted ? n : Math.floor(n)); }} />
            <button onClick={() => setQty((q) => +(q + step).toFixed(3))}>+</button>
          </div>
          {p.isWeighted && <span className="small muted">กก.</span>}
        </div>
        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <button className="btn lg" disabled={!available || qty <= 0} onClick={() => addToCart(false)}>ใส่ตะกร้า</button>
          <button className="btn lg primary shop-btn" disabled={!available || qty <= 0} onClick={() => addToCart(true)}>ซื้อเลย</button>
        </div>
        {p.description && <div className="desc"><h3>รายละเอียดสินค้า</h3><p>{p.description}</p></div>}
        {p.sizeChart && p.hasSizes && <div className="desc"><h3>ตารางไซส์</h3><SizeChartTable chart={p.sizeChart} /></div>}
      </div>
      {chart && p.sizeChart && <Modal title="📏 ตารางไซส์" onClose={() => setChart(false)} width={640}><SizeChartTable chart={p.sizeChart} /></Modal>}
    </div>
  );
}

function useQuote(st: ShopState, fulfillment: 'pickup' | 'delivery') {
  const [quote, setQuote] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const key = JSON.stringify(st.cart.map((l) => [l.productId, l.qty])) + fulfillment + (st.token ?? '');
  useEffect(() => {
    if (!st.cart.length) { setQuote(null); return; }
    const ctrl = new AbortController();
    api('/api/shop/quote', { body: { items: st.cart.map((l) => ({ productId: l.productId, qty: l.qty })), fulfillment }, token: st.token, signal: ctrl.signal })
      .then((q) => { setQuote(q); setErr(null); }).catch((e) => { if (e.code !== 'NETWORK') { setErr(e); setQuote(null); } });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { quote, err };
}

function Totals({ quote, fulfillment }: { quote: any; fulfillment: string }) {
  if (!quote) return null;
  return (
    <div className="shop-totals">
      <div className="row between"><span>ราคาสินค้า</span><span>{fmtMoney(quote.subtotal)}</span></div>
      {quote.applied?.map((d: any, i: number) => <div key={i} className="row between ok small"><span>{d.name}</span><span>−{fmtMoney(d.amount)}</span></div>)}
      {fulfillment === 'delivery' && <div className="row between"><span>ค่าจัดส่ง</span><span>{quote.shipping ? `${fmtMoney(quote.shipping)}` : 'ฟรี'}</span></div>}
      <div className="row between total"><b>ยอดรวม</b><b>{fmtMoney(quote.total)}</b></div>
    </div>
  );
}

function CartPage({ st, info }: { st: ShopState; info: any }) {
  const nav = useNavigate();
  const { quote, err } = useQuote(st, 'pickup');
  const stockOf = (id: number) => quote?.lines.find((l: any) => l.productId === id)?.stock ?? null;
  const setQty = (i: number, qty: number) => { const c = [...st.cart]; if (qty <= 0) c.splice(i, 1); else c[i] = { ...c[i], qty }; st.setCart(c); };
  if (!st.cart.length) return <div className="center" style={{ padding: '3rem' }}><p className="muted">ตะกร้าว่าง</p><Link className="btn primary shop-btn" to="/shop">เลือกซื้อสินค้า</Link></div>;
  const badId = err?.details?.productId;
  const over = st.cart.some((l) => { const s = stockOf(l.productId); return s != null && l.qty > s; });
  const minOk = !info.shop.minOrder || (quote && quote.total >= info.shop.minOrder);
  return (
    <div className="shop-cart">
      <h2>ตะกร้าสินค้า</h2>
      {st.cart.map((l, i) => {
        const s = stockOf(l.productId);
        return (
          <div key={l.productId} className={`line ${badId === l.productId ? 'bad' : ''}`}>
            <Link to={`/shop/p/${l.parentId}`} className="ph">{l.image ? <img src={l.image} alt="" /> : '🛒'}</Link>
            <div className="grow">
              <div>{l.name}{l.label && <span className="badge" style={{ marginLeft: 6 }}>ไซส์ {l.label}</span>}</div>
              <div className="small muted">{fmtMoney(l.price)}{l.isWeighted ? '/กก.' : ''}</div>
              {s != null && l.qty > s && <div className="small err">เหลือเพียง {fmtQty(s)}</div>}
              {badId === l.productId && <div className="small err">{err.message}</div>}
            </div>
            <div className="qty sm">
              <button onClick={() => setQty(i, +(l.qty - (l.isWeighted ? 0.1 : 1)).toFixed(3))}>−</button>
              <span>{fmtQty(l.qty)}</span>
              <button onClick={() => setQty(i, +(l.qty + (l.isWeighted ? 0.1 : 1)).toFixed(3))}>+</button>
            </div>
            <button className="btn sm ghost" onClick={() => setQty(i, 0)} aria-label="ลบ">✕</button>
          </div>
        );
      })}
      {err && !badId && <div className="err small">{err.message}</div>}
      <Totals quote={quote} fulfillment="pickup" />
      {!minOk && <div className="warn small">ยอดสั่งซื้อขั้นต่ำ {fmtMoney(info.shop.minOrder)}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <Link to="/shop" className="btn">เลือกซื้อต่อ</Link><span className="spacer" />
        <button className="btn primary lg shop-btn" disabled={!quote || over || !minOk || !info.shop.enabled} onClick={() => nav('/shop/checkout')}>ดำเนินการสั่งซื้อ</button>
      </div>
    </div>
  );
}

function Checkout({ st, info, me }: { st: ShopState; info: any; me: any }) {
  const nav = useNavigate();
  const toast = useToast();
  const s = info.shop;
  const [f, setF] = useState<'pickup' | 'delivery'>(s.pickup ? 'pickup' : 'delivery');
  const methods = useMemo(() => (['promptpay', 'pay_at_store', 'cod'] as const).filter((m) =>
    (m === 'promptpay' && s.payments.promptpay) || (m === 'pay_at_store' && s.payments.payAtStore && f === 'pickup') || (m === 'cod' && s.payments.cod && f === 'delivery')), [f, s]);
  const [pm, setPm] = useState<string>('');
  const [c, setC] = useState(() => read('ppmart.shop.customer', { name: '', phone: '', email: '', address: '' }));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const { quote, err } = useQuote(st, f);
  useEffect(() => { if (!methods.includes(pm as any)) setPm(methods[0] ?? ''); }, [methods, pm]);
  useEffect(() => {
    if (me && !c.name) setC((x: any) => ({ ...x, name: [me.firstName ?? me.first_name, me.lastName ?? me.last_name].filter(Boolean).join(' '), phone: me.phone ?? x.phone, email: me.email ?? x.email, address: x.address || me.address || '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);
  if (!st.cart.length) return <div className="center" style={{ padding: '3rem' }}><Link to="/shop">กลับหน้าร้าน</Link></div>;
  const submit = async () => {
    if (!c.name.trim() || !/^[0-9+\-\s]{9,15}$/.test(c.phone.trim())) { toast('กรุณากรอกชื่อและเบอร์โทรให้ถูกต้อง', 'warn'); return; }
    if (f === 'delivery' && c.address.trim().length <= 10) { toast('กรุณากรอกที่อยู่จัดส่งให้ครบถ้วน', 'warn'); return; }
    if (!pm) { toast('กรุณาเลือกวิธีชำระเงิน', 'warn'); return; }
    // same key across retries of this cart, so a double tap / network retry never creates two orders
    let key = sessionStorage.getItem('ppmart.shop.idem');
    if (!key) { key = uuid(); sessionStorage.setItem('ppmart.shop.idem', key); }
    setBusy(true);
    try {
      localStorage.setItem('ppmart.shop.customer', JSON.stringify(c));
      const r = await api('/api/shop/orders', {
        token: st.token, timeoutMs: 30000,
        body: { idempotencyKey: key, items: st.cart.map((l) => ({ productId: l.productId, qty: l.qty })), customer: { name: c.name, phone: c.phone, email: c.email || null }, fulfillment: f, address: f === 'delivery' ? c.address : null, note: note || null, paymentMethod: pm },
      });
      sessionStorage.removeItem('ppmart.shop.idem');
      localStorage.setItem(ORDERS, JSON.stringify([{ orderNo: r.orderNo, t: r.accessToken, at: Date.now() }, ...read<any[]>(ORDERS, [])].slice(0, 50)));
      st.setCart([]);
      nav(`/shop/order/${r.orderNo}?t=${r.accessToken}`, { replace: true });
    } catch (e: any) {
      if (e.code === 'DUPLICATE_ORDER') { sessionStorage.removeItem('ppmart.shop.idem'); st.setCart([]); nav('/shop/orders'); return; }
      if (e.status && e.status < 500) sessionStorage.removeItem('ppmart.shop.idem');
      toast(errMsg(e), 'err');
    } finally { setBusy(false); }
  };
  return (
    <div className="shop-checkout">
      <h2>ชำระเงิน</h2>
      {!st.token && <div className="card small">เป็นสมาชิก? <Link to="/shop/login?next=/shop/checkout">เข้าสู่ระบบ</Link> เพื่อรับราคาสมาชิกและสะสมคะแนน</div>}
      {me && <div className="card small ok">👤 สั่งซื้อในนาม {[me.firstName ?? me.first_name, me.lastName ?? me.last_name].filter(Boolean).join(' ')} · ได้รับราคาสมาชิกและคะแนนสะสม</div>}
      <section>
        <h3>การรับสินค้า</h3>
        <div className="opt-row">
          {s.pickup && <label className={`opt ${f === 'pickup' ? 'on' : ''}`}><input type="radio" checked={f === 'pickup'} onChange={() => setF('pickup')} /><b>🏪 รับที่ร้าน</b><small>{info.branch?.name}{info.branch?.address ? ` · ${info.branch.address}` : ''}</small></label>}
          {s.delivery && <label className={`opt ${f === 'delivery' ? 'on' : ''}`}><input type="radio" checked={f === 'delivery'} onChange={() => setF('delivery')} /><b>🚚 จัดส่ง</b><small>ค่าส่ง {fmtMoney(s.deliveryFee)}{s.freeDeliveryMin ? ` · ฟรีเมื่อซื้อครบ ${fmtMoney(s.freeDeliveryMin)}` : ''}</small></label>}
        </div>
      </section>
      <section className="grid" style={{ gap: 8 }}>
        <h3>ข้อมูลผู้สั่งซื้อ</h3>
        <input className="in" placeholder="ชื่อ-นามสกุล *" autoComplete="name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
        <input className="in" placeholder="เบอร์โทรศัพท์ *" inputMode="tel" autoComplete="tel" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} />
        <input className="in" placeholder="อีเมล (ไม่บังคับ)" type="email" autoComplete="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} />
        {f === 'delivery' && <textarea className="in" rows={3} placeholder="ที่อยู่จัดส่ง (บ้านเลขที่ ถนน ตำบล อำเภอ จังหวัด รหัสไปรษณีย์) *" autoComplete="street-address" value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} />}
        <input className="in" placeholder="หมายเหตุถึงร้าน (ไม่บังคับ)" value={note} onChange={(e) => setNote(e.target.value)} />
      </section>
      <section>
        <h3>วิธีชำระเงิน</h3>
        <div className="opt-row">{methods.map((m) => <label key={m} className={`opt ${pm === m ? 'on' : ''}`}><input type="radio" checked={pm === m} onChange={() => setPm(m)} /><b>{PAY[m]}</b>{m === 'promptpay' && <small>สแกน QR ชำระภายใน {s.paymentTimeoutMinutes} นาที</small>}</label>)}</div>
        {!methods.length && <div className="err small">ไม่มีวิธีชำระเงินสำหรับการรับสินค้าแบบนี้</div>}
      </section>
      <section>
        <h3>สรุปรายการ</h3>
        {quote?.lines.map((l: any) => <div key={l.productId} className="row between small"><span>{l.name} × {fmtQty(l.qty)}</span><span>{fmtMoney(l.total)}</span></div>)}
        {err && <div className="err small">{err.message} — <Link to="/shop/cart">แก้ไขตะกร้า</Link></div>}
        <Totals quote={quote} fulfillment={f} />
      </section>
      <button className="btn primary lg shop-btn block" disabled={busy || !quote || !pm || !s.enabled} onClick={submit}>{busy ? 'กำลังส่งคำสั่งซื้อ…' : `ยืนยันสั่งซื้อ ฿${quote ? fmtMoney(quote.total) : '-'}`}</button>
    </div>
  );
}

const STEPS = ['pending_payment', 'paid', 'preparing', 'ready', 'completed'];
function OrderPage({ st }: { st: ShopState }) {
  const { orderNo } = useParams();
  const [sp] = useSearchParams();
  const t = sp.get('t') || read<any[]>(ORDERS, []).find((o) => o.orderNo === orderNo)?.t || '';
  const [o, setO] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => api(`/api/shop/orders/${orderNo}?t=${encodeURIComponent(t)}`, { token: st.token }).then((x) => { setO(x); setErr(null); }).catch((e) => setErr(errMsg(e))), [orderNo, t, st.token]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!o || ['completed', 'cancelled'].includes(o.status)) return;
    const iv = setInterval(load, o.status === 'pending_payment' ? 4000 : 30000);
    return () => clearInterval(iv);
  }, [o, load]);
  if (err) return <div className="center muted" style={{ padding: '3rem' }}>{err}</div>;
  if (!o) return <div className="center muted" style={{ padding: '3rem' }}>กำลังโหลด…</div>;
  const steps = o.fulfillment === 'delivery' ? STEPS.map((s) => (s === 'ready' ? 'shipped' : s)) : STEPS;
  const cur = o.status === 'shipped' && o.fulfillment !== 'delivery' ? 3 : steps.indexOf(o.status);
  const share = `${location.origin}/shop/order/${o.orderNo}?t=${t}`;
  return (
    <div className="shop-order">
      <div className="row between"><h2 style={{ margin: 0 }}>คำสั่งซื้อ {o.orderNo}</h2><span className={`badge ${o.status}`}>{STATUS[o.status]}</span></div>
      <div className="small muted">{fmtDate(o.createdAt)} · {o.fulfillment === 'pickup' ? `รับที่ร้าน ${o.branch?.name ?? ''}` : 'จัดส่ง'} · {PAY[o.paymentMethod]}</div>
      {o.status !== 'cancelled' ? (
        <ol className="steps">{steps.map((s, i) => <li key={s} className={i <= cur ? 'done' : ''}>{STATUS[s]}</li>)}</ol>
      ) : <div className="card err">ยกเลิกแล้ว{o.cancelledReason ? `: ${o.cancelledReason}` : ''}</div>}
      {o.status === 'pending_payment' && o.payment && o.paymentMethod === 'promptpay' && (
        <div className="card center pay-box">
          <b>สแกนเพื่อชำระเงินด้วยพร้อมเพย์</b>
          <div style={{ margin: '10px auto' }}>{o.payment.qrImageUrl ? <img src={o.payment.qrImageUrl} alt="PromptPay QR" style={{ width: 240 }} /> : o.payment.qrPayload ? <QrCanvas value={o.payment.qrPayload} size={240} /> : null}</div>
          <div className="price">{fmtMoney(o.payment.amount)}</div>
          <div className="small muted">{o.payment.status === 'needs_review' ? 'ได้รับหลักฐานแล้ว กำลังตรวจสอบ…' : 'หน้านี้จะอัปเดตอัตโนมัติเมื่อชำระเงินสำเร็จ'}</div>
        </div>
      )}
      {o.status === 'pending_payment' && o.paymentMethod === 'pay_at_store' && <div className="card">ชำระเงินที่ร้านเมื่อมารับสินค้า — แจ้งเลขคำสั่งซื้อ <b>{o.orderNo}</b> กับพนักงาน</div>}
      {o.trackingNo && <div className="card">เลขพัสดุ: <b className="mono">{o.trackingNo}</b></div>}
      <section>
        {o.items.map((i: any, k: number) => <div key={k} className="row between small"><span>{i.name} × {fmtQty(Number(i.qty))}</span><span>{fmtMoney(Number(i.line_total))}</span></div>)}
        <div className="shop-totals">
          <div className="row between"><span>ราคาสินค้า</span><span>{fmtMoney(o.subtotal)}</span></div>
          {o.discount > 0 && <div className="row between ok"><span>ส่วนลด</span><span>−{fmtMoney(o.discount)}</span></div>}
          {o.fulfillment === 'delivery' && <div className="row between"><span>ค่าจัดส่ง</span><span>{o.shipping ? `${fmtMoney(o.shipping)}` : 'ฟรี'}</span></div>}
          <div className="row between total"><b>ยอดรวม</b><b>{fmtMoney(o.total)}</b></div>
        </div>
      </section>
      {o.address && <div className="small"><b>ที่อยู่จัดส่ง:</b> {o.address}</div>}
      {o.fulfillment === 'pickup' && o.branch && <div className="small"><b>รับสินค้าที่:</b> {o.branch.name} {o.branch.address} {o.branch.phone && `โทร ${o.branch.phone}`}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(share); }}>🔗 คัดลอกลิงก์ติดตามคำสั่งซื้อ</button>
        <Link to="/shop" className="btn sm">กลับหน้าร้าน</Link>
      </div>
    </div>
  );
}

function MyOrders({ st }: { st: ShopState }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    (async () => {
      const local = read<any[]>(ORDERS, []);
      const views = await Promise.all(local.map((o) => api(`/api/shop/orders/${o.orderNo}?t=${encodeURIComponent(o.t)}`, { token: null }).then((v) => ({ ...v, t: o.t })).catch(() => null)));
      const mine = st.token ? await api<any[]>('/api/shop/my-orders', { token: st.token }).catch(() => []) : [];
      const map = new Map<string, any>();
      for (const v of views) if (v) map.set(v.orderNo, { orderNo: v.orderNo, status: v.status, total: v.total, createdAt: v.createdAt, t: v.t });
      for (const m of mine) if (!map.has(m.order_no)) map.set(m.order_no, { orderNo: m.order_no, status: m.status, total: Number(m.total), createdAt: m.created_at, t: '' });
      setRows([...map.values()].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)));
    })();
  }, [st.token]);
  if (!rows) return <div className="center muted" style={{ padding: '3rem' }}>กำลังโหลด…</div>;
  return (
    <div className="shop-cart">
      <h2>คำสั่งซื้อของฉัน</h2>
      {!rows.length && <p className="muted">ยังไม่มีคำสั่งซื้อ{!st.token && <> · <Link to="/shop/login?next=/shop/orders">เข้าสู่ระบบสมาชิก</Link> เพื่อดูคำสั่งซื้อทั้งหมด</>}</p>}
      {rows.map((o) => (
        <Link key={o.orderNo} to={`/shop/order/${o.orderNo}${o.t ? `?t=${o.t}` : ''}`} className="line" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="grow"><b className="mono">{o.orderNo}</b><div className="small muted">{fmtDate(o.createdAt)}</div></div>
          <span className={`badge ${o.status}`}>{STATUS[o.status]}</span>
          <b>{fmtMoney(o.total)}</b>
        </Link>
      ))}
    </div>
  );
}

function MemberLogin({ st }: { st: ShopState }) {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const toast = useToast();
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  if (st.token) return <div className="center" style={{ padding: '3rem' }}><p>เข้าสู่ระบบแล้ว</p><button className="btn" onClick={() => st.login(null)}>ออกจากระบบ</button> <Link className="btn primary shop-btn" to={sp.get('next') || '/shop'}>ช้อปต่อ</Link></div>;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api('/api/member/login', { body: { identifier: id.trim(), password: pw }, token: null });
      st.login(r.token);
      toast('เข้าสู่ระบบแล้ว', 'ok');
      nav(sp.get('next') || '/shop', { replace: true });
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="shop-checkout" style={{ maxWidth: 420 }}>
      <h2>เข้าสู่ระบบสมาชิก</h2>
      <form className="grid" style={{ gap: 8 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input className="in" placeholder="เบอร์โทร / อีเมล / เลขสมาชิก" autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} />
        <input className="in" type="password" placeholder="รหัสผ่าน (ครั้งแรก = 4 ตัวท้ายเบอร์โทร)" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="btn primary lg shop-btn" disabled={busy || !id || !pw}>เข้าสู่ระบบ</button>
      </form>
      <p className="small muted">ยังไม่เป็นสมาชิก หรือเข้าด้วย OTP? <Link to="/member">ไปที่เว็บไซต์สมาชิก</Link> · หรือสั่งซื้อแบบไม่เป็นสมาชิกได้เลย</p>
    </div>
  );
}
