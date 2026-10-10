// Receipt renderer: draws a ReceiptTemplate + ReceiptData onto a canvas at the printer's native resolution.
// The SAME canvas is used for the on-screen preview and converted to an ESC/POS raster bitmap for printing,
// so fonts (Thai / English / Chinese / custom uploads), sizes, logo, barcodes and QR codes match the paper output.
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';
import { ensureFonts } from './fonts';
import type { ReceiptTemplate, ReceiptElement, ReceiptData, TextStyle } from '../../../shared/receipt';
import { PAYMENT_LABELS } from '../../../shared/receipt';
import { fmtNum, fmtQty } from '../../../shared/money';

export function paperDots(paperWidth: 58 | 80, dpi: number) {
  const printableMm = paperWidth === 58 ? 48 : 72;
  return Math.round(((printableMm / 25.4) * dpi) / 8) * 8; // 203dpi: 384 / 576 dots
}

const ptToPx = (pt: number, dpi: number) => Math.round((pt * dpi) / 72);

function styleOf(t: ReceiptTemplate, ...parts: (Partial<TextStyle> | undefined)[]): TextStyle {
  return Object.assign({}, t.defaultStyle, ...parts.filter(Boolean));
}

function fontCss(s: TextStyle, dpi: number) {
  return `${s.italic ? 'italic ' : ''}${s.fontWeight} ${ptToPx(s.fontSize, dpi)}px "${s.fontFamily}", "Sarabun", "Noto Sans Thai", "Noto Sans SC", sans-serif`;
}

const segmenter: any = (Intl as any).Segmenter ? new (Intl as any).Segmenter('th', { granularity: 'word' }) : null;
function tokens(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (s: any) => s.segment as string);
  return text.split(/(\s+)/);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const out: string[] = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const tok of tokens(para)) {
      const test = line + tok;
      if (ctx.measureText(test).width <= maxW || !line) {
        if (ctx.measureText(test).width > maxW && !line) {
          // a single token longer than the line: break by characters
          let chunk = '';
          for (const ch of Array.from(tok)) {
            if (ctx.measureText(chunk + ch).width > maxW && chunk) { out.push(chunk); chunk = ''; }
            chunk += ch;
          }
          line = chunk;
        } else line = test;
      } else {
        out.push(line.trimEnd());
        line = tok.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const tzOf = (d: ReceiptData) => d.store.timeZone || 'Asia/Bangkok';

function fill(tpl: string, d: ReceiptData) {
  const date = new Date(d.sale.createdAt);
  const timeZone = tzOf(d);
  return tpl
    .replace(/\{billNo\}/g, d.sale.billNo)
    .replace(/\{saleId\}/g, String(d.sale.id))
    .replace(/\{date\}/g, date.toLocaleDateString('th-TH', { timeZone }))
    .replace(/\{time\}/g, date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone }))
    .replace(/\{total\}/g, fmtNum(d.sale.total))
    .replace(/\{storeName\}/g, d.store.name)
    .replace(/\{branch\}/g, d.branch.name)
    .replace(/\{memberNo\}/g, d.member?.memberNo ?? '')
    .replace(/\{points\}/g, String(d.sale.pointsEarned ?? 0));
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(src: string) {
  if (!imageCache.has(src)) {
    imageCache.set(src, new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; }));
  }
  return imageCache.get(src)!;
}

/** Floyd–Steinberg dither of an image into pure black/white (for logos/photos). */
function ditherInto(img: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d')!;
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
  x.drawImage(img, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h);
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = d.data[i * 4 + 3] / 255;
    g[i] = (0.299 * d.data[i * 4] + 0.587 * d.data[i * 4 + 1] + 0.114 * d.data[i * 4 + 2]) * a + 255 * (1 - a);
  }
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
    const i = y * w + xx;
    const old = g[i];
    const nv = old < 128 ? 0 : 255;
    const err = old - nv;
    g[i] = nv;
    if (xx + 1 < w) g[i + 1] += (err * 7) / 16;
    if (y + 1 < h) {
      if (xx > 0) g[i + w - 1] += (err * 3) / 16;
      g[i + w] += (err * 5) / 16;
      if (xx + 1 < w) g[i + w + 1] += err / 16;
    }
  }
  for (let i = 0; i < w * h; i++) { const v = g[i] < 128 ? 0 : 255; d.data[i * 4] = d.data[i * 4 + 1] = d.data[i * 4 + 2] = v; d.data[i * 4 + 3] = 255; }
  x.putImageData(d, 0, 0);
  return c;
}

class Painter {
  y = 0;
  constructor(public ctx: CanvasRenderingContext2D, public t: ReceiptTemplate, public x0: number, public w: number) {}

  setFont(s: TextStyle) {
    this.ctx.font = fontCss(s, this.t.dpi);
    if ('letterSpacing' in this.ctx) (this.ctx as any).letterSpacing = `${s.letterSpacing || 0}px`;
  }
  lineH(s: TextStyle) { return Math.round(ptToPx(s.fontSize, this.t.dpi) * (s.lineHeight || 1.2)); }

  text(text: string, s: TextStyle) {
    if (!text) return;
    this.setFont(s);
    const lh = this.lineH(s);
    for (const line of wrap(this.ctx, text, this.w)) {
      if (s.invert) { this.ctx.fillStyle = '#000'; this.ctx.fillRect(this.x0, this.y, this.w, lh); this.ctx.fillStyle = '#fff'; } else this.ctx.fillStyle = '#000';
      const tw = this.ctx.measureText(line).width;
      const x = s.align === 'center' ? this.x0 + (this.w - tw) / 2 : s.align === 'right' ? this.x0 + this.w - tw : this.x0;
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(line, x, this.y + lh / 2);
      this.y += lh;
    }
    this.ctx.fillStyle = '#000';
  }

  /** label ......... value  (label wraps if long; value right-aligned on the last line) */
  row(left: string, right: string, s: TextStyle, rs?: TextStyle) {
    const rStyle = rs ?? s;
    this.setFont(rStyle);
    const rw = this.ctx.measureText(right).width;
    this.setFont(s);
    const lh = Math.max(this.lineH(s), this.lineH(rStyle));
    const lines = wrap(this.ctx, left, Math.max(40, this.w - rw - 12));
    lines.forEach((ln, i) => {
      this.setFont(s);
      this.ctx.fillStyle = '#000';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(ln, this.x0, this.y + lh / 2);
      if (i === lines.length - 1) {
        this.setFont(rStyle);
        this.ctx.fillText(right, this.x0 + this.w - this.ctx.measureText(right).width, this.y + lh / 2);
      }
      this.y += lh;
    });
  }

  divider(style: 'dashed' | 'solid' | 'double' = 'dashed') {
    const y = this.y + 8;
    this.ctx.strokeStyle = '#000';
    this.ctx.lineWidth = 2;
    this.ctx.setLineDash(style === 'dashed' ? [8, 6] : []);
    this.ctx.beginPath(); this.ctx.moveTo(this.x0, y); this.ctx.lineTo(this.x0 + this.w, y); this.ctx.stroke();
    if (style === 'double') { this.ctx.beginPath(); this.ctx.moveTo(this.x0, y + 5); this.ctx.lineTo(this.x0 + this.w, y + 5); this.ctx.stroke(); }
    this.ctx.setLineDash([]);
    this.y += style === 'double' ? 22 : 16;
  }

  image(img: CanvasImageSource, w: number, h: number, align: 'left' | 'center' | 'right' = 'center') {
    const x = align === 'center' ? this.x0 + (this.w - w) / 2 : align === 'right' ? this.x0 + this.w - w : this.x0;
    this.ctx.drawImage(img, Math.round(x), this.y, w, h);
    this.y += h;
  }

  barcode(data: string, height: number, showText: boolean, s: TextStyle) {
    const c = document.createElement('canvas');
    let module = 3;
    for (; module >= 1; module--) {
      JsBarcode(c, data, { format: 'CODE128', width: module, height, displayValue: false, margin: 0, background: '#ffffff', lineColor: '#000000' });
      if (c.width <= this.w) break;
    }
    this.image(c, Math.min(c.width, this.w), height);
    if (showText) { this.y += 4; this.text(data, { ...s, align: 'center' }); }
  }

  async qr(data: string, sizeDots: number) {
    const c = document.createElement('canvas');
    await QRCode.toCanvas(c, data, { margin: 0, width: sizeDots, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
    this.image(c, c.width, c.height);
  }
}

export interface RenderOptions { maxItems?: number; }

export async function renderReceipt(t: ReceiptTemplate, d: ReceiptData): Promise<HTMLCanvasElement> {
  // make sure every font used by the template is loaded before drawing
  const fams = new Set<string>([t.defaultStyle.fontFamily]);
  for (const e of t.elements) {
    if (e.style?.fontFamily) fams.add(e.style.fontFamily);
    for (const s of Object.values(e.styles || {})) if (s.fontFamily) fams.add(s.fontFamily);
  }
  await ensureFonts([...fams]);

  const width = paperDots(t.paperWidth, t.dpi);
  const margin = Math.round((t.marginX / 25.4) * t.dpi);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 12000;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, canvas.height);
  ctx.fillStyle = '#000';
  const p = new Painter(ctx, t, margin, width - margin * 2);
  const money = (v: number) => fmtNum(v);
  p.y = 8;

  if (d.reprint) p.text('*** สำเนา (REPRINT) ***', styleOf(t, { align: 'center', fontWeight: 700 }));

  for (const e of t.elements) {
    if (e.hidden) continue;
    const s = styleOf(t, e.style);
    p.y += e.marginTop ?? 0;
    const L = (def: string) => e.label ?? def;
    switch (e.type) {
      case 'logo': {
        if (!d.store.logo) break;
        try {
          const img = await loadImage(d.store.logo);
          const w = Math.round(p.w * ((e.options?.widthPct ?? 50) / 100));
          const h = Math.round((img.height / img.width) * w);
          p.image(ditherInto(img, w, h), w, h, s.align === 'left' || s.align === 'right' ? s.align : 'center');
          p.y += 6;
        } catch { /* logo failed to load */ }
        break;
      }
      case 'store_name': p.text(L('') + d.store.name, s); break;
      case 'branch_name': p.text(L('') + d.branch.name, s); break;
      case 'address': p.text(L('') + (d.branch.address || d.store.address || ''), s); break;
      case 'phone': if (d.branch.phone || d.store.phone) p.text(L('โทร ') + (d.branch.phone || d.store.phone), s); break;
      case 'tax_id': if (d.branch.taxId || d.store.taxId) p.text(L('TAX ID ') + (d.branch.taxId || d.store.taxId), s); break;
      case 'title': p.text(fill(e.text || 'ใบเสร็จรับเงิน', d), s); break;
      case 'receipt_no': {
        const seq = d.sale.billNo.split('-').pop() || d.sale.billNo;
        p.text(`${L('บิล #')}${e.options?.short ? seq : d.sale.billNo}`, s);
        break;
      }
      case 'datetime': p.text(L('') + new Date(d.sale.createdAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short', timeZone: tzOf(d) }), s); break;
      case 'cashier': p.text(L('แคชเชียร์ ') + d.staff.name, s); break;
      case 'terminal': p.text(L('เครื่อง ') + d.terminal.name.replace(/^เครื่อง\s*/, ''), s); break;
      case 'member': if (d.member) p.text(`${L('สมาชิก ')}${d.member.memberNo} ${d.member.name}${d.member.tier ? ' (' + d.member.tier + ')' : ''}`, s); break;
      case 'items': {
        const ps = styleOf(t, e.style, e.styles?.price);
        const max = Number(e.options?.maxItems || 0);
        const list = max > 0 ? d.items.slice(0, max) : d.items;
        for (const it of list) {
          const qty = fmtQty(it.qty, it.isWeighted);
          if (e.options?.compact) {
            p.row(`${it.name} ${qty} × ${money(it.unitPrice)}`, money(it.total + it.discount), s, ps);
          } else {
            p.text(it.name, s);
            p.row(e.options?.showUnitPrice === false ? `  ${qty}` : `  ${qty}${it.isWeighted ? ' กก.' : ''} × ${money(it.unitPrice)}`, money(it.total + it.discount), s, ps);
          }
          if (e.options?.showDiscount !== false && it.discount > 0) p.row('  ส่วนลด', '-' + money(it.discount), s, ps);
        }
        if (max > 0 && d.items.length > max) p.text(`สินค้าอื่น ๆ ${d.items.length - max} รายการ`, s);
        break;
      }
      case 'item_count': p.row(L('สินค้า'), `${d.sale.linesCount} รายการ (${fmtQty(d.sale.itemsCount)} ชิ้น)`, s); break;
      case 'subtotal': p.row(L('รวมเป็นเงิน'), money(d.sale.subtotal), s); break;
      case 'discount': {
        if (!d.sale.discountTotal) break;
        if (e.options?.breakdown) for (const x of d.discounts) p.row(`  ${x.name}`, '-' + money(x.amount), s);
        p.row(L('ส่วนลดรวม'), '-' + money(d.sale.discountTotal), s);
        break;
      }
      case 'vat': {
        const base = d.sale.total - d.sale.vatAmount;
        p.row(`${L('VAT')} ${d.vatRate ?? 7}%`, money(d.sale.vatAmount), s);
        if (e.options?.showBase !== false) p.row('มูลค่าก่อนภาษี', money(base), s);
        break;
      }
      case 'grand_total': p.row(L('ยอดสุทธิ'), '฿' + money(d.sale.total), s, styleOf(t, e.style, e.styles?.value)); break;
      case 'payment_method':
        for (const pm of d.payments) p.row(`${PAYMENT_LABELS[pm.method] || pm.method}${pm.reference ? ' (' + pm.reference + ')' : ''}`, money(pm.method === 'cash' ? pm.received ?? pm.amount : pm.amount), s);
        break;
      case 'cash_received': {
        const cash = d.payments.filter((x) => x.method === 'cash');
        if (cash.length) p.row(L('รับเงิน'), money(cash.reduce((a, x) => a + (x.received ?? x.amount), 0)), s);
        break;
      }
      case 'change': if (d.sale.change || e.options?.alwaysShow !== false) p.row(L('เงินทอน'), '฿' + money(d.sale.change), s); break;
      case 'points':
        if (d.member) {
          p.row(L('คะแนนที่ได้รับ'), `+${d.sale.pointsEarned}`, s);
          if (d.sale.pointsRedeemed) p.row('คะแนนที่ใช้', `-${d.sale.pointsRedeemed}`, s);
          if (d.member.pointsBalance != null) p.row('คะแนนคงเหลือ', String(d.member.pointsBalance), s);
        }
        break;
      case 'qr': {
        const data = fill(e.options?.data || '{billNo}', d);
        const size = Math.round(p.w * ((e.options?.sizePct ?? 45) / 100));
        await p.qr(data, size);
        if (e.text) p.text(fill(e.text, d), { ...s, align: 'center' });
        break;
      }
      case 'barcode': p.barcode(fill(e.options?.data || '{billNo}', d), e.options?.height ?? 60, !!e.options?.showText, s); break;
      case 'promotion': if (e.text) p.text(fill(e.text, d), s); break;
      case 'custom_text': if (e.text) p.text(fill(e.text, d), s); break;
      case 'thank_you': p.text(fill(e.text || 'ขอบคุณที่ใช้บริการ', d), s); break;
      case 'divider': p.divider(e.options?.style || 'dashed'); break;
      case 'spacer': p.y += e.options?.height ?? 20; break;
      case 'coupon': {
        for (const c of d.coupons) {
          p.y += 10;
          const top = p.y;
          p.divider('double');
          p.text(e.options?.header || '🎁 SPECIAL COUPON', styleOf(t, e.style, e.styles?.title));
          p.text(c.rewardText, styleOf(t, e.style, e.styles?.reward));
          p.text(e.options?.nextTimeText ?? 'สำหรับการซื้อครั้งถัดไป', { ...s, align: 'center' });
          if (c.minSpend) p.text(`เมื่อซื้อครบ ${money(c.minSpend)} บาท`, { ...s, align: 'center' });
          p.y += 6;
          p.barcode(c.barcodeValue, e.options?.barcodeHeight ?? 70, false, s);
          p.y += 4;
          p.text(c.code, styleOf(t, e.style, e.styles?.code));
          p.text(`ใช้ได้ถึง ${new Date(c.expiresAt).toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tzOf(d) })}`, { ...s, align: 'center' });
          p.text(e.options?.singleUseText ?? 'ใช้ได้ 1 ครั้งเท่านั้น', { ...s, align: 'center', fontWeight: 700 });
          p.divider('double');
          void top;
        }
        break;
      }
    }
    p.y += e.marginBottom ?? 2;
  }
  p.y += 8;

  const out = document.createElement('canvas');
  out.width = width;
  out.height = Math.ceil(p.y);
  const octx = out.getContext('2d', { willReadFrequently: true })!;
  octx.fillStyle = '#fff';
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(canvas, 0, 0);
  // Binarise exactly as the printer will (preview == paper)
  const img = octx.getImageData(0, 0, out.width, out.height);
  const th = t.threshold ?? 160;
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2] < th ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/** Sample data for the designer preview and test prints. */
export function sampleReceiptData(store: any): ReceiptData {
  return {
    store: { name: store?.name || 'SUPERMARKET', logo: store?.logo, address: store?.address, phone: store?.phone, taxId: store?.taxId },
    branch: { name: 'สาขาสำนักงานใหญ่', address: store?.address, phone: store?.phone, taxId: store?.taxId },
    terminal: { code: 'POS01', name: 'POS 01' },
    staff: { name: 'แคชเชียร์ มานี' },
    sale: { id: 125, billNo: 'POS01-000125', createdAt: new Date().toISOString(), subtotal: 90000, discountTotal: 5000, couponDiscount: 0, pointsDiscount: 0, vatAmount: 5561, total: 85000, paidTotal: 100000, change: 15000, itemsCount: 10, linesCount: 8, pointsEarned: 34, pointsRedeemed: 0 },
    member: { memberNo: 'M100000001', name: 'สมศรี ใจดี', tier: 'Gold', pointsBalance: 1234 },
    items: [
      { name: 'น้ำดื่ม 600 มล.', qty: 2, unitPrice: 1000, discount: 0, total: 2000 },
      { name: 'นมสด 830 มล.', qty: 2, unitPrice: 4500, discount: 0, total: 9000 },
      { name: 'กล้วยหอม', qty: 1.235, unitPrice: 4500, discount: 0, total: 5558, isWeighted: true },
      { name: 'ข้าวหอมมะลิ 5 กก.', qty: 1, unitPrice: 18900, discount: 1000, total: 17900 },
      { name: 'Instant Noodles 方便面', qty: 10, unitPrice: 700, discount: 0, total: 7000 },
    ],
    payments: [{ method: 'cash', amount: 85000, received: 100000, change: 15000 }],
    discounts: [{ source: 'promotion', name: 'ซื้อ 2 ลด 10%', amount: 4000 }, { source: 'coupon', name: 'คูปอง CPN-A7X82K91', amount: 1000 }],
    coupons: [{ code: 'CPN-A7X82K91', barcodeValue: 'CPN-A7X82K91', title: 'SPECIAL COUPON', rewardText: 'รับส่วนลด 50 บาท', expiresAt: '2026-12-31T23:59:59+07:00', minSpend: 0 }],
    vatRate: 7,
  };
}

/** Simple two-column report bitmap (shift report, test print, X/Z report) using the receipt font. */
export async function renderReport(title: string, rows: { l: string; r?: string; bold?: boolean; center?: boolean; divider?: boolean }[], opts: { paperWidth: 58 | 80; dpi: number; fontFamily: string; storeName?: string }) {
  const t: ReceiptTemplate = {
    id: 'report', name: title, paperWidth: opts.paperWidth, dpi: opts.dpi, marginX: 3, feedLines: 3, cut: 'partial', threshold: 160,
    defaultStyle: { fontFamily: opts.fontFamily, fontSize: 9, fontWeight: 400, lineHeight: 1.25, letterSpacing: 0, align: 'left' }, elements: [],
  };
  await ensureFonts([opts.fontFamily]);
  const width = paperDots(t.paperWidth, t.dpi);
  const m = Math.round((3 / 25.4) * t.dpi);
  const c = document.createElement('canvas');
  c.width = width; c.height = 8000;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, c.height);
  const p = new Painter(ctx, t, m, width - m * 2);
  p.y = 8;
  if (opts.storeName) p.text(opts.storeName, { ...t.defaultStyle, fontSize: 12, fontWeight: 700, align: 'center' });
  p.text(title, { ...t.defaultStyle, fontSize: 11, fontWeight: 700, align: 'center' });
  p.divider();
  for (const r of rows) {
    const s = { ...t.defaultStyle, fontWeight: r.bold ? 700 : 400, align: (r.center ? 'center' : 'left') as TextStyle['align'] };
    if (r.divider) p.divider();
    else if (r.r != null) p.row(r.l, r.r, s);
    else p.text(r.l, s);
  }
  p.y += 10;
  const out = document.createElement('canvas');
  out.width = width; out.height = Math.ceil(p.y);
  const o = out.getContext('2d', { willReadFrequently: true })!;
  o.drawImage(c, 0, 0);
  const img = o.getImageData(0, 0, out.width, out.height);
  for (let i = 0; i < img.data.length; i += 4) { const v = img.data[i] < 160 ? 0 : 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
  o.putImageData(img, 0, 0);
  return out;
}
