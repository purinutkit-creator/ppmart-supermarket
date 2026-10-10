import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApi, Field, useToast, errMsg } from '../components/ui';
import { renderReceipt, sampleReceiptData } from '../lib/receipt-render';
import { receiptJob } from '../lib/escpos';
import { printer } from '../lib/printer';
import { usePrinterState } from '../components/DevicesPanel';
import { toReceiptData, setPrintSettings } from '../lib/receipt-print';
import { listFonts } from '../lib/fonts';
import { defaultTemplates, ELEMENT_LABELS, type ReceiptElement, type ReceiptElementType, type ReceiptTemplate, type TextStyle } from '../../../shared/receipt';
import { uuid } from '../lib/format';

const SUB_STYLES: Partial<Record<ReceiptElementType, [string, string][]>> = {
  items: [['price', 'ราคา']], grand_total: [['value', 'ตัวเลขยอดรวม']],
  coupon: [['title', 'หัวคูปอง'], ['reward', 'ข้อความสิทธิ์'], ['code', 'รหัส/Barcode Coupon']],
};

export default function ReceiptDesigner() {
  const toast = useToast();
  const p = usePrinterState();
  const { data: settings, reload } = useApi<any>('/api/admin/settings');
  const [which, setWhich] = useState<'summary' | 'customer'>('customer');
  const [tpls, setTpls] = useState<{ summary: ReceiptTemplate; customer: ReceiptTemplate } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [families, setFamilies] = useState<string[]>([]);
  const [sampleSaleId, setSampleSaleId] = useState('');
  const [realData, setRealData] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => { listFonts(true).then((f) => setFamilies([...new Set(['Sarabun', 'Kanit', 'Prompt', 'Noto Sans Thai', 'Noto Sans SC', ...f.map((x) => x.family)])])); }, []);
  useEffect(() => {
    if (!settings) return;
    const d = defaultTemplates(settings.fonts?.receipt || 'Sarabun');
    setTpls({ summary: settings.receipt?.summary ?? d.summary, customer: settings.receipt?.customer ?? d.customer });
  }, [settings]);

  const t = tpls?.[which];
  const data = useMemo(() => realData ?? sampleReceiptData(settings?.store), [realData, settings]);

  // Re-render preview with the exact renderer used for printing
  useEffect(() => {
    if (!t) return;
    let cancel = false;
    setRendering(true);
    const h = setTimeout(async () => {
      try {
        const c = await renderReceipt(t, data);
        if (!cancel) { canvasRef.current = c; setImg(c.toDataURL()); }
      } catch (e) { console.error(e); } finally { if (!cancel) setRendering(false); }
    }, 250);
    return () => { cancel = true; clearTimeout(h); };
  }, [t, data]);

  if (!tpls || !t) return <div className="muted">กำลังโหลด…</div>;
  const setT = (patch: Partial<ReceiptTemplate>) => { setTpls({ ...tpls, [which]: { ...t, ...patch } }); setDirty(true); };
  const el = t.elements.find((e) => e.id === sel) ?? null;
  const setEl = (patch: Partial<ReceiptElement>) => setT({ elements: t.elements.map((e) => (e.id === sel ? { ...e, ...patch } : e)) });
  const setStyle = (patch: Partial<TextStyle>) => el && setEl({ style: { ...(el.style || {}), ...patch } });
  const setSub = (key: string, patch: Partial<TextStyle>) => el && setEl({ styles: { ...(el.styles || {}), [key]: { ...(el.styles?.[key] || {}), ...patch } } });
  const setOpt = (k: string, v: any) => el && setEl({ options: { ...(el.options || {}), [k]: v } });
  const add = (type: ReceiptElementType) => {
    const n: ReceiptElement = { id: uuid().slice(0, 8), type, ...(type === 'custom_text' || type === 'promotion' ? { text: 'ข้อความ' } : {}), ...(type === 'qr' ? { options: { data: '{billNo}', sizePct: 40 } } : {}), ...(type === 'barcode' ? { options: { data: '{billNo}', height: 60 } } : {}) };
    const i = sel ? t.elements.findIndex((e) => e.id === sel) + 1 : t.elements.length;
    const els = [...t.elements]; els.splice(i, 0, n);
    setT({ elements: els }); setSel(n.id);
  };
  const move = (from: string, to: string) => {
    if (from === to) return;
    const els = [...t.elements];
    const a = els.findIndex((e) => e.id === from), b = els.findIndex((e) => e.id === to);
    const [x] = els.splice(a, 1); els.splice(b, 0, x);
    setT({ elements: els });
  };
  const save = async () => {
    try {
      const body = { ...(settings.receipt || {}), summary: tpls.summary, customer: tpls.customer, printOrder: settings.receipt?.printOrder ?? ['summary', 'customer'], copies: settings.receipt?.copies ?? { summary: 1, customer: 1 }, autoPrint: settings.receipt?.autoPrint ?? { summary: true, customer: true } };
      await api('/api/admin/settings/receipt', { method: 'PUT', body });
      setPrintSettings({ receipt: body, store: settings.store, tax: settings.tax });
      setDirty(false); toast('บันทึกรูปแบบใบเสร็จแล้ว — ทุกเครื่อง POS จะใช้รูปแบบนี้ในการพิมพ์จริง', 'ok'); reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  const testPrint = async () => {
    // print exactly this template at the connected printer's paper width/DPI
    const tt = printer.config ? { ...t, paperWidth: printer.config.paperWidth, dpi: printer.config.dpi } : t;
    const c = await renderReceipt(tt, data);
    printer.enqueue({ saleId: null, kind: 'test-' + which, build: async () => ({ bytes: receiptJob(c, { cut: tt.cut, feedLines: tt.feedLines }), canvas: c }) });
    toast(p.connected ? 'ส่ง Test Print แล้ว' : 'ยังไม่ได้เชื่อมต่อเครื่องพิมพ์ (ตั้งค่าที่เมนูอุปกรณ์) — งานอยู่ในคิว', p.connected ? 'ok' : 'warn');
  };
  const loadReal = async () => {
    if (!sampleSaleId) { setRealData(null); return; }
    try { const r = await api(`/api/pos/sales/${sampleSaleId}/receipt`); setRealData(toReceiptData(r, settings.store, settings.tax)); } catch (e) { toast(errMsg(e), 'err'); }
  };

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head">
        <h1>Receipt Designer</h1>
        <div className="row">
          <div className="tabs" style={{ margin: 0, border: 0 }}>
            <button className={which === 'summary' ? 'on' : ''} onClick={() => { setWhich('summary'); setSel(null); }}>Receipt 1 — Short Summary</button>
            <button className={which === 'customer' ? 'on' : ''} onClick={() => { setWhich('customer'); setSel(null); }}>Receipt 2 — Customer Receipt</button>
          </div>
          <button className="btn" onClick={() => { if (confirm('รีเซ็ตเป็นรูปแบบเริ่มต้น?')) setT(defaultTemplates(settings.fonts?.receipt || 'Sarabun')[which]); }}>รีเซ็ต</button>
          <button className="btn" onClick={testPrint}>🖨️ Test Print {p.connected ? '' : '(ไม่ได้เชื่อมต่อ)'}</button>
          <button className="btn primary" onClick={save} disabled={!dirty}>💾 บันทึก</button>
        </div>
      </div>
      <div className="designer">
        <div>
          <div className="card" style={{ padding: '.7rem' }}>
            <b className="small">โครงสร้างใบเสร็จ (ลากเพื่อเรียงลำดับ)</b>
            <div style={{ marginTop: 8 }}>
              {t.elements.map((e) => (
                <div key={e.id} draggable onDragStart={() => setDragId(e.id)} onDragOver={(ev) => { ev.preventDefault(); setOverId(e.id); }} onDragLeave={() => setOverId(null)}
                  onDrop={() => { if (dragId) move(dragId, e.id); setDragId(null); setOverId(null); }}
                  className={`el-item ${sel === e.id ? 'sel' : ''} ${overId === e.id ? 'drag-over' : ''} ${e.hidden ? 'hidden-el' : ''}`} onClick={() => setSel(e.id)}>
                  <span>⋮⋮</span><span style={{ flex: 1 }}>{ELEMENT_LABELS[e.type]}{e.text ? <span className="xs muted"> — {e.text.slice(0, 14)}</span> : null}</span>
                  <button className="btn sm ghost" title="ซ่อน/แสดง" onClick={(ev) => { ev.stopPropagation(); setT({ elements: t.elements.map((x) => (x.id === e.id ? { ...x, hidden: !x.hidden } : x)) }); }}>{e.hidden ? '🙈' : '👁'}</button>
                  <button className="btn sm ghost" title="ลบ" onClick={(ev) => { ev.stopPropagation(); setT({ elements: t.elements.filter((x) => x.id !== e.id) }); if (sel === e.id) setSel(null); }}>✕</button>
                </div>
              ))}
            </div>
          </div>
          <div className="card" style={{ padding: '.7rem', marginTop: 8 }}>
            <b className="small">+ เพิ่มองค์ประกอบ</b>
            <div className="row" style={{ marginTop: 6, gap: 4 }}>{(Object.keys(ELEMENT_LABELS) as ReceiptElementType[]).map((k) => <button key={k} className="btn sm" onClick={() => add(k)}>{ELEMENT_LABELS[k]}</button>)}</div>
          </div>
        </div>

        <div className="grid">
          <div className="row small">
            <span>ตัวอย่างข้อมูล:</span><input className="in" style={{ width: 160 }} placeholder="Sale ID จริง (ว่าง = ตัวอย่าง)" value={sampleSaleId} onChange={(e) => setSampleSaleId(e.target.value)} /><button className="btn sm" onClick={loadReal}>โหลด</button>
            <span className="muted">{t.paperWidth} มม. · {t.dpi} dpi · {rendering ? 'กำลังเรนเดอร์…' : 'Preview = Bitmap ที่ส่งเข้าเครื่องพิมพ์จริง'}</span>
            {img && <a className="btn sm" href={img} download={`receipt-${which}.png`}>⬇ PNG</a>}
          </div>
          <div className="paper-wrap">
            {img && <img className="paper" src={img} style={{ width: t.paperWidth === 58 ? 260 : 380 }} alt="receipt preview" />}
          </div>
        </div>

        <div className="grid" style={{ gap: 8 }}>
          <div className="card grid" style={{ padding: '.7rem', gap: 6 }}>
            <b className="small">กระดาษและเครื่องพิมพ์</b>
            <div className="grid g2" style={{ gap: 6 }}>
              <Field label="ขนาดกระดาษ"><select className="in" value={t.paperWidth} onChange={(e) => setT({ paperWidth: Number(e.target.value) as 58 | 80 })}><option value={80}>80 มม.</option><option value={58}>58 มม.</option></select></Field>
              <Field label="DPI"><select className="in" value={t.dpi} onChange={(e) => setT({ dpi: Number(e.target.value) })}><option value={203}>203</option><option value={180}>180</option><option value={300}>300</option></select></Field>
              <Field label="ระยะขอบซ้าย-ขวา (มม.)"><input className="in" type="number" step="0.5" value={t.marginX} onChange={(e) => setT({ marginX: Number(e.target.value) })} /></Field>
              <Field label="ป้อนกระดาษก่อนตัด (บรรทัด)"><input className="in" type="number" value={t.feedLines} onChange={(e) => setT({ feedLines: Number(e.target.value) })} /></Field>
              <Field label="การตัดกระดาษ"><select className="in" value={t.cut} onChange={(e) => setT({ cut: e.target.value as any })}><option value="partial">Partial Cut</option><option value="full">Full Cut</option><option value="none">ไม่ตัด</option></select></Field>
              <Field label="ความเข้ม (threshold)"><input className="in" type="range" min={80} max={230} value={t.threshold ?? 160} onChange={(e) => setT({ threshold: Number(e.target.value) })} /></Field>
            </div>
          </div>
          <StyleEditor t={t} families={families} title="สไตล์ตัวอักษรเริ่มต้นของใบนี้" s={t.defaultStyle} onChange={(x) => setT({ defaultStyle: { ...t.defaultStyle, ...Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) } as TextStyle })} />
          {el ? (
            <>
              <div className="card grid" style={{ padding: '.7rem', gap: 6 }}>
                <b>{ELEMENT_LABELS[el.type]}</b>
                {!['divider', 'spacer', 'logo', 'items', 'coupon', 'qr', 'barcode', 'title', 'custom_text', 'promotion', 'thank_you'].includes(el.type) && <Field label="ป้ายกำกับ (Label)"><input className="in" value={el.label ?? ''} onChange={(e) => setEl({ label: e.target.value })} /></Field>}
                {['title', 'custom_text', 'promotion', 'thank_you', 'qr'].includes(el.type) && <Field label="ข้อความ (รองรับ {billNo} {date} {time} {total} {storeName} {branch} {memberNo} {points})"><textarea className="in" rows={3} value={el.text ?? ''} onChange={(e) => setEl({ text: e.target.value })} /></Field>}
                {el.type === 'items' && <>
                  <label className="check"><input type="checkbox" checked={el.options?.showUnitPrice !== false} onChange={(e) => setOpt('showUnitPrice', e.target.checked)} /> แสดงจำนวน × ราคาต่อหน่วย</label>
                  <label className="check"><input type="checkbox" checked={el.options?.showDiscount !== false} onChange={(e) => setOpt('showDiscount', e.target.checked)} /> แสดงส่วนลดรายการ</label>
                  <label className="check"><input type="checkbox" checked={!!el.options?.compact} onChange={(e) => setOpt('compact', e.target.checked)} /> แบบบรรทัดเดียว</label>
                  <Field label="แสดงสูงสุด (0 = ทั้งหมด, ที่เหลือแสดงเป็น “สินค้าอื่น ๆ N รายการ”)"><input className="in" type="number" value={el.options?.maxItems ?? 0} onChange={(e) => setOpt('maxItems', Number(e.target.value))} /></Field>
                </>}
                {el.type === 'discount' && <label className="check"><input type="checkbox" checked={!!el.options?.breakdown} onChange={(e) => setOpt('breakdown', e.target.checked)} /> แสดงรายละเอียดส่วนลด</label>}
                {el.type === 'vat' && <label className="check"><input type="checkbox" checked={el.options?.showBase !== false} onChange={(e) => setOpt('showBase', e.target.checked)} /> แสดงมูลค่าก่อนภาษี</label>}
                {el.type === 'receipt_no' && <label className="check"><input type="checkbox" checked={!!el.options?.short} onChange={(e) => setOpt('short', e.target.checked)} /> แสดงเฉพาะเลขลำดับ (000125)</label>}
                {el.type === 'logo' && <Field label="ความกว้าง (%)"><input className="in" type="number" value={el.options?.widthPct ?? 50} onChange={(e) => setOpt('widthPct', Number(e.target.value))} /></Field>}
                {(el.type === 'qr' || el.type === 'barcode') && <Field label="ข้อมูลที่เข้ารหัส"><input className="in" value={el.options?.data ?? '{billNo}'} onChange={(e) => setOpt('data', e.target.value)} /></Field>}
                {el.type === 'qr' && <Field label="ขนาด (% ของความกว้าง)"><input className="in" type="number" value={el.options?.sizePct ?? 45} onChange={(e) => setOpt('sizePct', Number(e.target.value))} /></Field>}
                {el.type === 'barcode' && <><Field label="ความสูง (dots)"><input className="in" type="number" value={el.options?.height ?? 60} onChange={(e) => setOpt('height', Number(e.target.value))} /></Field><label className="check"><input type="checkbox" checked={!!el.options?.showText} onChange={(e) => setOpt('showText', e.target.checked)} /> แสดงตัวเลขใต้บาร์โค้ด</label></>}
                {el.type === 'coupon' && <>
                  <Field label="หัวข้อคูปอง"><input className="in" value={el.options?.header ?? '🎁 SPECIAL COUPON'} onChange={(e) => setOpt('header', e.target.value)} /></Field>
                  <Field label="ข้อความครั้งถัดไป"><input className="in" value={el.options?.nextTimeText ?? 'สำหรับการซื้อครั้งถัดไป'} onChange={(e) => setOpt('nextTimeText', e.target.value)} /></Field>
                  <Field label="ข้อความใช้ครั้งเดียว"><input className="in" value={el.options?.singleUseText ?? 'ใช้ได้ 1 ครั้งเท่านั้น'} onChange={(e) => setOpt('singleUseText', e.target.value)} /></Field>
                  <Field label="ความสูง Barcode Coupon (dots)"><input className="in" type="number" value={el.options?.barcodeHeight ?? 70} onChange={(e) => setOpt('barcodeHeight', Number(e.target.value))} /></Field>
                </>}
                {el.type === 'divider' && <Field label="รูปแบบเส้น"><select className="in" value={el.options?.style ?? 'dashed'} onChange={(e) => setOpt('style', e.target.value)}><option value="dashed">เส้นประ</option><option value="solid">เส้นทึบ</option><option value="double">เส้นคู่</option></select></Field>}
                {el.type === 'spacer' && <Field label="ความสูง (dots)"><input className="in" type="number" value={el.options?.height ?? 20} onChange={(e) => setOpt('height', Number(e.target.value))} /></Field>}
                <div className="grid g2" style={{ gap: 6 }}>
                  <Field label="ระยะห่างด้านบน"><input className="in" type="number" value={el.marginTop ?? 0} onChange={(e) => setEl({ marginTop: Number(e.target.value) })} /></Field>
                  <Field label="ระยะห่างด้านล่าง"><input className="in" type="number" value={el.marginBottom ?? 2} onChange={(e) => setEl({ marginBottom: Number(e.target.value) })} /></Field>
                </div>
              </div>
              {!['divider', 'spacer'].includes(el.type) && <StyleEditor t={t} families={families} title="ฟอนต์และการจัดวางขององค์ประกอบนี้" s={el.style ?? {}} onChange={setStyle} />}
              {(SUB_STYLES[el.type] ?? []).map(([k, l]) => <StyleEditor t={t} families={families} key={k} title={`ฟอนต์: ${l}`} s={el.styles?.[k] ?? {}} onChange={(x) => setSub(k, x)} />)}
            </>
          ) : <div className="card muted small">เลือกองค์ประกอบทางซ้ายเพื่อแก้ไขฟอนต์ ขนาด ความหนา Line Height Letter Spacing และการจัดแนว</div>}
        </div>
      </div>
    </div>
  );
}

function StyleEditor({ s, onChange, title, t, families }: { s: Partial<TextStyle>; onChange: (p: Partial<TextStyle>) => void; title: string; t: ReceiptTemplate; families: string[] }) {
  return (
    <div className="card grid" style={{ padding: '.7rem', gap: 6 }}>
      <b className="small">{title}</b>
      <Field label="Font Family"><select className="in" value={s.fontFamily ?? ''} onChange={(e) => onChange({ fontFamily: e.target.value || undefined })} style={{ fontFamily: s.fontFamily ? `"${s.fontFamily}"` : undefined }}><option value="">(ค่าเริ่มต้น: {t.defaultStyle.fontFamily})</option>{families.map((f) => <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>{f}</option>)}</select></Field>
      <div className="grid g2" style={{ gap: 6 }}>
        <Field label="Font Size (pt)"><input className="in" type="number" step="0.5" value={s.fontSize ?? ''} placeholder={String(t.defaultStyle.fontSize)} onChange={(e) => onChange({ fontSize: e.target.value ? Number(e.target.value) : undefined })} /></Field>
        <Field label="Font Weight"><select className="in" value={s.fontWeight ?? ''} onChange={(e) => onChange({ fontWeight: e.target.value ? Number(e.target.value) : undefined })}><option value="">-</option>{[300, 400, 500, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}{w === 400 ? ' Regular' : w === 700 ? ' Bold' : ''}</option>)}</select></Field>
        <Field label="Line Height"><input className="in" type="number" step="0.05" value={s.lineHeight ?? ''} placeholder={String(t.defaultStyle.lineHeight)} onChange={(e) => onChange({ lineHeight: e.target.value ? Number(e.target.value) : undefined })} /></Field>
        <Field label="Letter Spacing (dots)"><input className="in" type="number" value={s.letterSpacing ?? ''} placeholder="0" onChange={(e) => onChange({ letterSpacing: e.target.value ? Number(e.target.value) : undefined })} /></Field>
      </div>
      <div className="row">
        {(['left', 'center', 'right'] as const).map((a) => <button key={a} className={`btn sm ${(s.align ?? t.defaultStyle.align) === a ? 'primary' : ''}`} onClick={() => onChange({ align: a })}>{a === 'left' ? '⇤ ซ้าย' : a === 'center' ? '↔ กลาง' : 'ขวา ⇥'}</button>)}
        <button className={`btn sm ${(s.fontWeight ?? 400) >= 700 ? 'primary' : ''}`} onClick={() => onChange({ fontWeight: (s.fontWeight ?? 400) >= 700 ? 400 : 700 })}><b>B</b></button>
        <button className={`btn sm ${s.italic ? 'primary' : ''}`} onClick={() => onChange({ italic: !s.italic })}><i>I</i></button>
        <button className={`btn sm ${s.invert ? 'primary' : ''}`} onClick={() => onChange({ invert: !s.invert })}>◼ กลับสี</button>
      </div>
    </div>
  );
}
