// Online-shop settings of a product: uploaded image gallery (any number, ordered), sizes (variants) and size chart.
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useToast, errMsg, MoneyInput } from '../components/ui';
import { fmtQty } from '../lib/format';

/** Downscale on the client so uploads stay small (longest side ≤ 1600px, WebP/JPEG). */
export async function prepareImage(file: File, maxSide = 1600): Promise<{ dataBase64: string; mime: string; width: number; height: number }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  if (file.type !== 'image/png') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const tryType = async (type: string, q?: number) => new Promise<Blob | null>((r) => c.toBlob(r, type, q));
  // keep transparency for PNG sources, otherwise prefer WebP (falls back to JPEG on old Safari)
  let blob = file.type === 'image/png' ? await tryType('image/webp', 0.9) : await tryType('image/webp', 0.85);
  if (!blob || blob.type !== 'image/webp') blob = file.type === 'image/png' ? await tryType('image/png') : await tryType('image/jpeg', 0.86);
  if (!blob) throw new Error('แปลงรูปภาพไม่สำเร็จ');
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { dataBase64: btoa(bin), mime: blob.type, width: w, height: h };
}

export function ImagesManager({ productId, onChange }: { productId: number; onChange?: () => void }) {
  const toast = useToast();
  const [imgs, setImgs] = useState<{ id: number }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const drag = useRef<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  const load = async () => setImgs(await api(`/api/products/${productId}/images`));
  useEffect(() => { load().catch(() => {}); /* eslint-disable-next-line */ }, [productId]);

  const upload = async (files: FileList | File[]) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    for (let i = 0; i < list.length; i++) {
      setBusy(`กำลังอัปโหลด ${i + 1}/${list.length}…`);
      try { await api(`/api/products/${productId}/images`, { body: await prepareImage(list[i]), timeoutMs: 60000 }); }
      catch (e) { toast(`${list[i].name}: ${errMsg(e)}`, 'err'); }
    }
    setBusy(null);
    await load(); onChange?.();
  };
  const saveOrder = async (next: { id: number }[]) => {
    setImgs(next);
    try { await api(`/api/products/${productId}/images/order`, { method: 'PUT', body: { ids: next.map((x) => x.id) } }); onChange?.(); }
    catch (e) { toast(errMsg(e), 'err'); load(); }
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= imgs.length || from === to) return;
    const next = [...imgs];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    saveOrder(next);
  };
  const remove = async (id: number) => {
    if (!confirm('ลบรูปนี้?')) return;
    try { await api(`/api/products/${productId}/images/${id}`, { method: 'DELETE' }); await load(); onChange?.(); } catch (e) { toast(errMsg(e), 'err'); }
  };

  return (
    <div onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); upload(e.dataTransfer.files); } }}>
      <div className="img-grid">
        {imgs.map((im, i) => (
          <div key={im.id} className={`img-tile ${over === i ? 'over' : ''}`} draggable
            onDragStart={() => { drag.current = i; }} onDragEnter={() => setOver(i)} onDragEnd={() => { drag.current = null; setOver(null); }}
            onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (drag.current != null) move(drag.current, i); drag.current = null; setOver(null); }}>
            <img src={`/api/shop/images/${im.id}`} alt="" loading="lazy" />
            {i === 0 && <span className="badge ok cover">รูปหลัก</span>}
            <span className="pos">{i + 1}</span>
            <div className="acts">
              <button type="button" className="btn sm" disabled={i === 0} onClick={() => move(i, i - 1)} title="เลื่อนซ้าย">◀</button>
              {i !== 0 && <button type="button" className="btn sm" onClick={() => move(i, 0)} title="ตั้งเป็นรูปหลัก">★</button>}
              <button type="button" className="btn sm" disabled={i === imgs.length - 1} onClick={() => move(i, i + 1)} title="เลื่อนขวา">▶</button>
              <button type="button" className="btn sm danger" onClick={() => remove(im.id)} title="ลบ">✕</button>
            </div>
          </div>
        ))}
        <label className="img-tile add">
          <input type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ''; }} />
          <div style={{ fontSize: 28 }}>＋</div><div className="small">{busy ?? 'อัปโหลดรูป (เลือกได้หลายรูป)'}</div>
        </label>
      </div>
      <p className="xs muted">ลากรูปเพื่อจัดลำดับ หรือใช้ปุ่ม ◀ ▶ · รูปแรกคือรูปหลักที่แสดงในหน้าร้านและ POS · ลากไฟล์มาวางที่นี่เพื่ออัปโหลด · ระบบย่อรูปอัตโนมัติ (ด้านยาวสุด 1600px)</p>
    </div>
  );
}

type Variant = { id?: number; label: string; sku: string; barcode: string; price: number; memberPrice: number | null; isActive: boolean; branchStock?: any[] };

export function VariantsEditor({ product, onSaved }: { product: any; onSaved?: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<Variant[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const load = async () => {
    const v: any[] = await api(`/api/products/${product.id}/variants`);
    setRows(v.map((x) => ({ id: x.id, label: x.variantLabel ?? '', sku: x.sku, barcode: x.barcodes.find((b: any) => Number(b.packQty) === 1)?.barcode ?? '', price: x.price, memberPrice: x.memberPrice, isActive: x.isActive, branchStock: x.branchStock })));
    setDirty(false);
  };
  useEffect(() => { load().catch(() => setRows([])); /* eslint-disable-next-line */ }, [product.id]);
  if (!rows) return <div className="muted small">กำลังโหลด…</div>;
  const set = (i: number, patch: Partial<Variant>) => { const r = [...rows]; r[i] = { ...r[i], ...patch }; setRows(r); setDirty(true); };
  const add = (labels: string[]) => {
    const have = new Set(rows.map((r) => r.label));
    setRows([...rows, ...labels.filter((l) => !have.has(l)).map((l) => ({ label: l, sku: `${product.sku}-${l}`.replace(/\s+/g, ''), barcode: '', price: product.price, memberPrice: product.memberPrice ?? null, isActive: true }))]);
    setDirty(true);
  };
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= rows.length) return; const r = [...rows]; [r[i], r[j]] = [r[j], r[i]]; setRows(r); setDirty(true); };
  const save = async () => {
    try {
      await api(`/api/products/${product.id}/variants`, { method: 'PUT', body: { variants: rows.map((r) => ({ id: r.id, label: r.label.trim(), sku: r.sku.trim(), barcode: r.barcode.trim() || null, price: r.price, memberPrice: r.memberPrice, isActive: r.isActive })) } });
      toast('บันทึกไซส์แล้ว', 'ok'); await load(); onSaved?.();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  return (
    <div>
      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        <span className="small muted">เพิ่มด่วน:</span>
        <button type="button" className="btn sm" onClick={() => add(['XS', 'S', 'M', 'L', 'XL', '2XL'])}>XS–2XL</button>
        <button type="button" className="btn sm" onClick={() => add(['S', 'M', 'L'])}>S/M/L</button>
        <button type="button" className="btn sm" onClick={() => add(['36', '37', '38', '39', '40', '41', '42', '43', '44'])}>รองเท้า 36–44</button>
        <button type="button" className="btn sm" onClick={() => add([`ไซส์ ${rows.length + 1}`])}>+ เพิ่ม 1 ไซส์</button>
      </div>
      {rows.length > 0 && (
        <table className="t">
          <thead><tr><th></th><th>ไซส์</th><th>SKU</th><th>บาร์โค้ด</th><th>ราคา</th><th>ราคาสมาชิก</th><th>สต็อก</th><th>ขาย</th><th></th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? 'n' + i}>
                <td className="nowrap"><button type="button" className="btn sm ghost" onClick={() => move(i, -1)}>▲</button><button type="button" className="btn sm ghost" onClick={() => move(i, 1)}>▼</button></td>
                <td><input className="in" style={{ width: 64 }} value={r.label} onChange={(e) => set(i, { label: e.target.value })} /></td>
                <td><input className="in mono" style={{ width: 130 }} value={r.sku} onChange={(e) => set(i, { sku: e.target.value })} /></td>
                <td><input className="in mono" style={{ width: 130 }} value={r.barcode} onChange={(e) => set(i, { barcode: e.target.value })} /></td>
                <td style={{ minWidth: 110 }}><MoneyInput value={r.price} onChange={(v) => set(i, { price: v ?? 0 })} /></td>
                <td style={{ minWidth: 110 }}><MoneyInput value={r.memberPrice} onChange={(v) => set(i, { memberPrice: v })} /></td>
                <td className="xs num nowrap">{r.branchStock ? r.branchStock.map((b: any) => <div key={b.branchId}>{b.branch.replace(/^สาขา/, '')}: <b>{fmtQty(Number(b.qty))}</b></div>) : <span className="muted">ใหม่</span>}</td>
                <td><input type="checkbox" checked={r.isActive} onChange={(e) => set(i, { isActive: e.target.checked })} /></td>
                <td><button type="button" className="btn sm ghost" onClick={() => { setRows(rows.filter((_, j) => j !== i)); setDirty(true); }}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="row" style={{ marginTop: 6 }}>
        <button type="button" className="btn primary sm" disabled={!dirty} onClick={save}>บันทึกไซส์</button>
        <span className="xs muted">แต่ละไซส์เป็นสินค้าแยก มี SKU/บาร์โค้ด/ราคา/สต็อกของตัวเอง (รับสต็อกได้จากรายการสินค้า หรือหน้าสต็อก) · ลบไซส์ที่เคยขายแล้วระบบจะปิดการขายแทน</span>
      </div>
    </div>
  );
}

export type SizeChart = { columns: string[]; rows: string[][]; note?: string | null };

export function SizeChartEditor({ value, onChange }: { value: SizeChart | null; onChange: (v: SizeChart | null) => void }) {
  if (!value) {
    return (
      <div className="row">
        <button type="button" className="btn sm" onClick={() => onChange({ columns: ['ไซส์', 'รอบอก (นิ้ว)', 'ความยาว (นิ้ว)'], rows: [['S', '', ''], ['M', '', ''], ['L', '', '']], note: '' })}>+ สร้างตารางไซส์ (เสื้อ)</button>
        <button type="button" className="btn sm" onClick={() => onChange({ columns: ['EU', 'UK', 'US', 'ความยาวเท้า (ซม.)'], rows: [['38', '5', '6', '24'], ['39', '6', '7', '24.5'], ['40', '6.5', '7.5', '25']], note: '' })}>+ ตารางไซส์รองเท้า</button>
        <button type="button" className="btn sm" onClick={() => onChange({ columns: ['ไซส์', ''], rows: [['', '']], note: '' })}>+ ตารางเปล่า</button>
      </div>
    );
  }
  const cols = value.columns;
  const setCell = (r: number, c: number, v: string) => onChange({ ...value, rows: value.rows.map((row, i) => (i === r ? row.map((x, j) => (j === c ? v : x)) : row)) });
  return (
    <div>
      <div className="table-wrap">
        <table className="t size-chart-edit">
          <thead>
            <tr>
              {cols.map((c, j) => (
                <th key={j}>
                  <div className="row" style={{ gap: 2, flexWrap: 'nowrap' }}>
                    <input className="in" style={{ minWidth: 80 }} value={c} placeholder="หัวคอลัมน์" onChange={(e) => onChange({ ...value, columns: cols.map((x, k) => (k === j ? e.target.value : x)) })} />
                    {cols.length > 1 && <button type="button" className="btn sm ghost" title="ลบคอลัมน์" onClick={() => onChange({ ...value, columns: cols.filter((_, k) => k !== j), rows: value.rows.map((r) => r.filter((_, k) => k !== j)) })}>✕</button>}
                  </div>
                </th>
              ))}
              <th><button type="button" className="btn sm" disabled={cols.length >= 12} onClick={() => onChange({ ...value, columns: [...cols, ''], rows: value.rows.map((r) => [...r, '']) })}>+ คอลัมน์</button></th>
            </tr>
          </thead>
          <tbody>
            {value.rows.map((row, i) => (
              <tr key={i}>
                {cols.map((_, j) => <td key={j}><input className="in" value={row[j] ?? ''} onChange={(e) => setCell(i, j, e.target.value)} /></td>)}
                <td><button type="button" className="btn sm ghost" onClick={() => onChange({ ...value, rows: value.rows.filter((_, k) => k !== i) })}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button type="button" className="btn sm" disabled={value.rows.length >= 60} onClick={() => onChange({ ...value, rows: [...value.rows, cols.map(() => '')] })}>+ แถว</button>
        <input className="in" style={{ flex: 1 }} placeholder="หมายเหตุ เช่น วัดแบบวางราบ คลาดเคลื่อน ±1 นิ้ว" value={value.note ?? ''} onChange={(e) => onChange({ ...value, note: e.target.value })} />
        <button type="button" className="btn sm danger" onClick={() => confirm('ลบตารางไซส์?') && onChange(null)}>ลบตาราง</button>
      </div>
    </div>
  );
}
