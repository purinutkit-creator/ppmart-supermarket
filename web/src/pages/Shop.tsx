// Online ordering websites — one per storefront (/shop/<store>), sports-store style:
// announcement bar, mega menu, hero slider, product rails, filterable collections, product page with
// gallery / sizes / size chart, cart drawer with free-shipping meter, wishlist, branches, checkout and order tracking.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Routes, Route, Link, Navigate, useNavigate, useParams, useSearchParams, useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { Modal, QrCanvas, useToast, errMsg } from '../components/ui';
import { fmtMoney, fmtQty, fmtDate, uuid } from '../lib/format';
import { applyAreaFonts, loadFont } from '../lib/fonts';

const MEMBER = 'ppmart.member'; // shared with the member website
const ORDERS = 'ppmart.shop.orders';
const read = <T,>(k: string, d: T): T => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v ?? d; } catch { return d; } };
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full / blocked */ } };
const imgOf = (p: { imageIds?: number[]; imageUrl?: string | null }, i = 0) => (p.imageIds?.length ? `/api/shop/images/${p.imageIds[Math.min(i, p.imageIds.length - 1)]}` : p.imageUrl || null);
const pct = (price: number, compare: number | null) => (compare && compare > price ? Math.round((1 - price / compare) * 100) : 0);
const STATUS: Record<string, string> = {
  pending_payment: 'รอชำระเงิน', paid: 'ชำระเงินแล้ว', preparing: 'กำลังจัดเตรียม', ready: 'พร้อมรับสินค้า', shipped: 'จัดส่งแล้ว', completed: 'สำเร็จ', cancelled: 'ยกเลิก',
};
const PAY: Record<string, string> = { promptpay: 'พร้อมเพย์ (QR)', pay_at_store: 'ชำระที่ร้านตอนรับสินค้า', cod: 'เก็บเงินปลายทาง' };

// ---------------- icons ----------------
const P: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-4.3-4.3',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 8a8 8 0 0 1 16 0',
  heart: 'M12 20s-7-4.4-9.2-8.6C1.3 8.3 3.2 5 6.5 5c2 0 3.3 1.1 4 2.4h3c.7-1.3 2-2.4 4-2.4 3.3 0 5.2 3.3 3.7 6.4C19 15.6 12 20 12 20z',
  bag: 'M6 7h12l-1 13H7L6 7zm3 0V6a3 3 0 0 1 6 0v1',
  menu: 'M3 6h18M3 12h18M3 18h18', x: 'M6 6l12 12M18 6 6 18', left: 'M15 5l-7 7 7 7', right: 'M9 5l7 7-7 7', down: 'M5 9l7 7 7-7',
  truck: 'M2 6h12v10H2zM14 10h4l3 3v3h-7M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  store: 'M4 10v10h16V10M3 4h18l-1 6H4L3 4zm6 16v-6h6v6', shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z', check: 'M5 12l5 5 9-10',
  filter: 'M4 6h16M7 12h10M10 18h4', pin: 'M12 21s-7-6.5-7-12a7 7 0 1 1 14 0c0 5.5-7 12-7 12zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
};
function Ic({ n, s = 22, fill = false }: { n: keyof typeof P | string; s?: number; fill?: boolean }) {
  return <svg width={s} height={s} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={P[n]} /></svg>;
}

// ---------------- store state ----------------
type CartLine = { productId: number; qty: number; name: string; label?: string | null; price: number; comparePrice?: number | null; image?: string | null; parentId: number; brand?: string | null; isWeighted?: boolean };
function useStoreState(slug: string) {
  const ck = `ppmart.shop.${slug}.cart`, wk = `ppmart.shop.${slug}.wish`;
  const [cart, setCart] = useState<CartLine[]>(() => read(ck, []));
  const [wish, setWish] = useState<any[]>(() => read(wk, []));
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(MEMBER));
  useEffect(() => write(ck, cart), [ck, cart]);
  useEffect(() => write(wk, wish), [wk, wish]);
  useEffect(() => {
    const h = (e: StorageEvent) => { if (e.key === ck) setCart(read(ck, [])); if (e.key === wk) setWish(read(wk, [])); if (e.key === MEMBER) setToken(localStorage.getItem(MEMBER)); };
    window.addEventListener('storage', h);
    return () => window.removeEventListener('storage', h);
  }, [ck, wk]);
  const add = useCallback((l: CartLine) => setCart((c) => {
    const i = c.findIndex((x) => x.productId === l.productId);
    if (i < 0) return [...c, l];
    const n = [...c]; n[i] = { ...n[i], qty: +(n[i].qty + l.qty).toFixed(3) }; return n;
  }), []);
  const toggleWish = useCallback((p: any) => setWish((w) => (w.some((x) => x.id === p.id) ? w.filter((x) => x.id !== p.id) : [{ ...p, savedAt: Date.now() }, ...w].slice(0, 200))), []);
  const login = (t: string | null) => { if (t) localStorage.setItem(MEMBER, t); else localStorage.removeItem(MEMBER); setToken(t); };
  return { cart, setCart, add, wish, toggleWish, token, login };
}
type Ctx = { info: any; slug: string; base: string; st: ReturnType<typeof useStoreState>; me: any; openCart: () => void };
const StoreCtx = createContext<Ctx>(null as any);
const useStore = () => useContext(StoreCtx);

// ================= entry =================
export default function Shop() {
  useEffect(() => { loadFont('Kanit'); }, []);
  return (
    <Routes>
      <Route index element={<StoreChooser />} />
      <Route path="order/:orderNo" element={<OrderRedirect />} />
      <Route path="p/:id" element={<LegacyRedirect />} />
      <Route path=":slug/*" element={<StoreApp />} />
    </Routes>
  );
}

function LegacyRedirect() { const { id } = useParams(); return <Navigate to={`/shop/main/p/${id}`} replace />; }

/** Old tracking links (/shop/order/<no>?t=) → the order page inside its store. */
function OrderRedirect() {
  const { orderNo } = useParams();
  const [sp] = useSearchParams();
  const [to, setTo] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api(`/api/shop/orders/${orderNo}?t=${encodeURIComponent(sp.get('t') || '')}`, { token: localStorage.getItem(MEMBER) })
      .then((o) => setTo(`/shop/${o.store?.slug ?? 'main'}/order/${orderNo}?t=${sp.get('t') || ''}`)).catch((e) => setErr(errMsg(e)));
  }, [orderNo, sp]);
  if (to) return <Navigate to={to} replace />;
  return <div className="st-msg">{err ?? 'กำลังโหลด…'}</div>;
}

function StoreChooser() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api('/api/shop/stores', { token: null }).then(setD).catch((e) => setErr(errMsg(e))); }, []);
  if (err) return <div className="st-msg">{err}</div>;
  if (!d) return <div className="st-msg">กำลังโหลด…</div>;
  if (d.stores.length === 1) return <Navigate to={`/shop/${d.stores[0].slug}`} replace />;
  return (
    <div className="st st-chooser">
      <div className="st-wrap">
        <div className="st-chooser-head">{d.company.logo && <img src={d.company.logo} alt="" />}<h1>{d.company.name}</h1><p>เลือกร้านค้าออนไลน์</p></div>
        {!d.stores.length && <div className="st-msg">ขณะนี้ยังไม่มีร้านค้าออนไลน์ที่เปิดให้บริการ</div>}
        <div className="st-chooser-grid">
          {d.stores.map((s: any) => (
            <Link key={s.slug} to={`/shop/${s.slug}`} className="st-chooser-card" style={{ ['--p' as any]: s.theme.primary }}>
              <div className="bg" style={s.banner ? { backgroundImage: `url(${s.banner})` } : undefined} />
              <div className="body">{s.logo ? <img src={s.logo} alt="" /> : <b className="mono-logo">{s.name.slice(0, 2).toUpperCase()}</b>}<div><h2>{s.name}</h2>{s.tagline && <p>{s.tagline}</p>}</div><span className="go">เข้าร้าน →</span></div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

// ================= one storefront =================
function StoreApp() {
  const { slug = '' } = useParams();
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const st = useStoreState(slug);
  const [me, setMe] = useState<any>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    setInfo(null); setErr(null);
    api(`/api/shop/s/${slug}/info`, { token: null }).then((i) => {
      setInfo(i);
      applyAreaFonts({ member: i.fonts?.member || 'Sarabun' });
      document.title = i.store.name;
    }).catch((e) => setErr(e));
  }, [slug]);
  useEffect(() => {
    if (!st.token) { setMe(null); return; }
    api('/api/member/me', { token: st.token }).then(setMe).catch(() => st.login(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st.token]);
  useEffect(() => { window.scrollTo(0, 0); setCartOpen(false); }, [loc.pathname]);
  if (err) {
    return (
      <div className="st-msg">
        <h2>{err.code === 'SHOP_CLOSED' ? 'ร้านค้านี้ปิดให้บริการชั่วคราว' : 'ไม่พบร้านค้านี้'}</h2>
        <Link to="/shop" className="st-btn">ดูร้านค้าอื่น</Link>
      </div>
    );
  }
  if (!info) return <div className="st-msg">กำลังโหลด…</div>;
  const ctx: Ctx = { info, slug, base: `/shop/${slug}`, st, me, openCart: () => setCartOpen(true) };
  const t = info.store.theme;
  return (
    <StoreCtx.Provider value={ctx}>
      <div className="st" style={{ ['--p' as any]: t.primary, ['--a' as any]: t.accent }}>
        <Announcements />
        <Header />
        <main className="st-main">
          <Routes>
            <Route index element={<Home />} />
            <Route path="c" element={<Collection />} />
            <Route path="p/:id" element={<ProductPage />} />
            <Route path="cart" element={<CartPage />} />
            <Route path="checkout" element={<Checkout />} />
            <Route path="login" element={<MemberLogin />} />
            <Route path="order/:orderNo" element={<OrderPage />} />
            <Route path="orders" element={<MyOrders />} />
            <Route path="wishlist" element={<Wishlist />} />
            <Route path="stores" element={<Locations />} />
            <Route path="*" element={<div className="st-msg">ไม่พบหน้านี้ · <Link to={ctx.base}>กลับหน้าแรก</Link></div>} />
          </Routes>
        </main>
        <Footer />
        <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
      </div>
    </StoreCtx.Provider>
  );
}

function Announcements() {
  const { info } = useStore();
  const list: string[] = info.store.announcements;
  const [i, setI] = useState(0);
  useEffect(() => { if (list.length < 2) return; const t = setInterval(() => setI((x) => (x + 1) % list.length), 4500); return () => clearInterval(t); }, [list.length]);
  if (!list.length) return null;
  return <div className="st-ann"><span key={i}>{list[i % list.length]}</span></div>;
}

function catTree(cats: any[]): any[] {
  const node = (c: any): any => {
    const children = cats.filter((x) => x.parentId === c.id).map(node);
    return { ...c, children, image: c.image ?? children.find((x: any) => x.image)?.image ?? null };
  };
  const top = cats.filter((c) => !c.parentId || !cats.some((x) => x.id === c.parentId)).map(node);
  // a store selling a single department (e.g. only "football") shows that department's sub-categories as its menu
  return top.length === 1 && top[0].children.length ? top[0].children : top;
}

function Header() {
  const { info, base, st, openCart } = useStore();
  const nav = useNavigate();
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState(false);
  const [q, setQ] = useState('');
  const tree = useMemo(() => catTree(info.categories), [info.categories]);
  const count = st.cart.reduce((a, l) => a + (l.isWeighted ? 1 : l.qty), 0);
  const go = (to: string) => { setMenu(false); setSearch(false); nav(to); };
  const doSearch = (e: React.FormEvent) => { e.preventDefault(); if (q.trim()) go(`${base}/c?q=${encodeURIComponent(q.trim())}`); };
  const s = info.store;
  return (
    <header className="st-head">
      <div className="st-wrap st-head-row">
        <button className="st-icon only-sm" onClick={() => setMenu(true)} aria-label="เมนู"><Ic n="menu" /></button>
        <Link to={base} className="st-logo">{s.logo ? <img src={s.logo} alt={s.name} /> : <span>{s.name}</span>}</Link>
        <nav className="st-nav hide-sm">
          {s.home.showNew && <Link to={`${base}/c?tag=new`}>สินค้าใหม่</Link>}
          {tree.slice(0, 7).map((c) => (
            <div key={c.id} className="st-nav-item">
              <Link to={`${base}/c?category=${c.id}`}>{c.name}{c.children.length > 0 && <Ic n="down" s={14} />}</Link>
              {c.children.length > 0 && (
                <div className="st-mega"><div className="st-wrap"><div className="cols">
                  <Link to={`${base}/c?category=${c.id}`} className="all">{c.name} ทั้งหมด</Link>
                  {c.children.map((x: any) => <Link key={x.id} to={`${base}/c?category=${x.id}`}>{x.name}</Link>)}
                </div>{c.image && <img src={c.image} alt="" />}</div></div>
              )}
            </div>
          ))}
          {info.brands.length > 0 && (
            <div className="st-nav-item">
              <Link to={`${base}/c`}>แบรนด์<Ic n="down" s={14} /></Link>
              <div className="st-mega"><div className="st-wrap"><div className="cols brands">{info.brands.map((b: any) => <Link key={b.id} to={`${base}/c?brand=${b.id}`}>{b.name}</Link>)}</div></div></div>
            </div>
          )}
          {s.home.showSale && <Link to={`${base}/c?tag=sale`} className="sale">SALE</Link>}
        </nav>
        <div className="st-tools">
          <button className="st-icon" onClick={() => setSearch(true)} aria-label="ค้นหา"><Ic n="search" /></button>
          <Link className="st-icon hide-sm" to={st.token ? `${base}/orders` : `${base}/login`} aria-label="บัญชี"><Ic n="user" /></Link>
          <Link className="st-icon hide-sm" to={`${base}/wishlist`} aria-label="รายการโปรด"><Ic n="heart" />{st.wish.length > 0 && <b className="st-badge">{st.wish.length}</b>}</Link>
          <button className="st-icon" onClick={openCart} aria-label="ตะกร้า"><Ic n="bag" />{count > 0 && <b className="st-badge">{fmtQty(count)}</b>}</button>
        </div>
      </div>
      {search && (
        <div className="st-search" onMouseDown={(e) => { if (e.target === e.currentTarget) setSearch(false); }}>
          <form className="st-wrap" onSubmit={doSearch}>
            <Ic n="search" /><input autoFocus placeholder="ค้นหาสินค้า แบรนด์ รุ่น…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button type="button" className="st-icon" onClick={() => setSearch(false)} aria-label="ปิด"><Ic n="x" /></button>
          </form>
        </div>
      )}
      {menu && (
        <div className="st-drawer-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setMenu(false); }}>
          <aside className="st-drawer left">
            <div className="st-drawer-head"><b>เมนู</b><button className="st-icon" onClick={() => setMenu(false)}><Ic n="x" /></button></div>
            <div className="st-mmenu">
              {s.home.showNew && <button onClick={() => go(`${base}/c?tag=new`)}>สินค้าใหม่</button>}
              {tree.map((c) => <MobileCat key={c.id} c={c} go={go} />)}
              {info.brands.length > 0 && <MobileCat c={{ name: 'แบรนด์', children: info.brands.map((b: any) => ({ ...b, link: `${base}/c?brand=${b.id}` })) }} go={go} />}
              {s.home.showSale && <button className="sale" onClick={() => go(`${base}/c?tag=sale`)}>SALE</button>}
              <hr />
              <button onClick={() => go(st.token ? `${base}/orders` : `${base}/login`)}><Ic n="user" s={18} /> {st.token ? 'คำสั่งซื้อของฉัน' : 'เข้าสู่ระบบสมาชิก'}</button>
              <button onClick={() => go(`${base}/wishlist`)}><Ic n="heart" s={18} /> รายการโปรด ({st.wish.length})</button>
              <button onClick={() => go(`${base}/stores`)}><Ic n="pin" s={18} /> สาขา</button>
            </div>
          </aside>
        </div>
      )}
    </header>
  );
}
function MobileCat({ c, go }: { c: any; go: (to: string) => void }) {
  const { base } = useStore();
  const [open, setOpen] = useState(false);
  if (!c.children?.length) return <button onClick={() => go(c.link ?? `${base}/c?category=${c.id}`)}>{c.name}</button>;
  return (
    <>
      <button onClick={() => setOpen(!open)} className="row between">{c.name}<Ic n={open ? 'down' : 'right'} s={16} /></button>
      {open && <div className="sub">{c.id && <button onClick={() => go(`${base}/c?category=${c.id}`)}>ทั้งหมด</button>}{c.children.map((x: any) => <button key={x.id} onClick={() => go(x.link ?? `${base}/c?category=${x.id}`)}>{x.name}</button>)}</div>}
    </>
  );
}

function Footer() {
  const { info, base } = useStore();
  const s = info.store, c = s.contact;
  const tree = catTree(info.categories).slice(0, 8);
  const social: [string, string][] = ([['Facebook', c.facebook], ['Instagram', c.instagram], ['LINE', c.line], ['TikTok', c.tiktok]] as [string, string][]).filter(([, v]) => v);
  const href = (v: string, k: string) => (/^https?:/.test(v) ? v : k === 'LINE' ? `https://line.me/R/ti/p/${v.startsWith('@') ? v : '@' + v}` : v);
  return (
    <footer className="st-foot">
      <div className="st-wrap st-foot-grid">
        <div>
          <div className="st-foot-logo">{s.logo ? <img src={s.logo} alt="" /> : s.name}</div>
          {s.footerText && <p>{s.footerText}</p>}
          {(c.address || info.company.address) && <p><Ic n="pin" s={16} /> {c.address || info.company.address}</p>}
          {(c.phone || info.company.phone) && <p><Ic n="phone" s={16} /> <a href={`tel:${(c.phone || info.company.phone).replace(/\s/g, '')}`}>{c.phone || info.company.phone}</a></p>}
          {c.email && <p>✉ <a href={`mailto:${c.email}`}>{c.email}</a></p>}
        </div>
        <div><h4>สินค้า</h4>{tree.map((x) => <Link key={x.id} to={`${base}/c?category=${x.id}`}>{x.name}</Link>)}{s.home.showSale && <Link to={`${base}/c?tag=sale`}>SALE</Link>}</div>
        <div><h4>ช่วยเหลือ</h4><Link to={`${base}/orders`}>ติดตามคำสั่งซื้อ</Link><Link to={`${base}/stores`}>สาขาของเรา</Link><Link to={`${base}/login`}>สมาชิก</Link><Link to="/member">เว็บไซต์สมาชิก</Link></div>
        <div><h4>ติดตามเรา</h4>{social.map(([k, v]) => <a key={k} href={href(v, k)} target="_blank" rel="noreferrer">{k}</a>)}
          <h4 style={{ marginTop: 16 }}>ชำระเงิน</h4><div className="st-pay">{s.payments.promptpay && <span>PromptPay</span>}{s.payments.payAtStore && <span>ชำระที่ร้าน</span>}{s.payments.cod && <span>COD</span>}</div></div>
      </div>
      <div className="st-copy">© {new Date().getFullYear()} {s.name}</div>
    </footer>
  );
}

// ---------------- product card / rails ----------------
function Price({ price, max, compare, big }: { price: number; max?: number; compare?: number | null; big?: boolean }) {
  const sale = !!compare && compare > price;
  return (
    <span className={`st-price ${sale ? 'sale' : ''} ${big ? 'big' : ''}`}>
      <b>{fmtMoney(price)}{max && max !== price ? ` – ${fmtMoney(max)}` : ''}</b>
      {sale && <s>{fmtMoney(compare!)}</s>}
    </span>
  );
}

function Card({ p }: { p: any }) {
  const { base, st } = useStore();
  const off = pct(p.price, p.comparePrice);
  const saved = st.wish.some((x) => x.id === p.id);
  const a = imgOf(p), b = p.imageIds?.length > 1 ? imgOf(p, 1) : null;
  return (
    <div className={`st-card ${p.available ? '' : 'out'}`}>
      <Link to={`${base}/p/${p.id}`} className="ph">
        {a ? <><img src={a} alt={p.name} loading="lazy" className="a" />{b && <img src={b} alt="" loading="lazy" className="b" />}</> : <span className="noimg">{p.name.slice(0, 1)}</span>}
        <div className="tags">{off > 0 && <span className="t sale">-{off}%</span>}{p.isNew && <span className="t new">NEW</span>}</div>
        {!p.available && <span className="soldout">SOLD OUT</span>}
      </Link>
      <button className={`fav ${saved ? 'on' : ''}`} onClick={() => st.toggleWish(p)} aria-label="รายการโปรด"><Ic n="heart" s={18} fill={saved} /></button>
      <Link to={`${base}/p/${p.id}`} className="info">
        {p.brandName && <div className="brand">{p.brandName}</div>}
        <div className="nm">{p.name}</div>
        <Price price={p.price} max={p.hasSizes ? p.maxPrice : undefined} compare={p.comparePrice} />
        {p.hasSizes && p.sizes?.length > 0 && <div className="sz">{p.sizes.slice(0, 6).join(' · ')}{p.sizes.length > 6 ? ' …' : ''}</div>}
      </Link>
    </div>
  );
}

function Rail({ title, query, more }: { title: string; query: string; more: string }) {
  const { slug } = useStore();
  const [items, setItems] = useState<any[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { api(`/api/shop/s/${slug}/products?${query}&limit=12`, { token: null }).then((r) => setItems(r.items)).catch(() => setItems([])); }, [slug, query]);
  if (items && !items.length) return null;
  const scroll = (d: number) => ref.current?.scrollBy({ left: d * ref.current.clientWidth * 0.8, behavior: 'smooth' });
  return (
    <section className="st-sec">
      <div className="st-sec-head"><h2>{title}</h2><div className="row" style={{ gap: 6 }}><Link to={more} className="more">ดูทั้งหมด</Link><button className="st-round hide-sm" onClick={() => scroll(-1)}><Ic n="left" s={18} /></button><button className="st-round hide-sm" onClick={() => scroll(1)}><Ic n="right" s={18} /></button></div></div>
      <div className="st-rail" ref={ref}>{(items ?? Array.from({ length: 4 }, () => null)).map((p, i) => (p ? <Card key={p.id} p={p} /> : <div key={i} className="st-card skel" />))}</div>
    </section>
  );
}

// ---------------- home ----------------
function Hero() {
  const { info, base } = useStore();
  const banners: any[] = info.store.banners;
  const [i, setI] = useState(0);
  const touch = useRef<number | null>(null);
  useEffect(() => { if (banners.length < 2) return; const t = setInterval(() => setI((x) => (x + 1) % banners.length), 6000); return () => clearInterval(t); }, [banners.length, i]);
  if (!banners.length) {
    return <div className="st-hero plain"><div className="st-wrap"><h1>{info.store.name}</h1>{info.store.tagline && <p>{info.store.tagline}</p>}<Link to={`${base}/c`} className="st-btn light">ช้อปเลย</Link></div></div>;
  }
  const go = (d: number) => setI((x) => (x + d + banners.length) % banners.length);
  const linkOf = (b: any) => (b.link ? (b.link.startsWith('/') || /^https?:/.test(b.link) ? b.link : `${base}/${b.link.replace(/^\//, '')}`) : `${base}/c`);
  return (
    <div className={`st-hero ${banners.some((b) => b.mobileMediaId) ? 'has-m' : ''}`} onTouchStart={(e) => { touch.current = e.touches[0].clientX; }} onTouchEnd={(e) => { if (touch.current == null) return; const dx = e.changedTouches[0].clientX - touch.current; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); touch.current = null; }}>
      {banners.map((b, k) => {
        const href = linkOf(b);
        const inner = (
          <>
            <picture><source media="(max-width: 760px)" srcSet={b.mobileImage} /><img src={b.image} alt={b.title || ''} loading={k ? 'lazy' : 'eager'} /></picture>
            {(b.title || b.subtitle || b.buttonText) && <div className="cap"><div className="st-wrap">{b.title && <h2>{b.title}</h2>}{b.subtitle && <p>{b.subtitle}</p>}{b.buttonText && <span className="st-btn light">{b.buttonText}</span>}</div></div>}
          </>
        );
        return <div key={k} className={`slide ${k === i ? 'on' : ''}`}>{/^https?:/.test(href) ? <a href={href}>{inner}</a> : <Link to={href}>{inner}</Link>}</div>;
      })}
      {banners.length > 1 && <><button className="nav l" onClick={() => go(-1)} aria-label="ก่อนหน้า"><Ic n="left" /></button><button className="nav r" onClick={() => go(1)} aria-label="ถัดไป"><Ic n="right" /></button>
        <div className="dots">{banners.map((_, k) => <button key={k} className={k === i ? 'on' : ''} onClick={() => setI(k)} aria-label={`สไลด์ ${k + 1}`} />)}</div></>}
    </div>
  );
}

function Perks() {
  const { info } = useStore();
  const s = info.store;
  const items = [
    s.delivery && ['truck', s.freeDeliveryMin ? `ส่งฟรีเมื่อซื้อครบ ${fmtMoney(s.freeDeliveryMin)}` : 'จัดส่งทั่วประเทศ', s.deliveryFee ? `ค่าส่ง ${fmtMoney(s.deliveryFee)}` : 'ส่งฟรี'],
    s.pickup && ['store', 'รับสินค้าที่สาขา', info.branch?.name ?? ''],
    ['shield', 'สินค้าของแท้ 100%', 'รับประกันโดยร้าน'],
    ['check', 'ชำระเงินปลอดภัย', [s.payments.promptpay && 'PromptPay', s.payments.payAtStore && 'ชำระที่ร้าน', s.payments.cod && 'COD'].filter(Boolean).join(' · ')],
  ].filter(Boolean) as string[][];
  return <div className="st-perks st-wrap">{items.map(([ic, t, d]) => <div key={t}><Ic n={ic} s={26} /><div><b>{t}</b><small>{d}</small></div></div>)}</div>;
}

function Home() {
  const { info, base } = useStore();
  const h = info.store.home;
  const tops = catTree(info.categories);
  return (
    <>
      <Hero />
      <Perks />
      <div className="st-wrap">
        {h.showCategories && tops.length > 0 && (
          <section className="st-sec">
            <div className="st-sec-head"><h2>เลือกซื้อตามหมวดหมู่</h2></div>
            <div className="st-cats">{tops.slice(0, 8).map((c) => (
              <Link key={c.id} to={`${base}/c?category=${c.id}`} className="st-cat">{c.image ? <img src={c.image} alt="" loading="lazy" /> : <span className="noimg" />}<b>{c.name}</b></Link>
            ))}</div>
          </section>
        )}
        {h.showNew && <Rail title="สินค้าใหม่" query="sort=new" more={`${base}/c?sort=new`} />}
        {h.showSale && <Rail title="ลดราคา" query="tag=sale" more={`${base}/c?tag=sale`} />}
        {h.showBest && <Rail title="ขายดี" query="tag=best" more={`${base}/c?tag=best`} />}
        {h.showBrands && info.brands.length > 0 && (
          <section className="st-sec">
            <div className="st-sec-head"><h2>แบรนด์</h2></div>
            <div className="st-brands">{info.brands.map((b: any) => <Link key={b.id} to={`${base}/c?brand=${b.id}`}>{b.name}</Link>)}</div>
          </section>
        )}
        {!h.showNew && !h.showSale && !h.showBest && <Rail title="สินค้าทั้งหมด" query="" more={`${base}/c`} />}
      </div>
    </>
  );
}

// ---------------- collection ----------------
const SORTS: [string, string][] = [['', 'แนะนำ'], ['new', 'มาใหม่'], ['best', 'ขายดี'], ['price_asc', 'ราคา ต่ำ → สูง'], ['price_desc', 'ราคา สูง → ต่ำ'], ['name', 'ชื่อ ก–ฮ']];
function Collection() {
  const { info, slug, base } = useStore();
  const [sp, setSp] = useSearchParams();
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState(false);
  const key = sp.toString();
  const load = async (offset: number) => {
    setLoading(true);
    try {
      const r = await api(`/api/shop/s/${slug}/products?${key}&offset=${offset}&limit=24`, { token: null });
      setItems((x) => (offset ? [...x, ...r.items] : r.items)); setTotal(r.total); setFacets(r.facets);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(0); /* eslint-disable-next-line */ }, [slug, key]);
  const set = (k: string, v: string | null) => setSp((s) => { const n = new URLSearchParams(s); if (v) n.set(k, v); else n.delete(k); return n; });
  const toggleList = (k: string, v: string) => { const cur = (sp.get(k) || '').split(',').filter(Boolean); set(k, (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]).join(',') || null); };
  const catId = Number(sp.get('category')) || null;
  const cat = info.categories.find((c: any) => c.id === catId);
  const subs = catId ? info.categories.filter((c: any) => c.parentId === catId) : catTree(info.categories);
  const brandSel = (sp.get('brand') || '').split(',').filter(Boolean);
  const brand = brandSel.length === 1 ? info.brands.find((b: any) => String(b.id) === brandSel[0]) : null;
  const tag = sp.get('tag');
  const title = sp.get('q') ? `ค้นหา “${sp.get('q')}”` : cat?.name ?? brand?.name ?? (tag === 'new' ? 'สินค้าใหม่' : tag === 'sale' ? 'SALE ลดราคา' : tag === 'best' ? 'สินค้าขายดี' : 'สินค้าทั้งหมด');
  const active = ['brand', 'size', 'min', 'max', 'inStock'].some((k) => sp.get(k));
  const parentCat = cat?.parentId ? info.categories.find((c: any) => c.id === cat.parentId) : null;
  const panel = (
    <div className="st-filters">
      {subs.length > 0 && <div className="grp"><h4>หมวดหมู่</h4>{subs.map((c: any) => <button key={c.id} onClick={() => set('category', String(c.id))}>{c.name} <small>{c.count}</small></button>)}</div>}
      {facets?.sizes?.length > 0 && <div className="grp"><h4>ไซส์</h4><div className="st-chips">{facets.sizes.map((s: string) => <button key={s} className={(sp.get('size') || '').split(',').includes(s) ? 'on' : ''} onClick={() => toggleList('size', s)}>{s}</button>)}</div></div>}
      {facets?.brands?.length > 0 && <div className="grp"><h4>แบรนด์</h4>{facets.brands.map((b: any) => <label key={b.id} className="chk"><input type="checkbox" checked={brandSel.includes(String(b.id))} onChange={() => toggleList('brand', String(b.id))} /> {b.name} <small>{b.count}</small></label>)}</div>}
      <PriceFilter key={key} min={sp.get('min')} max={sp.get('max')} range={facets} onApply={(a, b) => setSp((s) => { const n = new URLSearchParams(s); a ? n.set('min', a) : n.delete('min'); b ? n.set('max', b) : n.delete('max'); return n; })} />
      <div className="grp"><label className="chk"><input type="checkbox" checked={sp.get('inStock') === '1'} onChange={(e) => set('inStock', e.target.checked ? '1' : null)} /> เฉพาะสินค้าที่มีของ</label></div>
      {active && <button className="st-btn ghost block" onClick={() => setSp((s) => { const n = new URLSearchParams(s); ['brand', 'size', 'min', 'max', 'inStock'].forEach((k) => n.delete(k)); return n; })}>ล้างตัวกรอง</button>}
    </div>
  );
  return (
    <div className="st-wrap st-coll">
      <div className="st-crumbs"><Link to={base}>หน้าแรก</Link>{parentCat && <> / <Link to={`${base}/c?category=${parentCat.id}`}>{parentCat.name}</Link></>}<span> / {title}</span></div>
      <h1 className="st-h1">{title}</h1>
      <div className="st-coll-body">
        <aside className="hide-sm">{panel}</aside>
        <div>
          <div className="st-toolbar">
            <button className="st-btn ghost only-sm" onClick={() => setFilters(true)}><Ic n="filter" s={16} /> ตัวกรอง{active ? ' •' : ''}</button>
            <span className="muted small">{total} รายการ</span><span className="spacer" />
            <select value={sp.get('sort') || ''} onChange={(e) => set('sort', e.target.value || null)}>{SORTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </div>
          <div className="st-grid">{items.map((p) => <Card key={p.id} p={p} />)}</div>
          {!loading && !items.length && <div className="st-msg">ไม่พบสินค้าที่ตรงกับเงื่อนไข</div>}
          {items.length < total && (
            <div className="st-more"><small>แสดง {items.length} จาก {total}</small><div className="bar"><i style={{ width: `${(items.length / total) * 100}%` }} /></div>
              <button className="st-btn ghost" disabled={loading} onClick={() => load(items.length)}>{loading ? 'กำลังโหลด…' : 'โหลดเพิ่ม'}</button></div>
          )}
        </div>
      </div>
      {filters && (
        <div className="st-drawer-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setFilters(false); }}>
          <aside className="st-drawer left"><div className="st-drawer-head"><b>ตัวกรอง</b><button className="st-icon" onClick={() => setFilters(false)}><Ic n="x" /></button></div>
            <div style={{ padding: 16, overflow: 'auto' }}>{panel}</div>
            <div className="st-drawer-foot"><button className="st-btn block" onClick={() => setFilters(false)}>ดูสินค้า {total} รายการ</button></div></aside>
        </div>
      )}
    </div>
  );
}
function PriceFilter({ min, max, range, onApply }: { min: string | null; max: string | null; range: any; onApply: (a: string, b: string) => void }) {
  const [a, setA] = useState(min ?? '');
  const [b, setB] = useState(max ?? '');
  return (
    <div className="grp"><h4>ราคา (บาท)</h4>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <input inputMode="numeric" placeholder={range?.minPrice != null ? String(Math.floor(range.minPrice / 100)) : 'ต่ำสุด'} value={a} onChange={(e) => setA(e.target.value.replace(/\D/g, ''))} />
        <span>–</span>
        <input inputMode="numeric" placeholder={range?.maxPrice != null ? String(Math.ceil(range.maxPrice / 100)) : 'สูงสุด'} value={b} onChange={(e) => setB(e.target.value.replace(/\D/g, ''))} />
        <button className="st-btn sm" onClick={() => onApply(a, b)}>ตกลง</button>
      </div>
    </div>
  );
}

// ---------------- product page ----------------
function Gallery({ ids, fallback, name, badge }: { ids: number[]; fallback?: string | null; name: string; badge?: ReactNode }) {
  const [i, setI] = useState(0);
  const [zoom, setZoom] = useState(false);
  const touch = useRef<number | null>(null);
  const srcs = ids.length ? ids.map((id) => `/api/shop/images/${id}`) : fallback ? [fallback] : [];
  useEffect(() => setI(0), [ids.join(',')]);
  if (!srcs.length) return <div className="st-gal"><div className="main"><span className="noimg">{name.slice(0, 1)}</span></div></div>;
  const go = (d: number) => setI((x) => (x + d + srcs.length) % srcs.length);
  return (
    <div className="st-gal">
      {srcs.length > 1 && <div className="thumbs">{srcs.map((s, k) => <button key={k} className={k === i ? 'on' : ''} onClick={() => setI(k)}><img src={s} alt="" loading="lazy" /></button>)}</div>}
      <div className="main" onClick={() => setZoom(true)} onTouchStart={(e) => { touch.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => { if (touch.current == null) return; const dx = e.changedTouches[0].clientX - touch.current; if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1); touch.current = null; }}>
        <img src={srcs[i]} alt={name} />
        {badge}
        {srcs.length > 1 && <><button className="nav l" onClick={(e) => { e.stopPropagation(); go(-1); }} aria-label="ก่อนหน้า"><Ic n="left" /></button><button className="nav r" onClick={(e) => { e.stopPropagation(); go(1); }} aria-label="ถัดไป"><Ic n="right" /></button><span className="cnt">{i + 1}/{srcs.length}</span></>}
      </div>
      {zoom && <div className="st-zoom" onClick={() => setZoom(false)}><img src={srcs[i]} alt={name} /><button className="st-icon" aria-label="ปิด"><Ic n="x" /></button></div>}
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

function Acc({ title, children, open: o = false }: { title: string; children: ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(o);
  return <div className={`st-acc ${open ? 'on' : ''}`}><button onClick={() => setOpen(!open)}>{title}<Ic n="down" s={18} /></button>{open && <div className="body">{children}</div>}</div>;
}

function ProductPage() {
  const { slug, base, st, info, openCart } = useStore();
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const [p, setP] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [chart, setChart] = useState(false);
  const [needSize, setNeedSize] = useState(false);
  useEffect(() => { setP(null); setSize(null); setQty(1); setErr(null); api(`/api/shop/s/${slug}/products/${id}`, { token: null }).then(setP).catch((e) => setErr(errMsg(e))); }, [slug, id]);
  if (err) return <div className="st-msg">{err} · <Link to={base}>กลับหน้าแรก</Link></div>;
  if (!p) return <div className="st-msg">กำลังโหลด…</div>;
  const v = p.variants.find((x: any) => x.id === size);
  const price = v ? v.price : p.price;
  const compare = v ? v.comparePrice : p.comparePrice;
  const memberPrice = v ? v.memberPrice : p.memberPrice;
  const stock = v ? v.stock : p.hasSizes ? null : p.stock;
  const available = p.hasSizes ? (v ? v.available : p.available) : p.available;
  const step = p.isWeighted ? 0.1 : 1;
  const inCart = st.cart.find((l) => l.productId === (v?.id ?? p.id))?.qty ?? 0;
  const max = stock == null ? 999 : Math.max(0, stock - inCart);
  const saved = st.wish.some((x) => x.id === p.id);
  const off = pct(price, compare);
  const add = (go: boolean) => {
    if (p.hasSizes && !v) { setNeedSize(true); toast('กรุณาเลือกไซส์', 'warn'); return; }
    if (qty > max) { toast(stock != null ? `เหลือสินค้า ${fmtQty(stock)} ชิ้น${inCart ? ` (อยู่ในตะกร้าแล้ว ${fmtQty(inCart)})` : ''}` : 'จำนวนไม่ถูกต้อง', 'warn'); return; }
    st.add({ productId: v?.id ?? p.id, parentId: p.id, qty, name: p.name, label: v?.label ?? null, price, comparePrice: compare, image: imgOf(p), brand: p.brandName, isWeighted: p.isWeighted });
    if (go) nav(`${base}/checkout`); else openCart();
  };
  const s = info.store;
  return (
    <div className="st-wrap">
      <div className="st-crumbs"><Link to={base}>หน้าแรก</Link>{p.breadcrumbs.map((c: any) => <span key={c.id}> / <Link to={`${base}/c?category=${c.id}`}>{c.name}</Link></span>)}<span> / {p.name}</span></div>
      <div className="st-pdp">
        <Gallery ids={p.imageIds} fallback={p.imageUrl} name={p.name} badge={<div className="tags">{off > 0 && <span className="t sale">-{off}%</span>}{p.isNew && <span className="t new">NEW</span>}</div>} />
        <div className="st-pdp-info">
          {p.brandName && <Link to={`${base}/c?brand=${p.brandId}`} className="brand">{p.brandName}</Link>}
          <h1>{p.name}</h1>
          <div className="sku">รหัสสินค้า {p.sku}</div>
          {v || !p.hasSizes ? <Price price={price} compare={compare} big /> : <Price price={p.price} max={p.maxPrice} compare={p.comparePrice} big />}
          {off > 0 && <div className="save">ประหยัด {fmtMoney(compare - price)}</div>}
          {memberPrice != null && memberPrice < price && <div className="mp">ราคาสมาชิก {fmtMoney(memberPrice)} {!st.token && <Link to={`${base}/login?next=${encodeURIComponent(location.pathname)}`}>เข้าสู่ระบบ</Link>}</div>}
          {p.hasSizes && (
            <div className={`st-sizes ${needSize ? 'need' : ''}`}>
              <div className="row between"><b>ไซส์{v ? `: ${v.label}` : ''}</b>{p.sizeChart && <button className="st-link" onClick={() => setChart(true)}>ตารางไซส์</button>}</div>
              <div className="grid">{p.variants.map((x: any) => (
                <button key={x.id} className={size === x.id ? 'on' : ''} disabled={!x.available} onClick={() => { setSize(x.id); setQty(1); setNeedSize(false); }} title={x.available ? '' : 'สินค้าหมด'}>{x.label}</button>
              ))}</div>
            </div>
          )}
          {!p.hasSizes && p.sizeChart && <button className="st-link" onClick={() => setChart(true)}>ตารางไซส์</button>}
          <div className="stock">{!available ? <span className="err">สินค้าหมด</span> : stock != null ? <span className={stock <= 5 ? 'warn' : 'ok'}>{stock <= 5 ? `เหลือเพียง ${fmtQty(stock)} ชิ้น` : '● มีสินค้า'}</span> : p.hasSizes && !v ? <span className="muted">เลือกไซส์เพื่อดูสต็อก</span> : null}</div>
          <div className="row" style={{ gap: 10, flexWrap: 'nowrap' }}>
            <div className="st-qty">
              <button onClick={() => setQty((q) => Math.max(step, +(q - step).toFixed(3)))} aria-label="ลด">−</button>
              <input inputMode="decimal" value={qty} onChange={(e) => { const n = Number(e.target.value); if (n >= 0) setQty(p.isWeighted ? n : Math.floor(n)); }} />
              <button onClick={() => setQty((q) => +(q + step).toFixed(3))} aria-label="เพิ่ม">+</button>
            </div>
            {p.isWeighted && <span className="small muted">กก.</span>}
            <button className={`st-icon fav ${saved ? 'on' : ''}`} onClick={() => st.toggleWish(p)} aria-label="รายการโปรด"><Ic n="heart" fill={saved} /></button>
          </div>
          <div className="st-buy">
            <button className="st-btn block" disabled={!available || qty <= 0} onClick={() => add(false)}>{available ? 'เพิ่มลงตะกร้า' : 'สินค้าหมด'}</button>
            <button className="st-btn accent block" disabled={!available || qty <= 0} onClick={() => add(true)}>ซื้อเลย</button>
          </div>
          <ul className="st-svc">
            {s.delivery && <li><Ic n="truck" s={18} /> จัดส่ง {s.deliveryFee ? fmtMoney(s.deliveryFee) : 'ฟรี'}{s.freeDeliveryMin ? ` · ส่งฟรีเมื่อซื้อครบ ${fmtMoney(s.freeDeliveryMin)}` : ''}</li>}
            {s.pickup && <li><Ic n="store" s={18} /> รับสินค้าได้ที่ {info.branch?.name}</li>}
          </ul>
          {p.description && <Acc title="รายละเอียดสินค้า" open><p className="pre">{p.description}</p></Acc>}
          {p.sizeChart && <Acc title="ตารางไซส์"><SizeChartTable chart={p.sizeChart} /></Acc>}
          {s.shippingInfo && <Acc title="การจัดส่ง"><p className="pre">{s.shippingInfo}</p></Acc>}
          {s.returnInfo && <Acc title="การคืนสินค้า"><p className="pre">{s.returnInfo}</p></Acc>}
        </div>
      </div>
      {p.related.length > 0 && <section className="st-sec"><div className="st-sec-head"><h2>สินค้าที่คุณอาจชอบ</h2></div><div className="st-rail">{p.related.map((x: any) => <Card key={x.id} p={x} />)}</div></section>}
      <div className="st-sticky only-sm"><Price price={price} compare={compare} /><button className="st-btn" disabled={!available} onClick={() => add(false)}>{p.hasSizes && !v ? 'เลือกไซส์' : 'เพิ่มลงตะกร้า'}</button></div>
      {chart && p.sizeChart && <Modal title="ตารางไซส์" onClose={() => setChart(false)} width={640}><SizeChartTable chart={p.sizeChart} /></Modal>}
    </div>
  );
}

// ---------------- cart ----------------
function useQuote(fulfillment: 'pickup' | 'delivery', enabled = true) {
  const { slug, st } = useStore();
  const [quote, setQuote] = useState<any>(null);
  const [err, setErr] = useState<any>(null);
  const key = JSON.stringify(st.cart.map((l) => [l.productId, l.qty])) + fulfillment + (st.token ?? '');
  useEffect(() => {
    if (!enabled) return;
    if (!st.cart.length) { setQuote(null); setErr(null); return; }
    const ctrl = new AbortController();
    api(`/api/shop/s/${slug}/quote`, { body: { items: st.cart.map((l) => ({ productId: l.productId, qty: l.qty })), fulfillment }, token: st.token, signal: ctrl.signal })
      .then((q) => { setQuote(q); setErr(null); }).catch((e) => { if (e.code !== 'NETWORK') { setErr(e); setQuote(null); } });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return { quote, err };
}

function FreeShip({ subtotal }: { subtotal: number }) {
  const { info } = useStore();
  const min = info.store.freeDeliveryMin;
  if (!info.store.delivery || !min) return null;
  const left = min - subtotal;
  return (
    <div className="st-free">
      {left > 0 ? <>ซื้อเพิ่มอีก <b>{fmtMoney(left)}</b> เพื่อรับสิทธิ์ <b>ส่งฟรี</b></> : <b>🎉 คุณได้รับสิทธิ์ส่งฟรี</b>}
      <div className="bar"><i style={{ width: `${Math.min(100, (subtotal / min) * 100)}%` }} /></div>
    </div>
  );
}

function CartLines({ quote, err, compact }: { quote: any; err: any; compact?: boolean }) {
  const { st, base } = useStore();
  const stockOf = (id: number) => quote?.lines.find((l: any) => l.productId === id)?.stock ?? null;
  const setQty = (i: number, qty: number) => { const c = [...st.cart]; if (qty <= 0) c.splice(i, 1); else c[i] = { ...c[i], qty }; st.setCart(c); };
  const badId = err?.details?.productId;
  return (
    <div className={`st-lines ${compact ? 'compact' : ''}`}>
      {st.cart.map((l, i) => {
        const s = stockOf(l.productId);
        return (
          <div key={l.productId} className={`st-line ${badId === l.productId ? 'bad' : ''}`}>
            <Link to={`${base}/p/${l.parentId}`} className="ph">{l.image ? <img src={l.image} alt="" /> : null}</Link>
            <div className="grow">
              {l.brand && <div className="brand">{l.brand}</div>}
              <div className="nm">{l.name}</div>
              {l.label && <div className="small muted">ไซส์: {l.label}</div>}
              <Price price={l.price} compare={l.comparePrice} />
              {s != null && l.qty > s && <div className="small err">เหลือเพียง {fmtQty(s)}</div>}
              {badId === l.productId && <div className="small err">{err.message}</div>}
              <div className="row between" style={{ marginTop: 6 }}>
                <div className="st-qty sm">
                  <button onClick={() => setQty(i, +(l.qty - (l.isWeighted ? 0.1 : 1)).toFixed(3))} aria-label="ลด">−</button>
                  <span>{fmtQty(l.qty)}</span>
                  <button onClick={() => setQty(i, +(l.qty + (l.isWeighted ? 0.1 : 1)).toFixed(3))} aria-label="เพิ่ม">+</button>
                </div>
                <button className="st-link muted" onClick={() => setQty(i, 0)}>ลบ</button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { st, base, info } = useStore();
  const nav = useNavigate();
  const { quote, err } = useQuote('pickup', open);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  const over = st.cart.some((l) => { const s = quote?.lines.find((x: any) => x.productId === l.productId)?.stock; return s != null && l.qty > s; });
  return (
    <div className={`st-drawer-bg ${open ? '' : 'hidden'}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="st-drawer right" aria-hidden={!open}>
        <div className="st-drawer-head"><b>ตะกร้าสินค้า ({st.cart.length})</b><button className="st-icon" onClick={onClose} aria-label="ปิด"><Ic n="x" /></button></div>
        {!st.cart.length ? (
          <div className="st-msg" style={{ flex: 1 }}><Ic n="bag" s={48} /><p>ยังไม่มีสินค้าในตะกร้า</p><button className="st-btn" onClick={() => { onClose(); nav(`${base}/c`); }}>เลือกซื้อสินค้า</button></div>
        ) : (
          <>
            <FreeShip subtotal={quote?.total ?? st.cart.reduce((a, l) => a + l.price * l.qty, 0)} />
            <div className="st-drawer-body"><CartLines quote={quote} err={err} compact /></div>
            <div className="st-drawer-foot">
              {quote?.discount > 0 && <div className="row between ok small"><span>ส่วนลด</span><span>−{fmtMoney(quote.discount)}</span></div>}
              <div className="row between"><b>ยอดรวม</b><b className="big">{quote ? fmtMoney(quote.total) : '…'}</b></div>
              <small className="muted">ค่าจัดส่งคำนวณในขั้นตอนชำระเงิน</small>
              {err && !err.details?.productId && <div className="err small">{err.message}</div>}
              <button className="st-btn block" disabled={!quote || over || !info.store} onClick={() => { onClose(); nav(`${base}/checkout`); }}>ชำระเงิน</button>
              <button className="st-btn ghost block" onClick={() => { onClose(); nav(`${base}/cart`); }}>ดูตะกร้าสินค้า</button>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function Totals({ quote, fulfillment }: { quote: any; fulfillment: string }) {
  if (!quote) return null;
  return (
    <div className="st-totals">
      <div className="row between"><span>ราคาสินค้า</span><span>{fmtMoney(quote.subtotal)}</span></div>
      {quote.applied?.map((d: any, i: number) => <div key={i} className="row between ok small"><span>{d.name}</span><span>−{fmtMoney(d.amount)}</span></div>)}
      {fulfillment === 'delivery' && <div className="row between"><span>ค่าจัดส่ง</span><span>{quote.shipping ? fmtMoney(quote.shipping) : 'ฟรี'}</span></div>}
      <div className="row between total"><b>ยอดรวม</b><b>{fmtMoney(quote.total)}</b></div>
    </div>
  );
}

function CartPage() {
  const { st, base, info } = useStore();
  const nav = useNavigate();
  const { quote, err } = useQuote('pickup');
  if (!st.cart.length) return <div className="st-msg"><h2>ตะกร้าว่าง</h2><Link className="st-btn" to={`${base}/c`}>เลือกซื้อสินค้า</Link></div>;
  const over = st.cart.some((l) => { const s = quote?.lines.find((x: any) => x.productId === l.productId)?.stock; return s != null && l.qty > s; });
  const minOk = !info.store.minOrder || (quote && quote.total >= info.store.minOrder);
  return (
    <div className="st-wrap st-two">
      <div><h1 className="st-h1">ตะกร้าสินค้า</h1><CartLines quote={quote} err={err} /></div>
      <aside className="st-summary">
        <h3>สรุปคำสั่งซื้อ</h3>
        <FreeShip subtotal={quote?.total ?? 0} />
        <Totals quote={quote} fulfillment="pickup" />
        {err && !err.details?.productId && <div className="err small">{err.message}</div>}
        {!minOk && <div className="warn small">ยอดสั่งซื้อขั้นต่ำ {fmtMoney(info.store.minOrder)}</div>}
        <button className="st-btn block" disabled={!quote || over || !minOk} onClick={() => nav(`${base}/checkout`)}>ดำเนินการชำระเงิน</button>
        <Link to={`${base}/c`} className="st-btn ghost block">เลือกซื้อต่อ</Link>
      </aside>
    </div>
  );
}

function Checkout() {
  const { st, base, info, me, slug } = useStore();
  const nav = useNavigate();
  const toast = useToast();
  const s = info.store;
  const [f, setF] = useState<'pickup' | 'delivery'>(s.pickup ? 'pickup' : 'delivery');
  const methods = useMemo(() => (['promptpay', 'pay_at_store', 'cod'] as const).filter((m) =>
    (m === 'promptpay' && s.payments.promptpay) || (m === 'pay_at_store' && s.payments.payAtStore && f === 'pickup') || (m === 'cod' && s.payments.cod && f === 'delivery')), [f, s]);
  const [pm, setPm] = useState<string>('');
  const [c, setC] = useState(() => read('ppmart.shop.customer', { name: '', phone: '', email: '', address: '' }));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const { quote, err } = useQuote(f);
  useEffect(() => { if (!methods.includes(pm as any)) setPm(methods[0] ?? ''); }, [methods, pm]);
  useEffect(() => {
    if (me && !c.name) setC((x: any) => ({ ...x, name: [me.first_name, me.last_name].filter(Boolean).join(' '), phone: me.phone ?? x.phone, email: me.email ?? x.email, address: x.address || me.address || '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);
  if (!st.cart.length) return <div className="st-msg"><h2>ตะกร้าว่าง</h2><Link className="st-btn" to={`${base}/c`}>เลือกซื้อสินค้า</Link></div>;
  const submit = async () => {
    if (!c.name.trim() || !/^[0-9+\-\s]{9,15}$/.test(c.phone.trim())) { toast('กรุณากรอกชื่อและเบอร์โทรให้ถูกต้อง', 'warn'); return; }
    if (f === 'delivery' && c.address.trim().length <= 10) { toast('กรุณากรอกที่อยู่จัดส่งให้ครบถ้วน', 'warn'); return; }
    if (!pm) { toast('กรุณาเลือกวิธีชำระเงิน', 'warn'); return; }
    // same key across retries of this cart, so a double tap / network retry never creates two orders
    const ik = `ppmart.shop.${slug}.idem`;
    let key = sessionStorage.getItem(ik);
    if (!key) { key = uuid(); sessionStorage.setItem(ik, key); }
    setBusy(true);
    try {
      write('ppmart.shop.customer', c);
      const r = await api(`/api/shop/s/${slug}/orders`, {
        token: st.token, timeoutMs: 30000,
        body: { idempotencyKey: key, items: st.cart.map((l) => ({ productId: l.productId, qty: l.qty })), customer: { name: c.name, phone: c.phone, email: c.email || null }, fulfillment: f, address: f === 'delivery' ? c.address : null, note: note || null, paymentMethod: pm },
      });
      sessionStorage.removeItem(ik);
      write(ORDERS, [{ orderNo: r.orderNo, t: r.accessToken, at: Date.now(), slug }, ...read<any[]>(ORDERS, [])].slice(0, 50));
      st.setCart([]);
      nav(`${base}/order/${r.orderNo}?t=${r.accessToken}`, { replace: true });
    } catch (e: any) {
      if (e.code === 'DUPLICATE_ORDER') { sessionStorage.removeItem(ik); st.setCart([]); nav(`${base}/orders`); return; }
      if (e.status && e.status < 500) sessionStorage.removeItem(ik);
      toast(errMsg(e), 'err');
    } finally { setBusy(false); }
  };
  return (
    <div className="st-wrap st-two">
      <div className="st-checkout">
        <h1 className="st-h1">ชำระเงิน</h1>
        {!st.token ? <div className="st-note">เป็นสมาชิก? <Link to={`${base}/login?next=${base}/checkout`}>เข้าสู่ระบบ</Link> เพื่อรับราคาสมาชิกและสะสมคะแนน</div>
          : me && <div className="st-note ok">สั่งซื้อในนาม {[me.first_name, me.last_name].filter(Boolean).join(' ')} · ได้รับราคาสมาชิกและคะแนนสะสม</div>}
        <section>
          <h3>1. การรับสินค้า</h3>
          <div className="st-opts">
            {s.pickup && <label className={`st-opt ${f === 'pickup' ? 'on' : ''}`}><input type="radio" checked={f === 'pickup'} onChange={() => setF('pickup')} /><b><Ic n="store" s={18} /> รับที่สาขา</b><small>{info.branch?.name}{info.branch?.address ? ` · ${info.branch.address}` : ''}</small></label>}
            {s.delivery && <label className={`st-opt ${f === 'delivery' ? 'on' : ''}`}><input type="radio" checked={f === 'delivery'} onChange={() => setF('delivery')} /><b><Ic n="truck" s={18} /> จัดส่งถึงบ้าน</b><small>ค่าส่ง {fmtMoney(s.deliveryFee)}{s.freeDeliveryMin ? ` · ฟรีเมื่อซื้อครบ ${fmtMoney(s.freeDeliveryMin)}` : ''}</small></label>}
          </div>
        </section>
        <section className="st-form">
          <h3>2. ข้อมูลผู้สั่งซื้อ</h3>
          <input placeholder="ชื่อ-นามสกุล *" autoComplete="name" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
          <input placeholder="เบอร์โทรศัพท์ *" inputMode="tel" autoComplete="tel" value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} />
          <input placeholder="อีเมล (ไม่บังคับ)" type="email" autoComplete="email" value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} />
          {f === 'delivery' && <textarea rows={3} placeholder="ที่อยู่จัดส่ง (บ้านเลขที่ ถนน ตำบล อำเภอ จังหวัด รหัสไปรษณีย์) *" autoComplete="street-address" value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} />}
          <input placeholder="หมายเหตุถึงร้าน (ไม่บังคับ)" value={note} onChange={(e) => setNote(e.target.value)} />
        </section>
        <section>
          <h3>3. วิธีชำระเงิน</h3>
          <div className="st-opts">{methods.map((m) => <label key={m} className={`st-opt ${pm === m ? 'on' : ''}`}><input type="radio" checked={pm === m} onChange={() => setPm(m)} /><b>{PAY[m]}</b>{m === 'promptpay' && <small>สแกน QR ชำระภายใน {s.paymentTimeoutMinutes} นาที</small>}</label>)}</div>
          {!methods.length && <div className="err small">ไม่มีวิธีชำระเงินสำหรับการรับสินค้าแบบนี้</div>}
        </section>
      </div>
      <aside className="st-summary">
        <h3>สรุปคำสั่งซื้อ ({st.cart.length})</h3>
        {st.cart.map((l) => <div key={l.productId} className="st-mini"><span className="ph">{l.image && <img src={l.image} alt="" />}<b>{fmtQty(l.qty)}</b></span><span className="grow">{l.name}{l.label ? ` · ${l.label}` : ''}</span><span>{fmtMoney(quote?.lines.find((x: any) => x.productId === l.productId)?.total ?? l.price * l.qty)}</span></div>)}
        {err && <div className="err small">{err.message} — <Link to={`${base}/cart`}>แก้ไขตะกร้า</Link></div>}
        <Totals quote={quote} fulfillment={f} />
        <button className="st-btn block" disabled={busy || !quote || !pm} onClick={submit}>{busy ? 'กำลังส่งคำสั่งซื้อ…' : `ยืนยันสั่งซื้อ ${quote ? fmtMoney(quote.total) : ''}`}</button>
      </aside>
    </div>
  );
}

// ---------------- orders ----------------
const STEPS = ['pending_payment', 'paid', 'preparing', 'ready', 'completed'];
function OrderPage() {
  const { st, base } = useStore();
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
  if (err) return <div className="st-msg">{err}</div>;
  if (!o) return <div className="st-msg">กำลังโหลด…</div>;
  const steps = o.fulfillment === 'delivery' ? STEPS.map((s) => (s === 'ready' ? 'shipped' : s)) : STEPS;
  const cur = o.status === 'shipped' && o.fulfillment !== 'delivery' ? 3 : steps.indexOf(o.status);
  const share = `${location.origin}${base}/order/${o.orderNo}?t=${t}`;
  return (
    <div className="st-wrap st-order">
      <div className="row between"><h1 className="st-h1" style={{ margin: 0 }}>คำสั่งซื้อ {o.orderNo}</h1><span className={`badge ${o.status}`}>{STATUS[o.status]}</span></div>
      <div className="small muted">{fmtDate(o.createdAt)} · {o.fulfillment === 'pickup' ? `รับที่ ${o.branch?.name ?? ''}` : 'จัดส่ง'} · {PAY[o.paymentMethod]}</div>
      {o.status !== 'cancelled' ? <ol className="st-steps">{steps.map((s, i) => <li key={s} className={i <= cur ? 'done' : ''}>{STATUS[s]}</li>)}</ol>
        : <div className="st-note err">ยกเลิกแล้ว{o.cancelledReason ? `: ${o.cancelledReason}` : ''}</div>}
      {o.status === 'pending_payment' && o.payment && o.paymentMethod === 'promptpay' && (
        <div className="st-paybox">
          <b>สแกนเพื่อชำระเงินด้วยพร้อมเพย์</b>
          <div style={{ margin: '10px auto' }}>{o.payment.qrImageUrl ? <img src={o.payment.qrImageUrl} alt="PromptPay QR" style={{ width: 240 }} /> : o.payment.qrPayload ? <QrCanvas value={o.payment.qrPayload} size={240} /> : null}</div>
          <div className="big">{fmtMoney(o.payment.amount)}</div>
          <div className="small muted">{o.payment.status === 'needs_review' ? 'ได้รับหลักฐานแล้ว กำลังตรวจสอบ…' : 'หน้านี้จะอัปเดตอัตโนมัติเมื่อชำระเงินสำเร็จ'}</div>
        </div>
      )}
      {o.status === 'pending_payment' && o.paymentMethod === 'pay_at_store' && <div className="st-note">ชำระเงินที่ร้านเมื่อมารับสินค้า — แจ้งเลขคำสั่งซื้อ <b>{o.orderNo}</b> กับพนักงาน</div>}
      {o.trackingNo && <div className="st-note">เลขพัสดุ: <b className="mono">{o.trackingNo}</b></div>}
      <section className="st-summary">
        {o.items.map((i: any, k: number) => <div key={k} className="row between small"><span>{i.name} × {fmtQty(Number(i.qty))}</span><span>{fmtMoney(Number(i.line_total))}</span></div>)}
        <div className="st-totals">
          <div className="row between"><span>ราคาสินค้า</span><span>{fmtMoney(o.subtotal)}</span></div>
          {o.discount > 0 && <div className="row between ok"><span>ส่วนลด</span><span>−{fmtMoney(o.discount)}</span></div>}
          {o.fulfillment === 'delivery' && <div className="row between"><span>ค่าจัดส่ง</span><span>{o.shipping ? fmtMoney(o.shipping) : 'ฟรี'}</span></div>}
          <div className="row between total"><b>ยอดรวม</b><b>{fmtMoney(o.total)}</b></div>
        </div>
      </section>
      {o.address && <div className="small"><b>ที่อยู่จัดส่ง:</b> {o.address}</div>}
      {o.fulfillment === 'pickup' && o.branch && <div className="small"><b>รับสินค้าที่:</b> {o.branch.name} {o.branch.address} {o.branch.phone && `โทร ${o.branch.phone}`}</div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="st-btn ghost sm" onClick={() => { navigator.clipboard?.writeText(share); }}>คัดลอกลิงก์ติดตามคำสั่งซื้อ</button>
        <Link to={base} className="st-btn ghost sm">กลับหน้าร้าน</Link>
      </div>
    </div>
  );
}

function MyOrders() {
  const { st, base, slug } = useStore();
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    (async () => {
      const local = read<any[]>(ORDERS, []).filter((o) => !o.slug || o.slug === slug);
      const views = await Promise.all(local.map((o) => api(`/api/shop/orders/${o.orderNo}?t=${encodeURIComponent(o.t)}`, { token: null }).then((v) => ({ ...v, t: o.t })).catch(() => null)));
      const mine = st.token ? await api<any[]>('/api/shop/my-orders', { token: st.token }).catch(() => []) : [];
      const map = new Map<string, any>();
      for (const v of views) if (v && (!v.store || v.store.slug === slug)) map.set(v.orderNo, { orderNo: v.orderNo, status: v.status, total: v.total, createdAt: v.createdAt, t: v.t });
      for (const m of mine) if (!map.has(m.order_no) && (!m.store_slug || m.store_slug === slug)) map.set(m.order_no, { orderNo: m.order_no, status: m.status, total: Number(m.total), createdAt: m.created_at, t: '' });
      setRows([...map.values()].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt)));
    })();
  }, [st.token, slug]);
  return (
    <div className="st-wrap st-narrow">
      <div className="row between"><h1 className="st-h1">คำสั่งซื้อของฉัน</h1>{st.token && <button className="st-link muted" onClick={() => st.login(null)}>ออกจากระบบ</button>}</div>
      {!rows ? <div className="st-msg">กำลังโหลด…</div> : !rows.length && <p className="muted">ยังไม่มีคำสั่งซื้อ{!st.token && <> · <Link to={`${base}/login?next=${base}/orders`}>เข้าสู่ระบบสมาชิก</Link> เพื่อดูคำสั่งซื้อทั้งหมด</>}</p>}
      {rows?.map((o) => (
        <Link key={o.orderNo} to={`${base}/order/${o.orderNo}${o.t ? `?t=${o.t}` : ''}`} className="st-orow">
          <div className="grow"><b className="mono">{o.orderNo}</b><div className="small muted">{fmtDate(o.createdAt)}</div></div>
          <span className={`badge ${o.status}`}>{STATUS[o.status]}</span><b>{fmtMoney(o.total)}</b>
        </Link>
      ))}
    </div>
  );
}

function Wishlist() {
  const { st, base } = useStore();
  return (
    <div className="st-wrap">
      <h1 className="st-h1">รายการโปรด ({st.wish.length})</h1>
      {!st.wish.length ? <div className="st-msg"><Ic n="heart" s={44} /><p>กด ♡ ที่สินค้าเพื่อบันทึกไว้ดูภายหลัง</p><Link className="st-btn" to={`${base}/c`}>เลือกซื้อสินค้า</Link></div>
        : <div className="st-grid">{st.wish.map((p) => <Card key={p.id} p={p} />)}</div>}
    </div>
  );
}

function Locations() {
  const { info } = useStore();
  return (
    <div className="st-wrap st-narrow">
      <h1 className="st-h1">สาขาของเรา</h1>
      <div className="st-locs">
        {info.locations.map((b: any) => (
          <div key={b.id} className="st-loc">
            <h3>{b.name}</h3>
            {b.address && <p><Ic n="pin" s={16} /> {b.address}</p>}
            {b.phone && <p><Ic n="phone" s={16} /> <a href={`tel:${b.phone.replace(/\s/g, '')}`}>{b.phone}</a></p>}
            {b.id === info.branch?.id && info.store.pickup && <span className="badge ok">รับสินค้าออนไลน์ได้ที่สาขานี้</span>}
            {b.address && <a className="st-btn ghost sm" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.name + ' ' + b.address)}`} target="_blank" rel="noreferrer">เปิดแผนที่</a>}
          </div>
        ))}
      </div>
    </div>
  );
}

function MemberLogin() {
  const { st, base } = useStore();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const toast = useToast();
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const next = sp.get('next') || base;
  if (st.token) return <div className="st-msg"><h2>เข้าสู่ระบบแล้ว</h2><div className="row" style={{ justifyContent: 'center' }}><button className="st-btn ghost" onClick={() => st.login(null)}>ออกจากระบบ</button><Link className="st-btn" to={next}>ช้อปต่อ</Link></div></div>;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api('/api/member/login', { body: { identifier: id.trim(), password: pw }, token: null });
      st.login(r.token);
      toast('เข้าสู่ระบบแล้ว', 'ok');
      nav(next, { replace: true });
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="st-wrap st-narrow" style={{ maxWidth: 440 }}>
      <h1 className="st-h1">เข้าสู่ระบบสมาชิก</h1>
      <form className="st-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input placeholder="เบอร์โทร / อีเมล / เลขสมาชิก" autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} />
        <input type="password" placeholder="รหัสผ่าน (ครั้งแรก = 4 ตัวท้ายเบอร์โทร)" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <button className="st-btn block" disabled={busy || !id || !pw}>เข้าสู่ระบบ</button>
      </form>
      <p className="small muted">ยังไม่เป็นสมาชิก หรือเข้าด้วย OTP? <Link to="/member">ไปที่เว็บไซต์สมาชิก</Link> · หรือสั่งซื้อแบบไม่เป็นสมาชิกได้เลย</p>
    </div>
  );
}
