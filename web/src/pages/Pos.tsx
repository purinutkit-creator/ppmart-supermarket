import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, can, getSession, setSession } from '../lib/api';
import { RealtimeClient } from '../lib/ws';
import { fmtMoney, fmtQty, uuid } from '../lib/format';
import { cacheCatalog, cachedCatalog, addToOutbox, syncOutbox, getOutbox, nextBillNo, primeBillSeq } from '../lib/offline';
import { useBarcodeScanner } from '../lib/scanner';
import { applyAreaFonts } from '../lib/fonts';
import { printer } from '../lib/printer';
import { scale } from '../lib/scale';
import { setPrintSettings, printSaleReceipts, toReceiptData, printSettings, openDrawer } from '../lib/receipt-print';
import { priceCart, type PricingProduct, type PromotionDef, type CouponInput } from '../../../shared/pricing';
import { classifyBarcode, parseWeightedBarcode } from '../../../shared/barcode';
import { Modal, errMsg, useToast, useWithApproval, Field, MoneyInput } from '../components/ui';
import { CameraScanner } from '../components/CameraScanner';
import { DevicesPanel, usePrinterState, DEFAULT_PRINTER } from '../components/DevicesPanel';
import { PaymentModal, type Tender } from './pos/PaymentModal';
import { OpenShiftModal, ShiftModal, SalesModal, DisplayModal, WeightModal, CouponConfirm } from './pos/panels';
import { MemberModal, MemberDetailModal, DisplayRegisterConfirm, identifyMember } from './pos/member';

interface CartLine {
  lineId: string; productId: number; name: string; qty: number; barcode?: string | null; packQty: number;
  priceSource: 'regular' | 'pack' | 'embedded' | 'override'; unitPrice?: number | null; overrideApprovalId?: string | null; isWeighted: boolean;
}
interface BillCoupon { id: string; code: string; title: string; reward: any; minSpend: number; rewardText: string }
interface Bill {
  cartId: string; lines: CartLine[]; member: any | null; coupons: BillCoupon[]; promoCodes: string[];
  manualDiscount: { type: 'amount' | 'percent'; value: number; reason?: string; approvalId?: string | null } | null;
  redeemPoints: number; createdAt: number; idemKey?: string | null; billNo?: string | null; label?: string;
}

const newBill = (): Bill => ({ cartId: uuid(), lines: [], member: null, coupons: [], promoCodes: [], manualDiscount: null, redeemPoints: 0, createdAt: Date.now() });

export default function Pos() {
  const nav = useNavigate();
  const toast = useToast();
  const withApproval = useWithApproval();
  const session = getSession()!;
  const p = usePrinterState();
  const billsKey = `ppmart.bills.${session.terminalId}`;

  const [catalog, setCatalog] = useState<any>(null);
  const [online, setOnline] = useState(true);
  const [wsOk, setWsOk] = useState(false);
  const [outboxN, setOutboxN] = useState(0);
  const wsRef = useRef<RealtimeClient | null>(null);
  const [bills, setBills] = useState<Bill[]>(() => { try { const b = JSON.parse(localStorage.getItem(billsKey) || '[]'); return b.length ? b : [newBill()]; } catch { return [newBill()]; } });
  const [active, setActive] = useState(0);
  const bill = bills[Math.min(active, bills.length - 1)];
  const [sel, setSel] = useState<string | null>(null);
  const [shift, setShift] = useState<any>(undefined);
  const [modal, setModal] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [weighFor, setWeighFor] = useState<{ product: any; barcode: string } | null>(null);
  const [couponCheck, setCouponCheck] = useState<any>(null);
  const [locked, setLocked] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<any>(null);
  const [paidInfo, setPaidInfo] = useState<any>(null);
  const [displayPrompt, setDisplayPrompt] = useState<'identify' | 'register' | null>(null);
  const [registerReq, setRegisterReq] = useState<any>(null);
  const [displayPresence, setDisplayPresence] = useState<{ online: number; paired: number }>({ online: 0, paired: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const terminal = catalog?.terminal;
  const settings = catalog?.settings;

  useEffect(() => { localStorage.setItem(billsKey, JSON.stringify(bills)); }, [bills, billsKey]);
  const updateBill = useCallback((fn: (b: Bill) => Bill) => setBills((bs) => bs.map((b, i) => (i === Math.min(active, bs.length - 1) ? { ...fn(b), idemKey: null, billNo: null } : b))), [active]);

  // ---------------- catalog / settings / devices ----------------
  const loadCatalog = useCallback(async () => {
    try {
      const c = await api('/api/pos/catalog', { timeoutMs: 30000 });
      setCatalog(c); setOnline(true); await cacheCatalog(c);
      if (c.terminal?.code) await primeBillSeq(c.terminal.code, Number(c.terminal.last_bill_seq ?? 0));
      return c;
    } catch (e) {
      if ((e as ApiError).status === 0) {
        setOnline(false);
        const c = await cachedCatalog();
        if (c) { setCatalog(c); toast('ออฟไลน์ — ใช้ข้อมูลสินค้าที่บันทึกไว้ในเครื่อง', 'warn'); return c; }
      }
      toast(errMsg(e), 'err');
    }
  }, [toast]);

  useEffect(() => {
    (async () => {
      const c = await loadCatalog();
      if (!c) return;
      applyAreaFonts(c.settings.fonts);
      const dev = c.terminal?.settings || {};
      const ro = dev.receiptOptions || {};
      setPrintSettings({ receipt: c.settings.receipt ? { ...c.settings.receipt, ...ro } : null, store: c.settings.store, tax: c.settings.tax });
      await printer.configure({ ...DEFAULT_PRINTER, ...(dev.printer || {}) });
      if (dev.scale?.baudRate) scale.connect(dev.scale.baudRate, false).catch(() => {});
      try { setShift(await api('/api/shifts/current')); } catch { setShift(null); }
    })();
  }, []); // eslint-disable-line

  // ---------------- realtime + connectivity ----------------
  useEffect(() => {
    const ws = new RealtimeClient(`token=${encodeURIComponent(session.token)}`);
    wsRef.current = ws;
    const offs = [
      ws.on('_status', (s) => setWsOk(s.connected)),
      ws.on('_unauthorized', () => { setSession(null); nav('/login'); }),
      ws.on('presence', (pr) => setDisplayPresence((d) => ({ ...d, online: pr.displays?.length ?? 0 }))),
      ws.on('catalog.changed', () => { clearTimeout((window as any).__catT); (window as any).__catT = setTimeout(loadCatalog, 1500); }),
      ws.on('stock.changed', () => { clearTimeout((window as any).__stT); (window as any).__stT = setTimeout(loadCatalog, 5000); }),
      ws.on('settings.changed', () => loadCatalog()),
    ];
    return () => { offs.forEach((f) => f()); ws.close(); };
  }, []); // eslint-disable-line

  useEffect(() => {
    const ping = async () => {
      try { await api('/api/health', { token: null, timeoutMs: 5000 }); if (!online) { setOnline(true); const r = await syncOutbox(); if (r.synced) toast(`ซิงก์บิลออฟไลน์สำเร็จ ${r.synced} บิล`, 'ok'); loadCatalog(); } }
      catch { setOnline(false); }
      setOutboxN((await getOutbox()).length);
    };
    const iv = setInterval(ping, 15000);
    const onl = () => ping();
    window.addEventListener('online', onl); window.addEventListener('offline', () => setOnline(false));
    const ob = async () => setOutboxN((await getOutbox()).length);
    window.addEventListener('ppmart-outbox', ob);
    ping();
    return () => { clearInterval(iv); window.removeEventListener('online', onl); window.removeEventListener('ppmart-outbox', ob); };
  }, [online]); // eslint-disable-line

  // ---------------- customer self-service on the customer display ----------------
  const attachMemberRef = useRef<(m: any) => void>(() => {});
  attachMemberRef.current = (m: any) => { updateBill((b) => ({ ...b, member: m })); toast(`สมาชิก: ${m.first_name} (${m.tier_name ?? ''})`, 'ok'); };
  const askDisplay = (mode: 'identify' | 'register' | null) => {
    wsRef.current?.send('display.command', { type: mode ? `member.${mode}` : 'member.close' });
    setDisplayPrompt(mode);
  };
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    return ws.on('display.input', async (p) => {
      if (p.kind === 'member.identify') {
        try {
          const m = await identifyMember(p.method, String(p.value));
          attachMemberRef.current(m);
          ws.send('display.command', { type: 'member.result', ok: true, name: m.first_name, tier: m.tier_name, points: m.points });
          setDisplayPrompt(null);
        } catch (e) {
          ws.send('display.command', { type: 'member.result', ok: false, message: errMsg(e) });
        }
      } else if (p.kind === 'member.register') {
        setRegisterReq(p.profile);
      } else if (p.kind === 'member.cancel') {
        setDisplayPrompt(null);
      }
    });
  }, [wsOk]); // eslint-disable-line

  // ---------------- auto lock ----------------
  useEffect(() => {
    const mins = settings?.pos?.autoLockMinutes ?? 5;
    if (!mins) return;
    let t = setTimeout(() => setLocked(true), mins * 60000);
    const reset = () => { clearTimeout(t); t = setTimeout(() => setLocked(true), mins * 60000); };
    ['keydown', 'pointerdown'].forEach((ev) => window.addEventListener(ev, reset));
    return () => { clearTimeout(t); ['keydown', 'pointerdown'].forEach((ev) => window.removeEventListener(ev, reset)); };
  }, [settings?.pos?.autoLockMinutes]);

  // ---------------- indexes ----------------
  const idx = useMemo(() => {
    const byId = new Map<number, any>(), byBarcode = new Map<string, { product: any; packQty: number; packPrice: number | null }>(), bySku = new Map<string, any>();
    for (const pr of catalog?.products ?? []) {
      byId.set(pr.id, pr); bySku.set(pr.sku.toUpperCase(), pr);
      for (const b of pr.barcodes) byBarcode.set(b.barcode, { product: pr, packQty: Number(b.packQty), packPrice: b.packPrice });
    }
    return { byId, byBarcode, bySku };
  }, [catalog]);

  const pricingProducts = useMemo(() => {
    const m = new Map<number, PricingProduct>();
    for (const pr of catalog?.products ?? []) m.set(pr.id, { id: pr.id, name: pr.name, price: pr.price, memberPrice: pr.memberPrice, wholesalePrice: pr.wholesalePrice, wholesaleMinQty: pr.wholesaleMinQty, categoryId: pr.categoryId, brandId: pr.brandId, vatExempt: pr.vatExempt, isWeighted: pr.isWeighted });
    return m;
  }, [catalog]);

  const tier = useMemo(() => catalog?.tiers?.find((t: any) => t.id === bill.member?.tier_id), [catalog, bill.member]);
  const pointsCfg = settings?.points;

  const priced = useMemo(() => {
    if (!catalog) return null;
    try {
      return priceCart({
        lines: bill.lines.map((l) => ({ lineId: l.lineId, productId: l.productId, qty: l.qty, unitPrice: l.priceSource === 'regular' ? null : l.unitPrice })),
        products: pricingProducts, promotions: catalog.promotions as PromotionDef[],
        coupons: bill.coupons.map<CouponInput>((c) => ({ id: c.id, code: c.code, title: c.title, reward: c.reward, minSpend: c.minSpend })),
        manualDiscount: bill.manualDiscount, pointsDiscount: bill.redeemPoints * (pointsCfg?.pointValue ?? 0),
        ctx: { now: new Date(), timeZone: settings.store.timeZone || 'Asia/Bangkok', branchId: catalog.branchId, member: bill.member ? { id: bill.member.id, tierId: bill.member.tier_id, birthday: bill.member.birthday } : null, promoCodes: bill.promoCodes, vat: { mode: settings.tax.mode, rate: Number(settings.tax.rate) }, tierDiscountPct: tier ? Number(tier.discount_pct) : 0 },
      });
    } catch (e) { console.error(e); return null; }
  }, [bill, catalog, pricingProducts, tier, pointsCfg, settings]);

  const pointsToEarn = bill.member && pointsCfg?.enabled && priced ? Math.floor(Math.floor(priced.total / pointsCfg.spendPerPoint) * Number(tier?.point_multiplier ?? 1)) : 0;

  // ---------------- customer display sync ----------------
  const lastAdded = useRef<string | null>(null);
  const pushDisplay = useCallback((extra: any = {}) => {
    const ws = wsRef.current;
    if (!ws || !priced) return;
    const lines = priced.lines.map((l) => {
      const pr = idx.byId.get(l.productId);
      return { id: l.lineId, name: l.name, nameEn: pr?.nameEn, nameZh: pr?.nameZh, qty: l.qty, isWeighted: l.isWeighted, unitPrice: l.unitPrice, total: l.total, discount: l.itemDiscount + l.billDiscountShare, labels: l.labels };
    });
    ws.send('display.state', {
      status: bill.lines.length ? 'cart' : 'idle', lines, lastLineId: lastAdded.current, subtotal: priced.subtotal, discount: priced.discountTotal, total: priced.total,
      itemsCount: priced.itemsCount, member: bill.member ? { name: bill.member.first_name, tier: bill.member.tier_name, points: bill.member.points } : null, pointsToEarn,
      coupons: bill.coupons.map((c) => ({ code: c.code, rewardText: c.rewardText })), ...extra,
    });
  }, [priced, bill, idx, pointsToEarn]);
  useEffect(() => { if (!paidInfo && modal !== 'pay') pushDisplay(); }, [pushDisplay, paidInfo, modal]);

  // ---------------- cart ops ----------------
  const addProduct = useCallback((pr: any, opts: { qty?: number; barcode?: string | null; packQty?: number; packPrice?: number | null; embeddedPrice?: number | null; weightKg?: number | null } = {}) => {
    if (pr.saleBlocked) { toast(`⛔ ห้ามจำหน่าย: ${pr.name}${pr.blockReason ? '\n' + pr.blockReason : ''}`, 'err'); return; }
    if (!pr.isActive) { toast(`สินค้าถูกปิดการขาย: ${pr.name}`, 'err'); return; }
    if (pr.isWeighted && opts.weightKg == null && opts.embeddedPrice == null) { setWeighFor({ product: pr, barcode: opts.barcode ?? '' }); return; }
    const packQty = opts.packQty ?? 1;
    const qty = opts.weightKg ?? opts.qty ?? 1;
    const inCart = bill.lines.filter((l) => l.productId === pr.id).reduce((a, l) => a + l.qty * l.packQty, 0);
    if (pr.trackStock && pr.stock != null && !settings?.pos?.allowNegativeStock && inCart + qty * packQty > Number(pr.stock)) {
      toast(`⚠️ สินค้าหมดสต็อก/ไม่พอ: ${pr.name} (คงเหลือ ${fmtQty(Number(pr.stock))})`, 'err');
      return;
    }
    const priceSource: CartLine['priceSource'] = opts.embeddedPrice != null ? 'embedded' : packQty !== 1 || opts.packPrice != null ? 'pack' : 'regular';
    const unitPrice = priceSource === 'embedded' ? opts.embeddedPrice : priceSource === 'pack' ? opts.packPrice ?? Math.round(pr.price * packQty) : null;
    updateBill((b) => {
      const same = !pr.isWeighted && priceSource !== 'embedded' ? b.lines.find((l) => l.productId === pr.id && l.priceSource === priceSource && l.packQty === packQty) : null;
      if (same) {
        lastAdded.current = same.lineId; setSel(same.lineId);
        return { ...b, lines: b.lines.map((l) => (l === same ? { ...l, qty: l.qty + qty } : l)) };
      }
      const line: CartLine = { lineId: uuid(), productId: pr.id, name: pr.name + (packQty !== 1 ? ` ×${packQty}` : ''), qty, barcode: opts.barcode ?? null, packQty, priceSource, unitPrice, isWeighted: pr.isWeighted };
      lastAdded.current = line.lineId; setSel(line.lineId);
      return { ...b, lines: [...b.lines, line] };
    });
  }, [bill.lines, settings, toast, updateBill]);

  const handleCoupon = async (code: string) => {
    if (!online) { toast('ต้องออนไลน์เพื่อตรวจสอบคูปองกับเซิร์ฟเวอร์', 'err'); return; }
    if (bill.coupons.some((c) => c.code === code.toUpperCase())) { toast('คูปองนี้อยู่ในบิลแล้ว', 'warn'); return; }
    try {
      const chk = await api('/api/pos/coupons/validate', { body: { code, cartId: bill.cartId, memberId: bill.member?.id ?? null } });
      let discount: number | null = null;
      if (chk.valid && priced) {
        const test = priceCart({
          lines: bill.lines.map((l) => ({ lineId: l.lineId, productId: l.productId, qty: l.qty, unitPrice: l.priceSource === 'regular' ? null : l.unitPrice })), products: pricingProducts, promotions: catalog.promotions,
          coupons: [...bill.coupons.map((c) => ({ id: c.id, code: c.code, title: c.title, reward: c.reward, minSpend: c.minSpend })), { id: chk.coupon.id, code: chk.coupon.code, title: chk.coupon.title, reward: chk.coupon.reward, minSpend: chk.coupon.minSpend }],
          manualDiscount: bill.manualDiscount, ctx: { now: new Date(), timeZone: settings.store.timeZone, branchId: catalog.branchId, member: bill.member ? { id: bill.member.id, tierId: bill.member.tier_id, birthday: bill.member.birthday } : null, vat: settings.tax, tierDiscountPct: tier ? Number(tier.discount_pct) : 0 },
        });
        const r = test.couponResults.find((x) => x.couponId === chk.coupon.id);
        discount = r?.ok ? r.amount : null;
        if (!r?.ok) chk.previewError = r?.reason;
      }
      setCouponCheck({ ...chk, discount });
    } catch (e) { toast(errMsg(e), 'err'); }
  };

  const useCoupon = async () => {
    const chk = couponCheck;
    try {
      const c = await api('/api/pos/coupons/reserve', { body: { code: chk.code, cartId: bill.cartId, memberId: bill.member?.id ?? null } });
      updateBill((b) => ({ ...b, coupons: [...b.coupons, { id: c.id, code: c.code, title: c.title, reward: c.reward, minSpend: c.minSpend, rewardText: c.rewardText }] }));
      toast(`ใช้คูปอง ${c.code} แล้ว (จองไว้กับบิลนี้)`, 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
    setCouponCheck(null);
  };

  const removeCoupon = async (code: string) => {
    await api('/api/pos/coupons/release', { body: { cartId: bill.cartId, code, reason: 'removed from bill' } }).catch(() => {});
    updateBill((b) => ({ ...b, coupons: b.coupons.filter((c) => c.code !== code) }));
  };

  const handleCode = useCallback(async (raw: string) => {
    let code = raw.trim();
    if (!code) return;
    let mult = 1;
    const m = code.match(/^(\d+(?:\.\d+)?)\*(.+)$/);
    if (m) { mult = Number(m[1]); code = m[2]; }
    const kind = classifyBarcode(code);
    if (kind === 'COUPON') return handleCoupon(code);
    if (kind === 'MEMBER') {
      try { const r = await api(`/api/pos/members/find?q=${encodeURIComponent(code)}`); if (r[0]) { updateBill((b) => ({ ...b, member: r[0] })); toast(`สมาชิก: ${r[0].first_name} (${r[0].tier_name ?? ''})`, 'ok'); } else toast('ไม่พบสมาชิก', 'err'); } catch (e) { toast(errMsg(e), 'err'); }
      return;
    }
    if (kind === 'GIFT') { toast('บัตรของขวัญ: ใช้ในขั้นตอนชำระเงิน', 'warn'); return; }
    const hit = idx.byBarcode.get(code);
    if (hit) return addProduct(hit.product, { qty: mult, barcode: code, packQty: hit.packQty, packPrice: hit.packPrice ?? (hit.packQty !== 1 ? null : undefined) });
    const w = parseWeightedBarcode(code, settings?.pos?.weightedBarcode);
    if (w) {
      const h2 = idx.byBarcode.get(w.plu);
      if (h2) return addProduct(h2.product, { barcode: code, weightKg: w.weightKg ?? 1, embeddedPrice: w.priceSatang });
    }
    const bySku = idx.bySku.get(code.toUpperCase());
    if (bySku) return addProduct(bySku, { qty: mult });
    if (online) {
      try { const r = await api(`/api/pos/lookup/${encodeURIComponent(code)}`); return addProduct(r.product, { qty: mult, barcode: code, packQty: r.match.packQty, packPrice: r.match.packPrice, weightKg: r.match.weightKg, embeddedPrice: r.match.priceSatang }); }
      catch { /* fallthrough */ }
    }
    // member card (RFID tap / card barcode / card number) scanned at the till
    if (online) {
      try { const mm = await identifyMember('tap', code); attachMemberRef.current(mm); return; } catch { /* not a member card */ }
    }
    // name search fallback
    const term = code.toLowerCase();
    const found = (catalog?.products ?? []).filter((x: any) => x.name.toLowerCase().includes(term) || x.nameEn?.toLowerCase().includes(term));
    if (found.length === 1) return addProduct(found[0], { qty: mult });
    if (found.length > 1) { setInput(code); setModal('search'); return; }
    toast(`ไม่พบสินค้า: ${code}`, 'err');
    new Audio('data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=').play().catch(() => {});
  }, [idx, addProduct, settings, online, catalog, updateBill, toast]); // eslint-disable-line

  useBarcodeScanner((c) => { if (!modal && !locked && !couponCheck && !weighFor) handleCode(c); }, true);

  const selLine = bill.lines.find((l) => l.lineId === sel) ?? bill.lines[bill.lines.length - 1];
  const changeQty = (lineId: string, qty: number) => {
    if (qty <= 0) return removeLine(lineId);
    updateBill((b) => ({ ...b, lines: b.lines.map((l) => (l.lineId === lineId ? { ...l, qty: l.isWeighted ? qty : Math.round(qty) } : l)) }));
  };
  const removeLine = async (lineId: string) => {
    if (!can('pos.void_item')) {
      const ok = await withApproval('pos.void_item', 'ลบรายการ', async (id) => { if (!id) throw new ApiError(403, 'ต้องอนุมัติ', 'APPROVAL_REQUIRED', { permission: 'pos.void_item' }); return id; });
      if (!ok) return;
    }
    updateBill((b) => ({ ...b, lines: b.lines.filter((l) => l.lineId !== lineId) }));
  };

  const cancelBill = async () => {
    if (bill.lines.length && !confirm('ยกเลิกบิลนี้ทั้งหมด?')) return;
    if (bill.coupons.length) await api('/api/pos/coupons/release', { body: { cartId: bill.cartId, reason: 'bill cancelled' } }).catch(() => {});
    setBills((bs) => { const n = bs.filter((_, i) => i !== active); return n.length ? n : [newBill()]; });
    setActive(0); setSel(null);
  };
  const holdBill = () => {
    if (!bill.lines.length) return;
    const label = prompt('ชื่อบิลที่พัก (เช่น ลูกค้าเสื้อแดง)', `บิล ${new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}`) ?? undefined;
    setBills((bs) => { const n = bs.map((b, i) => (i === active ? { ...b, label } : b)); return [...n, newBill()]; });
    setActive(bills.length); setSel(null);
    toast('พักบิลแล้ว', 'ok');
  };

  // ---------------- checkout ----------------
  const startPayment = async () => {
    if (!bill.lines.length || !priced) return;
    if (settings?.pos?.requireShift && !shift && online) { setModal('openShift'); return; }
    if (!bill.idemKey || !bill.billNo) {
      let lastSeq: number | null = null;
      if (online) { try { lastSeq = (await api('/api/pos/bill-seq')).lastSeq; } catch { /* offline */ } }
      const billNo = await nextBillNo(terminal?.code ?? 'POS', lastSeq);
      setBills((bs) => bs.map((b, i) => (i === active ? { ...b, idemKey: uuid(), billNo } : b)));
    }
    setModal('pay');
  };

  const buildLocalReceipt = (billNo: string, tenders: Tender[]) => {
    const change = tenders.reduce((a, t) => a + ((t.received ?? t.amount) - t.amount), 0);
    return {
      sale: { id: 0, billNo, createdAt: new Date().toISOString(), subtotal: priced!.subtotal, discountTotal: priced!.discountTotal, couponDiscount: 0, pointsDiscount: 0, vatAmount: priced!.vatAmount, total: priced!.total, paidTotal: priced!.total + change, change, itemsCount: priced!.itemsCount, linesCount: priced!.lines.length, pointsEarned: 0, pointsRedeemed: 0, offline: true },
      terminal: { code: terminal?.code, name: terminal?.name }, branch: { name: terminal?.branch_name, address: terminal?.branch_address, phone: terminal?.branch_phone, taxId: terminal?.branch_tax_id },
      staff: { name: session.staff.name }, member: bill.member ? { memberNo: bill.member.member_no, name: bill.member.first_name } : null,
      items: priced!.lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unitPrice, discount: l.itemDiscount + l.billDiscountShare, total: l.total, isWeighted: l.isWeighted })),
      payments: tenders.map((t) => ({ method: t.method, amount: t.amount, received: t.received, reference: t.reference })), discounts: priced!.discounts, coupons: [],
    };
  };

  const completeSale = async (tenders: Tender[]) => {
    const b = bills[active];
    const payload = {
      idempotencyKey: b.idemKey!, cartId: b.cartId, billNo: b.billNo!, offline: !online, clientCreatedAt: new Date().toISOString(), memberId: b.member?.id ?? null,
      lines: b.lines.map((l) => ({ lineId: l.lineId, productId: l.productId, qty: l.qty, barcode: l.barcode, packQty: l.packQty, priceSource: l.priceSource, unitPrice: l.unitPrice ?? null, overrideApprovalId: l.overrideApprovalId ?? null })),
      promoCodes: b.promoCodes, couponCodes: b.coupons.map((c) => c.code), manualDiscount: b.manualDiscount, redeemPoints: b.redeemPoints,
      payments: tenders.map((t) => ({ method: t.method, amount: t.amount, received: t.received ?? null, reference: t.reference ?? null, paymentIntentId: t.paymentIntentId ?? null, giftCardCode: t.giftCardCode ?? null })),
      expectedTotal: priced!.total,
    };
    let receipt: any;
    let offlineSale = false;
    try {
      const r = await api('/api/pos/checkout', { body: payload, timeoutMs: 25000 });
      receipt = r.receipt;
      if (r.duplicate) toast('บิลนี้ถูกบันทึกไปแล้ว (ป้องกันรายการซ้ำ) — แสดงใบเสร็จเดิม', 'warn');
    } catch (e) {
      const ae = e as ApiError;
      if (ae.status === 0 && tenders.every((t) => (settings?.pos?.offlineAllowedMethods ?? ['cash']).includes(t.method)) && !b.coupons.length) {
        // Server unreachable: keep selling. The outbox retries with the same idempotency key (no duplicates).
        await addToOutbox({ key: payload.idempotencyKey, payload: { ...payload, offline: true }, receipt: null, createdAt: new Date().toISOString(), attempts: 0 });
        receipt = buildLocalReceipt(payload.billNo, tenders);
        offlineSale = true;
        setOnline(false);
      } else {
        if (ae.code === 'PRICE_CHANGED') { await loadCatalog(); toast('ราคา/โปรโมชั่นมีการอัปเดต กรุณาตรวจสอบยอดและชำระใหม่', 'warn'); }
        else toast('ชำระเงินไม่สำเร็จ: ' + ae.message, 'err');
        if (ae.code?.startsWith('COUPON')) { setModal(null); }
        throw e;
      }
    }
    const ps = printSettings();
    const data = toReceiptData(receipt, ps?.store, ps?.tax);
    const hasCash = tenders.some((t) => t.method === 'cash');
    const drawerCfg = printer.config?.drawer;
    printSaleReceipts(data, { openDrawer: hasCash && (drawerCfg?.enabled ?? true) && (drawerCfg?.openOnCash ?? true) });
    if (hasCash && !offlineSale) api('/api/shifts/drawer-open', { body: { reason: 'cash sale', saleId: receipt.sale.id } }).catch(() => {});
    setLastReceipt(receipt);
    const info = { status: 'paid', total: receipt.sale.total, received: receipt.sale.paidTotal, change: receipt.sale.change, pointsEarned: receipt.sale.pointsEarned, coupons: (receipt.coupons ?? []).map((c: any) => ({ code: c.code, rewardText: c.rewardText })), offline: offlineSale, billNo: receipt.sale.billNo };
    setPaidInfo(info);
    wsRef.current?.send('display.state', { ...info, lines: [], member: b.member ? { name: b.member.first_name } : null });
    setModal(null);
    setBills((bs) => { const n = bs.filter((_, i) => i !== active); return n.length ? n : [newBill()]; });
    setActive(0); setSel(null);
    if (online) setTimeout(() => loadCatalog(), 800);
    if (offlineSale) toast('บันทึกการขายแบบออฟไลน์แล้ว จะซิงก์อัตโนมัติ', 'warn');
  };

  // ---------------- discounts / points / price override ----------------
  const [discType, setDiscType] = useState<'amount' | 'percent'>('amount');
  const [discVal, setDiscVal] = useState<number | null>(null);
  const [discReason, setDiscReason] = useState('');
  const applyDiscount = async () => {
    if (!priced || !discVal) { updateBill((b) => ({ ...b, manualDiscount: null })); setModal(null); return; }
    const value = discType === 'percent' ? discVal / 100 : discVal; // MoneyInput gives satang; for % we reuse it as plain number*100
    const pct = discType === 'percent' ? value : (value * 100) / Math.max(1, priced.subtotal);
    let approvalId: string | null = null;
    if (session.staff.role !== 'owner' && (!can('pos.discount') || pct > session.staff.maxDiscountPct)) {
      const r = await withApproval('pos.discount', `ส่วนลด ${discType === 'percent' ? value + '%' : fmtMoney(value)}`, async (id) => { if (!id) throw new ApiError(403, '', 'APPROVAL_REQUIRED', { permission: 'pos.discount' }); return id; });
      if (!r) return;
      approvalId = r;
    }
    updateBill((b) => ({ ...b, manualDiscount: { type: discType, value, reason: discReason || 'ส่วนลดท้ายบิล', approvalId } }));
    setModal(null);
  };

  const overridePrice = async () => {
    if (!selLine) return;
    const v = prompt(`ราคาใหม่ต่อหน่วยของ ${selLine.name} (บาท)`);
    if (!v) return;
    const satang = Math.round(Number(v) * 100);
    if (!(satang >= 0)) return;
    let approvalId: string | null = null;
    if (!can('pos.price_override')) {
      const r = await withApproval('pos.price_override', `แก้ราคา ${selLine.name}`, async (id) => { if (!id) throw new ApiError(403, '', 'APPROVAL_REQUIRED', { permission: 'pos.price_override' }); return id; });
      if (!r) return;
      approvalId = r;
    }
    updateBill((b) => ({ ...b, lines: b.lines.map((l) => (l.lineId === selLine.lineId ? { ...l, priceSource: 'override', unitPrice: satang, overrideApprovalId: approvalId } : l)) }));
  };

  // ---------------- keyboard shortcuts ----------------
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (locked || modal || couponCheck || weighFor || registerReq) return;
      const map: Record<string, () => void> = {
        F1: () => setModal('help'), F2: () => setModal('search'), F3: () => setModal('member'), F4: () => { if (selLine) { const v = prompt('จำนวน', String(selLine.qty)); if (v) changeQty(selLine.lineId, Number(v)); } },
        F5: () => setModal('discount'), F6: () => { const c = prompt('รหัสคูปอง'); if (c) handleCoupon(c); }, F7: holdBill, F8: () => setModal('bills'),
        F9: () => selLine && removeLine(selLine.lineId), F10: cancelBill, F11: () => setModal('sales'), F12: startPayment,
      };
      if (map[e.key]) { e.preventDefault(); map[e.key](); return; }
      const inInput = (e.target as HTMLElement).tagName === 'INPUT';
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const i = bill.lines.findIndex((l) => l.lineId === selLine?.lineId);
        const n = bill.lines[Math.max(0, Math.min(bill.lines.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (n) setSel(n.lineId);
      }
      if (!inInput && selLine && (e.key === '+' || e.key === '-')) { e.preventDefault(); changeQty(selLine.lineId, selLine.qty + (e.key === '+' ? 1 : -1)); }
      if (!inInput && e.key === 'Delete' && selLine) removeLine(selLine.lineId);
      if (e.ctrlKey && e.key.toLowerCase() === 'd') { e.preventDefault(); manualDrawer(); }
      if (!inInput && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) inputRef.current?.focus();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const manualDrawer = async () => {
    try {
      const r = await withApproval('pos.open_drawer', 'เปิดลิ้นชัก', (approvalId) => api('/api/shifts/drawer-open', { body: { reason: 'เปิดลิ้นชัก (ไม่มีการขาย)', approvalId } }));
      if (r) openDrawer();
    } catch (e) { toast(errMsg(e), 'err'); }
  };

  const logout = async () => {
    if (bill.lines.length && !confirm('มีบิลค้างอยู่ ต้องการออกจากระบบ?')) return;
    await api('/api/auth/logout', { body: {} }).catch(() => {});
    setSession(null); nav('/login');
  };

  if (!catalog) return <div className="center" style={{ padding: '4rem' }}>กำลังโหลดข้อมูลสินค้า…</div>;

  const quickItems = (catalog.products as any[]).filter((x) => x.isWeighted).concat((catalog.products as any[]).filter((x) => !x.isWeighted)).slice(0, 24);

  return (
    <div className="pos">
      <div className="pos-top">
        <b>🛒 {settings.store.name}</b>
        <span className="chip">{terminal?.name} · {terminal?.branch_name}</span>
        <span className="chip">👤 {session.staff.name}</span>
        <span className="chip" style={{ cursor: outboxN ? 'pointer' : undefined }} onClick={() => outboxN && setModal('outbox')}><span className={`dot ${online ? 'on' : 'off'}`} />{online ? 'Online' : 'Offline'}{outboxN ? ` · รอซิงก์ ${outboxN}` : ''}</span>
        <span className="chip"><span className={`dot ${wsOk ? 'on' : 'off'}`} />Realtime</span>
        <span className="chip" title={p.lastError ?? ''}><span className={`dot ${p.connected ? 'on' : 'off'}`} />🖨️ {p.connected ? 'Printer' : 'No printer'}{p.jobs.some((j) => j.status === 'failed') ? ' ⚠️' : ''}</span>
        <span className="chip"><span className={`dot ${displayPresence.online ? 'on' : 'off'}`} />จอลูกค้า {displayPresence.online}</span>
        <span className="chip">{shift ? `กะ #${shift.shift.id}` : 'ยังไม่เปิดกะ'}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => setModal('devices')}>⚙️ อุปกรณ์</button>
        <button className="btn sm" onClick={() => setModal('display')}>🖥️ จอลูกค้า</button>
        <button className="btn sm" onClick={() => (shift ? setModal('shift') : setModal('openShift'))}>⏱ กะ</button>
        {can('reports.view') && <button className="btn sm" onClick={() => window.open('/admin', '_blank')}>หลังร้าน</button>}
        <button className="btn sm" onClick={() => setLocked(true)}>🔒</button>
        <button className="btn sm" onClick={logout}>ออก</button>
      </div>

      <div className="pos-main">
        <div className="pos-left">
          {!online && <div className="banner offline">⚠️ ออฟไลน์: ขายได้ด้วยเงินสด ข้อมูลจะซิงก์อัตโนมัติเมื่อกลับมาออนไลน์ (ป้องกันรายการซ้ำด้วย Idempotency Key)</div>}
          {settings?.pos?.requireShift && shift === null && <div className="banner warn">ยังไม่ได้เปิดกะ — <button className="btn sm" onClick={() => setModal('openShift')}>เปิดกะ</button></div>}
          <form className="scanbar" onSubmit={(e) => { e.preventDefault(); handleCode(input); setInput(''); }}>
            <input ref={inputRef} data-scanner="1" className="in" autoFocus placeholder="สแกนบาร์โค้ด / พิมพ์ SKU, ชื่อสินค้า (3*รหัส = จำนวน 3)" value={input} onChange={(e) => setInput(e.target.value)} />
            <button type="button" className="btn" onClick={() => setModal('camera')} title="สแกนด้วยกล้อง">📷</button>
            <button type="button" className="btn" onClick={() => setModal('search')}>🔍 F2</button>
          </form>
          {bills.length > 1 && (
            <div className="row">{bills.map((b, i) => <button key={b.cartId} className={`btn sm ${i === active ? 'primary' : ''}`} onClick={() => { setActive(i); setSel(null); }}>{b.label || `บิล ${i + 1}`} ({b.lines.length})</button>)}</div>
          )}
          <div className="cart">
            {bill.lines.length === 0 && <div className="center muted" style={{ padding: '3rem' }}>สแกนสินค้าเพื่อเริ่มขาย</div>}
            {priced?.lines.map((l) => {
              const src = bill.lines.find((x) => x.lineId === l.lineId)!;
              return (
                <div key={l.lineId} className={`cart-line ${selLine?.lineId === l.lineId ? 'sel' : ''}`} onClick={() => setSel(l.lineId)}>
                  <div>
                    <div className="name">{l.name}</div>
                    <div className="meta">{fmtMoney(l.unitPrice)}{l.isWeighted ? ' / กก.' : ''}{l.unitPrice !== l.regularUnitPrice && src.priceSource === 'regular' ? <s style={{ marginLeft: 6 }}>{fmtMoney(l.regularUnitPrice)}</s> : null} {l.labels.join(' · ')} {src.priceSource === 'override' && <span className="badge err">แก้ราคา</span>}</div>
                    {l.itemDiscount + l.billDiscountShare > 0 && <div className="disc">ส่วนลด -{fmtMoney(l.itemDiscount + l.billDiscountShare)}</div>}
                  </div>
                  <div className="qtybox" onClick={(e) => e.stopPropagation()}>
                    <button onClick={() => changeQty(l.lineId, src.qty - (src.isWeighted ? 0.1 : 1))}>−</button>
                    <span className="num" style={{ minWidth: 48, textAlign: 'center', fontWeight: 700 }}>{fmtQty(l.qty, l.isWeighted)}</span>
                    <button onClick={() => changeQty(l.lineId, src.qty + (src.isWeighted ? 0.1 : 1))}>+</button>
                  </div>
                  <div className="num right" style={{ minWidth: 90, fontWeight: 700 }}>{fmtMoney(l.gross - l.itemDiscount)}</div>
                  <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); removeLine(l.lineId); }}>✕</button>
                </div>
              );
            })}
          </div>
          <div className="quick">
            {quickItems.map((x: any) => <button key={x.id} onClick={() => addProduct(x)}>{x.name}<b>{fmtMoney(x.price)}{x.isWeighted ? '/กก.' : ''}</b></button>)}
          </div>
        </div>

        <div className="pos-right">
          {bill.member ? (
            <div className="member-pill" style={{ cursor: 'pointer' }} title="ดูรายละเอียด / พิมพ์ / ผูกบัตร" onClick={() => setModal('memberDetail')}><div><b>{bill.member.first_name} {bill.member.last_name}</b> <span className="small">({bill.member.tier_name})</span><div className="xs">{bill.member.member_no} · {Number(bill.member.points).toLocaleString()} คะแนน · จะได้ +{pointsToEarn}</div></div><button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); updateBill((b) => ({ ...b, member: null, redeemPoints: 0 })); }}>✕</button></div>
          ) : <button className="btn" onClick={() => setModal('member')}>👤 เพิ่มสมาชิก (F3)</button>}
          {displayPrompt && !bill.member && <div className="banner info row between"><span>🖥️ รอลูกค้า{displayPrompt === 'register' ? 'สมัครสมาชิก' : 'ระบุสมาชิก'}ที่จอลูกค้า…</span><button className="btn sm" onClick={() => askDisplay(null)}>ยกเลิก</button></div>}
          {bill.coupons.map((c) => <div key={c.code} className="coupon-pill"><span>🎟 {c.code} — {c.rewardText}</span><button className="btn sm ghost" onClick={() => removeCoupon(c.code)}>✕</button></div>)}
          {priced?.couponResults.filter((r) => !r.ok).map((r) => <div key={r.code} className="banner warn small">คูปอง {r.code}: {r.reason}</div>)}
          <div className="totals">
            <div className="r"><span>รวม ({fmtQty(priced?.itemsCount ?? 0)} ชิ้น)</span><span className="num">{fmtMoney(priced?.subtotal ?? 0)}</span></div>
            {priced?.discounts.map((d, i) => <div key={i} className="r" style={{ color: '#fca5a5' }}><span>{d.name}</span><span className="num">-{fmtMoney(d.amount)}</span></div>)}
            <div className="r"><span>VAT {settings.tax.rate}% ({settings.tax.mode === 'inclusive' ? 'รวมใน' : settings.tax.mode === 'exclusive' ? 'บวกเพิ่ม' : 'ไม่มี'})</span><span className="num">{fmtMoney(priced?.vatAmount ?? 0)}</span></div>
            <div className="grand num">{fmtMoney(priced?.total ?? 0)}</div>
          </div>
          <button className="btn primary block pay-btn" disabled={!bill.lines.length} onClick={startPayment}>💳 ชำระเงิน (F12)</button>
          <div className="keys">
            <button className="btn" onClick={() => setModal('discount')}>ส่วนลด<kbd>F5</kbd></button>
            <button className="btn" onClick={() => { const c = prompt('รหัสคูปอง'); if (c) handleCoupon(c); }}>คูปอง<kbd>F6</kbd></button>
            <button className="btn" disabled={!bill.member} onClick={() => setModal('points')}>แลกคะแนน</button>
            <button className="btn" onClick={holdBill}>พักบิล<kbd>F7</kbd></button>
            <button className="btn" onClick={() => setModal('bills')}>เรียกบิล<kbd>F8</kbd></button>
            <button className="btn" onClick={() => { setBills((bs) => [...bs, newBill()]); setActive(bills.length); }}>บิลใหม่</button>
            <button className="btn" disabled={!selLine} onClick={() => { if (selLine) { const v = prompt('จำนวน', String(selLine.qty)); if (v) changeQty(selLine.lineId, Number(v)); } }}>จำนวน<kbd>F4</kbd></button>
            <button className="btn" disabled={!selLine} onClick={overridePrice}>แก้ราคา</button>
            <button className="btn" onClick={() => { const c = prompt('รหัสโปรโมชั่น'); if (c) updateBill((b) => ({ ...b, promoCodes: [...b.promoCodes, c.toUpperCase()] })); }}>รหัสโปร</button>
            <button className="btn" onClick={() => setModal('sales')}>ประวัติบิล<kbd>F11</kbd></button>
            <button className="btn" onClick={manualDrawer}>ลิ้นชัก<kbd>Ctrl+D</kbd></button>
            <button className="btn danger" onClick={cancelBill}>ยกเลิกบิล<kbd>F10</kbd></button>
          </div>
          {lastReceipt && <div className="small muted">บิลล่าสุด {lastReceipt.sale.billNo} · {fmtMoney(lastReceipt.sale.total)} · <a href="#" onClick={(e) => { e.preventDefault(); const ps = printSettings(); printSaleReceipts(toReceiptData(lastReceipt, ps?.store, ps?.tax, true), { force: true }); }}>พิมพ์ซ้ำ</a></div>}
        </div>
      </div>

      {/* ---------- modals ---------- */}
      {modal === 'pay' && priced && (
        <PaymentModal total={priced.total} online={online} offlineMethods={settings.pos.offlineAllowedMethods ?? ['cash']} cartId={bill.cartId} ws={wsRef.current}
          onDisplay={(pay) => pushDisplay({ status: 'payment', payment: pay })} onComplete={completeSale} onClose={() => { setModal(null); pushDisplay(); }} />
      )}
      {paidInfo && (
        <Modal title="✅ ชำระเงินสำเร็จ" onClose={() => { setPaidInfo(null); inputRef.current?.focus(); }} width={460} footer={<button className="btn primary lg block" autoFocus onClick={() => { setPaidInfo(null); inputRef.current?.focus(); }}>บิลถัดไป (Enter)</button>}>
          <div className="center grid">
            <div className="muted">บิล {paidInfo.billNo}</div>
            <div style={{ fontSize: '1.1rem' }}>ยอดสุทธิ {fmtMoney(paidInfo.total)}</div>
            <div style={{ fontSize: '3rem', fontWeight: 800 }} className="ok">ทอน {fmtMoney(paidInfo.change)}</div>
            {paidInfo.pointsEarned > 0 && <div>สมาชิกได้รับ +{paidInfo.pointsEarned} คะแนน</div>}
            {paidInfo.coupons.map((c: any) => <div key={c.code} className="coupon-pill">🎁 ออกคูปอง {c.code} — {c.rewardText}</div>)}
            {paidInfo.offline && <div className="banner offline">บันทึกแบบออฟไลน์ รอซิงก์</div>}
            <div className="small muted">ใบเสร็จ: {p.jobs.slice(-3).map((j) => `${j.kind}:${j.status}`).join(' · ')}</div>
          </div>
        </Modal>
      )}
      {modal === 'search' && <SearchModal products={catalog.products} initial={input} onPick={(x) => { addProduct(x); setModal(null); setInput(''); }} onClose={() => setModal(null)} />}
      {modal === 'camera' && <CameraScanner onClose={() => setModal(null)} onScan={(c) => { setModal(null); handleCode(c); }} />}
      {modal === 'member' && <MemberModal displayOnline={displayPresence.online > 0} onClose={() => setModal(null)} onCustomerDisplay={(mode) => { askDisplay(mode); setModal(null); }} onPick={(m) => { updateBill((b) => ({ ...b, member: m, coupons: b.coupons })); setModal(null); }} />}
      {modal === 'memberDetail' && bill.member && <MemberDetailModal memberId={bill.member.id} onClose={() => setModal(null)} onRemove={() => { updateBill((b) => ({ ...b, member: null, redeemPoints: 0 })); setModal(null); }} />}
      {registerReq && <DisplayRegisterConfirm profile={registerReq} onClose={() => { wsRef.current?.send('display.command', { type: 'member.result', ok: false, message: 'พนักงานไม่ได้ยืนยันการสมัคร' }); setRegisterReq(null); }}
        onDone={(m) => { attachMemberRef.current(m); wsRef.current?.send('display.command', { type: 'member.result', ok: true, registered: true, name: m.first_name, memberNo: m.member_no }); setRegisterReq(null); setDisplayPrompt(null); }} />}
      {modal === 'display' && <DisplayModal onClose={() => setModal(null)} />}
      {modal === 'sales' && <SalesModal onClose={() => setModal(null)} />}
      {modal === 'openShift' && <OpenShiftModal onClose={() => setModal(null)} onOpened={(s) => { setShift(s); setModal(null); toast('เปิดกะแล้ว', 'ok'); }} />}
      {modal === 'shift' && shift && <ShiftModal summary={shift} onClose={() => setModal(null)} onChanged={setShift} onClosed={(r) => { setModal(null); toast(`ปิดกะแล้ว ${Number(r.shift.difference) === 0 ? 'ยอดตรง' : 'ส่วนต่าง ' + fmtMoney(Number(r.shift.difference))}`, 'ok'); if (r.newShiftId) { setSession(null); nav('/login'); } else setShift(null); }} />}
      {modal === 'devices' && <Modal title="⚙️ อุปกรณ์ที่เครื่องนี้" onClose={() => setModal(null)} width={980}><DevicesPanel terminalSettings={terminal?.settings} displays={{ online: displayPresence.online, paired: displayPresence.paired }} onSaved={(s) => setCatalog((c: any) => ({ ...c, terminal: { ...c.terminal, settings: s } }))} /></Modal>}
      {modal === 'bills' && (
        <Modal title="บิลที่พักไว้" onClose={() => setModal(null)} width={480}>
          {bills.map((b, i) => <div key={b.cartId} className="row between card" style={{ marginBottom: 6, padding: '.6rem' }}><span>{b.label || `บิล ${i + 1}`} · {b.lines.length} รายการ · {new Date(b.createdAt).toLocaleTimeString('th-TH')}</span><button className="btn sm primary" onClick={() => { setActive(i); setModal(null); }}>เรียก</button></div>)}
        </Modal>
      )}
      {modal === 'discount' && (
        <Modal title="ส่วนลดท้ายบิล" onClose={() => setModal(null)} width={420} footer={<><button className="btn" onClick={() => { updateBill((b) => ({ ...b, manualDiscount: null })); setModal(null); }}>ล้างส่วนลด</button><button className="btn primary" onClick={applyDiscount}>ใช้ส่วนลด</button></>}>
          <div className="grid">
            <div className="row"><button className={`btn ${discType === 'amount' ? 'primary' : ''}`} onClick={() => setDiscType('amount')}>บาท</button><button className={`btn ${discType === 'percent' ? 'primary' : ''}`} onClick={() => setDiscType('percent')}>%</button></div>
            <Field label={discType === 'amount' ? 'จำนวนเงิน (บาท)' : 'เปอร์เซ็นต์'}><MoneyInput value={discVal} onChange={setDiscVal} autoFocus /></Field>
            <Field label="เหตุผล"><input className="in" value={discReason} onChange={(e) => setDiscReason(e.target.value)} /></Field>
            <p className="xs muted">ส่วนลดเกินสิทธิ์ตำแหน่ง ({session.staff.maxDiscountPct}%) ต้องให้ผู้จัดการอนุมัติ</p>
          </div>
        </Modal>
      )}
      {modal === 'points' && bill.member && (
        <PointsModal member={bill.member} cfg={pointsCfg} total={priced?.total ?? 0} current={bill.redeemPoints} onClose={() => setModal(null)} onApply={(n) => { updateBill((b) => ({ ...b, redeemPoints: n })); setModal(null); }} />
      )}
      {modal === 'help' && (
        <Modal title="คีย์ลัด" onClose={() => setModal(null)}>
          <table className="t"><tbody>
            {[['F1', 'ช่วยเหลือ'], ['F2', 'ค้นหาสินค้า'], ['F3', 'สมาชิก'], ['F4', 'แก้จำนวน'], ['F5', 'ส่วนลดท้ายบิล'], ['F6', 'คูปอง'], ['F7', 'พักบิล'], ['F8', 'เรียกบิลที่พัก'], ['F9 / Delete', 'ลบรายการ'], ['F10', 'ยกเลิกบิล'], ['F11', 'ประวัติบิล/คืนเงิน'], ['F12', 'ชำระเงิน'], ['+ / −', 'เพิ่ม/ลดจำนวน'], ['↑ ↓', 'เลือกรายการ'], ['Ctrl+D', 'เปิดลิ้นชัก'], ['3*รหัส', 'สแกนพร้อมจำนวน']].map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}
          </tbody></table>
        </Modal>
      )}
      {weighFor && <WeightModal product={weighFor.product} onClose={() => setWeighFor(null)} onDone={(kg) => { const pr = weighFor.product; setWeighFor(null); addProduct(pr, { weightKg: kg, barcode: weighFor.barcode || null }); }} />}
      {couponCheck && <CouponConfirm check={couponCheck} discount={couponCheck.discount} onClose={() => setCouponCheck(null)} onUse={useCoupon} />}
      {modal === 'outbox' && <OutboxModal onClose={() => setModal(null)} />}
      {locked && <LockScreen name={session.staff.name} onUnlock={() => setLocked(false)} onSwitch={logout} />}
    </div>
  );
}

function OutboxModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<any[]>([]);
  const load = async () => setList(await getOutbox());
  useEffect(() => { load(); }, []);
  return (
    <Modal title="บิลออฟไลน์ที่รอซิงก์" onClose={onClose} width={640} footer={<button className="btn primary" onClick={async () => { const r = await syncOutbox(); toast(`ซิงก์สำเร็จ ${r.synced} · ไม่สำเร็จ ${r.failed}`, r.failed ? 'warn' : 'ok'); load(); }}>ซิงก์ตอนนี้</button>}>
      <p className="small muted">ทุกบิลมี Idempotency Key — การส่งซ้ำจะไม่สร้างรายการขายซ้ำ</p>
      <table className="t"><tbody>{list.map((e) => <tr key={e.key}><td className="mono small">{e.payload.billNo}</td><td className="small">{new Date(e.createdAt).toLocaleString('th-TH')}</td><td className="right num">{fmtMoney(e.payload.expectedTotal)}</td><td className={`small ${e.needsAttention ? 'err' : 'muted'}`}>{e.lastError ?? 'รอส่ง'} {e.attempts ? `(×${e.attempts})` : ''}</td></tr>)}</tbody></table>
    </Modal>
  );
}

function SearchModal({ products, initial, onPick, onClose }: { products: any[]; initial: string; onPick: (p: any) => void; onClose: () => void }) {
  const [q, setQ] = useState(initial);
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return products.slice(0, 50);
    return products.filter((p) => p.name.toLowerCase().includes(t) || p.sku.toLowerCase().includes(t) || p.nameEn?.toLowerCase().includes(t) || p.barcodes.some((b: any) => b.barcode.startsWith(t))).slice(0, 80);
  }, [q, products]);
  return (
    <Modal title="🔍 ค้นหาสินค้า / เช็คราคา" onClose={onClose} width={760}>
      <input className="in" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="ชื่อ / SKU / บาร์โค้ด" onKeyDown={(e) => e.key === 'Enter' && list[0] && onPick(list[0])} />
      <div className="table-wrap" style={{ maxHeight: 420, marginTop: 8 }}>
        <table className="t"><thead><tr><th>สินค้า</th><th>SKU</th><th className="right">ราคา</th><th className="right">สต็อก</th></tr></thead><tbody>
          {list.map((p) => <tr key={p.id} style={{ cursor: 'pointer', opacity: p.saleBlocked ? .5 : 1 }} onClick={() => onPick(p)}><td>{p.name}{p.saleBlocked && <span className="badge err">ห้ามขาย</span>}<div className="xs muted">{p.barcodes.map((b: any) => b.barcode).join(', ')}</div></td><td className="mono small">{p.sku}</td><td className="right num">{fmtMoney(p.price)}{p.memberPrice ? <div className="xs ok">สมาชิก {fmtMoney(p.memberPrice)}</div> : null}</td><td className={`right num ${p.trackStock && Number(p.stock) <= Number(p.minStock) ? 'err' : ''}`}>{p.trackStock ? fmtQty(Number(p.stock ?? 0)) : '∞'}</td></tr>)}
        </tbody></table>
      </div>
    </Modal>
  );
}

function PointsModal({ member, cfg, total, current, onApply, onClose }: { member: any; cfg: any; total: number; current: number; onApply: (n: number) => void; onClose: () => void }) {
  const maxByTotal = Math.floor(total / Math.max(1, cfg.pointValue));
  const max = Math.min(member.points, maxByTotal + current);
  const [n, setN] = useState(current || Math.min(max, cfg.minRedeem));
  return (
    <Modal title="แลกคะแนนเป็นส่วนลด" onClose={onClose} width={420} footer={<><button className="btn" onClick={() => onApply(0)}>ไม่แลก</button><button className="btn primary" disabled={n > 0 && (n < cfg.minRedeem || n > max)} onClick={() => onApply(n)}>แลก {n} คะแนน = {fmtMoney(n * cfg.pointValue)}</button></>}>
      <p>คะแนนคงเหลือ <b>{member.points.toLocaleString()}</b> · ขั้นต่ำ {cfg.minRedeem} คะแนน · 1 คะแนน = {fmtMoney(cfg.pointValue)}</p>
      <input className="in num" type="number" min={0} max={max} value={n} onChange={(e) => setN(Math.max(0, Math.floor(Number(e.target.value))))} />
      <input type="range" min={0} max={max} value={n} onChange={(e) => setN(Number(e.target.value))} style={{ width: '100%' }} />
    </Modal>
  );
}

function LockScreen({ name, onUnlock, onSwitch }: { name: string; onUnlock: () => void; onSwitch: () => void }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const submit = async (v = pin) => { try { await api('/api/auth/unlock', { body: { pin: v } }); onUnlock(); } catch (e) { setErr(errMsg(e)); setPin(''); } };
  return (
    <div className="lock-screen">
      <div style={{ width: 320 }} className="grid center">
        <div style={{ fontSize: '3rem' }}>🔒</div>
        <h2>หน้าจอถูกล็อก</h2>
        <div>{name}</div>
        <input className="in center" style={{ fontSize: '1.6rem', letterSpacing: '.4em', color: '#000' }} type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {err && <div style={{ color: '#fca5a5' }}>{err}</div>}
        <div className="numpad" style={{ color: '#000' }}>{['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'OK'].map((k) => <button key={k} onClick={() => (k === 'OK' ? submit() : k === '⌫' ? setPin((v) => v.slice(0, -1)) : setPin((v) => (v + k).slice(0, 6)))}>{k}</button>)}</div>
        <button className="btn ghost" style={{ color: '#fff' }} onClick={onSwitch}>เปลี่ยนผู้ใช้</button>
      </div>
    </div>
  );
}
