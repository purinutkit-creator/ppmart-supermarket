import { useEffect, useMemo, useState } from 'react';
import { renderProductLabel, type LabelOptions, type LabelProduct } from '../lib/receipt-render';
import { EscPos } from '../lib/escpos';
import { printer, type TransportKind } from '../lib/printer';
import { printSettings } from '../lib/receipt-print';
import { getSession } from '../lib/api';
import { usePrinterState, DEFAULT_PRINTER } from './DevicesPanel';
import { Field, useToast, errMsg } from './ui';

export const LABEL_SIZES: [number, number][] = [[80, 80], [80, 60], [80, 50], [80, 40], [80, 30], [58, 40], [58, 30], [50, 30], [50, 25], [40, 30], [40, 25]];
const OPTS_KEY = 'ppmart.labelOpts';
const PRINTER_KEY = 'ppmart.labelPrinter';

type Opts = Omit<LabelOptions, 'paperWidth' | 'dpi' | 'fontFamily' | 'storeName'> & { copies: number; cutEach: boolean; feedLines: number };
const defaults: Opts = {
  widthMm: 80, heightMm: 80, copies: 1, cutEach: true, feedLines: 2,
  show: { store: true, name: true, price: true, memberPrice: true, barcode: true, barcodeText: true, sku: false, unit: false },
};

export function toLabelProduct(p: any): LabelProduct {
  const code = (p.barcodes ?? []).find((b: any) => Number(b.packQty ?? b.pack_qty ?? 1) === 1)?.barcode ?? p.sku;
  return { name: p.name, sku: p.sku, price: p.price, memberPrice: p.memberPrice, unitName: p.unitName, isWeighted: p.isWeighted, barcode: code };
}

/** Print product barcode/price labels on the connected receipt printer (USB / Bluetooth / Serial / LAN), any label size. */
export function LabelPrint({ products }: { products: any[] }) {
  const toast = useToast();
  const p = usePrinterState();
  const [o, setO] = useState<Opts>(() => { try { return { ...defaults, ...JSON.parse(localStorage.getItem(OPTS_KEY) || '{}') }; } catch { return defaults; } });
  const [qty, setQty] = useState<Record<number, number>>({});
  const [preview, setPreview] = useState<string | null>(null);
  const [kind, setKind] = useState<TransportKind>(() => printer.config?.transport ?? 'usb');
  const [busy, setBusy] = useState(false);
  const custom = !LABEL_SIZES.some(([w, h]) => w === o.widthMm && h === o.heightMm);
  useEffect(() => { localStorage.setItem(OPTS_KEY, JSON.stringify(o)); }, [o]);

  // No POS terminal session (back office on its own)? reuse the printer paired here before.
  useEffect(() => {
    if (printer.config || getSession()?.terminalId) return;
    try { const c = JSON.parse(localStorage.getItem(PRINTER_KEY) || 'null'); if (c) printer.configure(c); } catch { /* ignore */ }
  }, []);

  const paperWidth: 58 | 80 = printer.config?.paperWidth ?? (o.widthMm <= 58 ? 58 : 80);
  const dpi = printer.config?.dpi ?? 203;
  const full = useMemo((): LabelOptions => ({ ...o, paperWidth, dpi, fontFamily: printSettings()?.receipt.customer.defaultStyle.fontFamily || 'Sarabun', storeName: printSettings()?.store?.name }), [o, paperWidth, dpi]);
  const tooWide = o.widthMm > paperWidth;

  useEffect(() => {
    if (!products.length) { setPreview(null); return; }
    let cancel = false;
    renderProductLabel(toLabelProduct(products[0]), full).then((c) => !cancel && setPreview(c.toDataURL()));
    return () => { cancel = true; };
  }, [products, full]);

  const connect = async () => {
    try {
      const cfg = await printer.pair(kind, { ...DEFAULT_PRINTER, ...(printer.config ?? {}), transport: kind });
      if (!getSession()?.terminalId) localStorage.setItem(PRINTER_KEY, JSON.stringify(cfg));
      toast('เชื่อมต่อแล้ว: ' + printer.label, 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
  };

  const print = async () => {
    setBusy(true);
    try {
      const jobs: { product: any; copies: number }[] = products.map((x) => ({ product: x, copies: Math.max(0, qty[x.id] ?? o.copies) })).filter((j) => j.copies > 0);
      const total = jobs.reduce((a, j) => a + j.copies, 0);
      if (!total) return;
      // one print job per product keeps the queue readable and lets a failed product be retried alone
      for (const j of jobs) {
        const canvas = await renderProductLabel(toLabelProduct(j.product), full);
        printer.enqueue({
          saleId: null, kind: `label ${j.product.sku} ×${j.copies}`,
          build: async () => {
            const e = new EscPos().init();
            for (let k = 0; k < j.copies; k++) {
              e.raster(canvas);
              if (o.cutEach || k === j.copies - 1) e.feed(o.feedLines).cut('partial');
              else e.feed(1);
            }
            return { bytes: e.bytes(), canvas };
          },
        });
      }
      toast(`ส่งพิมพ์ฉลาก ${total} ดวง${p.connected ? '' : ' (ยังไม่ได้เชื่อมต่อเครื่องพิมพ์ — งานอยู่ในคิว)'}`, p.connected ? 'ok' : 'warn');
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };

  const S = (k: keyof Opts['show'], label: string) => <label className="check"><input type="checkbox" checked={o.show[k]} onChange={(e) => setO({ ...o, show: { ...o.show, [k]: e.target.checked } })} /> {label}</label>;

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) 340px', gap: '1rem', alignItems: 'start' }}>
      <div className="grid">
        <div className="card grid" style={{ gap: 8 }}>
          <div className="row between"><b>🖨️ เครื่องพิมพ์ใบเสร็จ</b><span className={`badge ${p.connected ? 'ok' : 'err'}`}>{p.connected ? `เชื่อมต่อแล้ว · ${p.label}` : 'ไม่ได้เชื่อมต่อ'}</span></div>
          <div className="row">
            <select className="in" style={{ width: 230 }} value={kind} onChange={(e) => setKind(e.target.value as TransportKind)}>
              <option value="usb">USB (WebUSB)</option><option value="bluetooth">Bluetooth (BLE)</option><option value="serial">Serial / Bluetooth SPP</option><option value="bridge">LAN / Wi-Fi (Print Bridge)</option>
            </select>
            <button className="btn" onClick={connect}>🔌 เชื่อมต่อ / เลือกเครื่อง</button>
            <span className="xs muted">กระดาษ {paperWidth} มม. · {dpi} dpi</span>
          </div>
          <p className="xs muted">ถ้าเครื่องพิมพ์ USB ใช้อยู่ในแท็บหน้าขาย (POS) ให้พิมพ์ฉลากจากเมนู “🏷️ ฉลาก” ในหน้าขายแทน — เบราว์เซอร์ให้ใช้อุปกรณ์ USB ได้ทีละแท็บ</p>
        </div>
        <div className="card grid" style={{ gap: 8 }}>
          <b>ขนาดฉลาก (กว้าง × ยาว มม.)</b>
          <div className="row">
            {LABEL_SIZES.map(([w, h]) => <button key={`${w}x${h}`} className={`btn sm ${o.widthMm === w && o.heightMm === h ? 'primary' : ''}`} onClick={() => setO({ ...o, widthMm: w, heightMm: h })}>{w}×{h}</button>)}
            <span className={`badge ${custom ? 'info' : ''}`}>กำหนดเอง</span>
            <input className="in" type="number" style={{ width: 80 }} value={o.widthMm} min={20} max={80} onChange={(e) => setO({ ...o, widthMm: Number(e.target.value) || 40 })} />×
            <input className="in" type="number" style={{ width: 80 }} value={o.heightMm} min={10} max={200} onChange={(e) => setO({ ...o, heightMm: Number(e.target.value) || 30 })} />
          </div>
          {tooWide && <div className="banner warn small">ฉลากกว้างกว่ากระดาษ {paperWidth} มม. — จะพิมพ์เต็มความกว้างที่พิมพ์ได้ ({paperWidth === 80 ? 72 : 48} มม.)</div>}
          <div className="row">{S('store', 'ชื่อร้าน')}{S('name', 'ชื่อสินค้า')}{S('price', 'ราคา')}{S('memberPrice', 'ราคาสมาชิก')}{S('barcode', 'บาร์โค้ด')}{S('barcodeText', 'ตัวเลขใต้บาร์โค้ด')}{S('sku', 'SKU')}{S('unit', 'หน่วย')}</div>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Field label="จำนวนดวง/สินค้า"><input className="in" type="number" min={1} style={{ width: 100 }} value={o.copies} onChange={(e) => setO({ ...o, copies: Math.max(1, Number(e.target.value) || 1) })} /></Field>
            <Field label="ป้อนกระดาษก่อนตัด (บรรทัด)"><input className="in" type="number" min={0} max={10} style={{ width: 100 }} value={o.feedLines} onChange={(e) => setO({ ...o, feedLines: Math.max(0, Number(e.target.value)) })} /></Field>
            <label className="check"><input type="checkbox" checked={o.cutEach} onChange={(e) => setO({ ...o, cutEach: e.target.checked })} /> ตัดกระดาษทุกดวง</label>
          </div>
        </div>
        <div className="table-wrap" style={{ maxHeight: 300 }}>
          <table className="t"><thead><tr><th>สินค้า</th><th>บาร์โค้ด</th><th className="right">ราคา</th><th style={{ width: 110 }}>จำนวนดวง</th></tr></thead>
            <tbody>{products.map((x) => <tr key={x.id}><td>{x.name}</td><td className="mono small">{toLabelProduct(x).barcode}</td><td className="right num">฿{(x.price / 100).toFixed(2)}</td>
              <td><input className="in" type="number" min={0} value={qty[x.id] ?? o.copies} onChange={(e) => setQty({ ...qty, [x.id]: Math.max(0, Number(e.target.value)) })} /></td></tr>)}</tbody></table>
          {!products.length && <div className="muted center" style={{ padding: '1rem' }}>ยังไม่ได้เลือกสินค้า</div>}
        </div>
        <button className="btn primary lg" disabled={busy || !products.length} onClick={print}>🖨️ พิมพ์ฉลากบาร์โค้ด</button>
      </div>
      <div className="paper-wrap" style={{ position: 'sticky', top: 8 }}>
        <div className="small muted" style={{ marginBottom: 6 }}>ตัวอย่าง (bitmap ที่ส่งเข้าเครื่องพิมพ์) {o.widthMm}×{o.heightMm} มม.</div>
        {preview ? <img className="paper" src={preview} style={{ width: 300 }} /> : <div className="muted">—</div>}
      </div>
    </div>
  );
}
