import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useApi, Modal, Field, MoneyInput, useToast, errMsg, BarcodeSvg } from '../components/ui';
import { fmtMoney, fmtQty, baht } from '../lib/format';
import { readSheet, exportXLSX, exportCSV, type Col } from '../lib/export';
import { gtinCheckDigit } from '../../../shared/barcode';

const empty = { sku: '', name: '', nameEn: '', nameZh: '', categoryId: null, brandId: null, unitId: null, price: 0, cost: 0, memberPrice: null, wholesalePrice: null, wholesaleMinQty: null, isWeighted: false, trackStock: true, vatExempt: false, isActive: true, saleBlocked: false, blockReason: '', minStock: 0, imageUrl: '', barcodes: [] as any[] };

export default function Products() {
  const toast = useToast();
  const [tab, setTab] = useState<'list' | 'meta' | 'labels'>('list');
  const [q, setQ] = useState('');
  const [catId, setCatId] = useState('');
  const { data: list, reload } = useApi<any[]>(`/api/products?q=${encodeURIComponent(q)}&categoryId=${catId}`, [q, catId]);
  const { data: cats, reload: rc } = useApi<any[]>('/api/products/meta/categories');
  const { data: brands, reload: rb } = useApi<any[]>('/api/products/meta/brands');
  const { data: units, reload: ru } = useApi<any[]>('/api/products/meta/units');
  const { data: branches } = useApi<any[]>('/api/admin/branches');
  const [edit, setEdit] = useState<any>(null);
  const [importRes, setImportRes] = useState<any>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const save = async () => {
    try {
      const body = { ...edit, categoryId: edit.categoryId ? Number(edit.categoryId) : null, brandId: edit.brandId ? Number(edit.brandId) : null, unitId: edit.unitId ? Number(edit.unitId) : null, wholesaleMinQty: edit.wholesaleMinQty ? Number(edit.wholesaleMinQty) : null, minStock: Number(edit.minStock || 0), barcodes: edit.barcodes.filter((b: any) => b.barcode).map((b: any) => ({ barcode: b.barcode.trim(), packQty: Number(b.packQty || 1), packPrice: b.packPrice ?? null })) };
      if (edit.id) await api(`/api/products/${edit.id}`, { method: 'PUT', body }); else await api('/api/products', { body });
      toast('บันทึกแล้ว', 'ok'); setEdit(null); reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  };

  const doImport = async (file: File, branchId?: number) => {
    try {
      const rows = await readSheet(file);
      const r = await api('/api/products/import', { body: { rows, branchId }, timeoutMs: 120000 });
      setImportRes(r); reload();
    } catch (e) { toast(errMsg(e), 'err'); }
  };

  const cols: Col[] = [
    { key: 'sku', label: 'sku' }, { key: 'name', label: 'name' }, { key: 'nameEn', label: 'name_en' }, { key: 'nameZh', label: 'name_zh' },
    { key: 'categoryName', label: 'category' }, { key: 'brandName', label: 'brand' }, { key: 'unitName', label: 'unit' },
    { key: 'price', label: 'price', get: (r) => baht(r.price) }, { key: 'cost', label: 'cost', get: (r) => (r.cost != null ? baht(r.cost) : '') },
    { key: 'memberPrice', label: 'member_price', get: (r) => (r.memberPrice != null ? baht(r.memberPrice) : '') }, { key: 'wholesalePrice', label: 'wholesale_price', get: (r) => (r.wholesalePrice != null ? baht(r.wholesalePrice) : '') },
    { key: 'wholesaleMinQty', label: 'wholesale_min_qty' }, { key: 'isWeighted', label: 'is_weighted' }, { key: 'minStock', label: 'min_stock' },
    { key: 'barcodes', label: 'barcodes', get: (r) => r.barcodes.filter((b: any) => Number(b.packQty) === 1).map((b: any) => b.barcode).join('|') }, { key: 'stock', label: 'stock' },
  ];

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head">
        <h1>สินค้า</h1>
        <div className="row">
          <button className="btn primary" onClick={() => setEdit({ ...empty })}>+ เพิ่มสินค้า</button>
          <label className="btn">⬆ นำเข้า Excel/CSV<input type="file" hidden accept=".csv,.xlsx,.xls" onChange={(e) => { const f = e.target.files?.[0]; if (f) { const b = branches?.[0]?.id; doImport(f, confirm(`ปรับยอดสต็อกตามคอลัมน์ stock ที่สาขา "${branches?.[0]?.name}" ด้วยหรือไม่?`) ? b : undefined); } e.target.value = ''; }} /></label>
          <button className="btn" onClick={() => exportXLSX(list ?? [], cols, 'products')}>⬇ Excel</button>
          <button className="btn" onClick={() => exportCSV([], cols, 'products-template')}>⬇ Template</button>
        </div>
      </div>
      <div className="tabs">
        <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>รายการสินค้า</button>
        <button className={tab === 'meta' ? 'on' : ''} onClick={() => setTab('meta')}>หมวดหมู่ / แบรนด์ / หน่วยนับ</button>
        <button className={tab === 'labels' ? 'on' : ''} onClick={() => setTab('labels')}>พิมพ์ป้ายราคา/ฉลากบาร์โค้ด ({selected.size})</button>
      </div>
      {tab === 'list' && (
        <>
          <div className="row"><input className="in" style={{ maxWidth: 360 }} placeholder="ค้นหาชื่อ / SKU / บาร์โค้ด" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="in" style={{ width: 200 }} value={catId} onChange={(e) => setCatId(e.target.value)}><option value="">ทุกหมวด</option>{cats?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th><input type="checkbox" onChange={(e) => setSelected(e.target.checked ? new Set(list?.map((p) => p.id)) : new Set())} /></th><th>SKU</th><th>สินค้า</th><th>หมวด</th><th>บาร์โค้ด</th><th className="right">ราคา</th><th className="right">ราคาสมาชิก</th><th className="right">ต้นทุน</th><th className="right">สต็อก</th><th>สถานะ</th></tr></thead>
              <tbody>
                {list?.map((p) => (
                  <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => setEdit({ ...p, barcodes: p.barcodes.map((b: any) => ({ ...b })) })}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={selected.has(p.id)} onChange={(e) => { const s = new Set(selected); e.target.checked ? s.add(p.id) : s.delete(p.id); setSelected(s); }} /></td>
                    <td className="mono small">{p.sku}</td><td>{p.name}<div className="xs muted">{p.nameEn}</div></td><td className="small">{p.categoryName}</td>
                    <td className="xs mono">{p.barcodes.map((b: any) => `${b.barcode}${Number(b.packQty) !== 1 ? ` (×${b.packQty})` : ''}`).join(', ')}</td>
                    <td className="right num">{fmtMoney(p.price)}{p.isWeighted ? '/กก.' : ''}</td><td className="right num">{p.memberPrice != null ? fmtMoney(p.memberPrice) : '-'}</td><td className="right num">{p.cost != null ? fmtMoney(p.cost) : '•••'}</td>
                    <td className={`right num ${p.trackStock && Number(p.stock) <= Number(p.minStock) ? 'err' : ''}`}>{p.trackStock ? fmtQty(Number(p.stock)) : '∞'}</td>
                    <td>{!p.isActive ? <span className="badge">ปิด</span> : p.saleBlocked ? <span className="badge err">ห้ามขาย</span> : <span className="badge ok">ขาย</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tab === 'meta' && (
        <div className="grid g3">
          <MetaList title="หมวดหมู่" path="categories" rows={cats ?? []} reload={rc} extra={['nameEn', 'nameZh']} />
          <MetaList title="แบรนด์" path="brands" rows={brands ?? []} reload={rb} />
          <MetaList title="หน่วยนับ" path="units" rows={units ?? []} reload={ru} extra={['nameEn']} />
        </div>
      )}
      {tab === 'labels' && <Labels products={(list ?? []).filter((p) => selected.has(p.id))} />}

      {edit && (
        <Modal title={edit.id ? `แก้ไข: ${edit.name}` : 'เพิ่มสินค้า'} onClose={() => setEdit(null)} width={860}
          footer={<>{edit.id && <button className="btn danger" onClick={async () => { if (!confirm('ลบสินค้านี้? (หากเคยขายแล้วจะปิดการขายแทน)')) return; await api(`/api/products/${edit.id}`, { method: 'DELETE' }); setEdit(null); reload(); }}>ลบ</button>}<span className="spacer" /><button className="btn" onClick={() => setEdit(null)}>ยกเลิก</button><button className="btn primary" onClick={save}>บันทึก</button></>}>
          <div className="grid g3">
            <Field label="SKU"><input className="in" value={edit.sku} onChange={(e) => setEdit({ ...edit, sku: e.target.value })} /></Field>
            <Field label="ชื่อสินค้า (ไทย)"><input className="in" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="English name"><input className="in" value={edit.nameEn ?? ''} onChange={(e) => setEdit({ ...edit, nameEn: e.target.value })} /></Field>
            <Field label="中文名称"><input className="in" value={edit.nameZh ?? ''} onChange={(e) => setEdit({ ...edit, nameZh: e.target.value })} /></Field>
            <Field label="หมวดหมู่"><select className="in" value={edit.categoryId ?? ''} onChange={(e) => setEdit({ ...edit, categoryId: e.target.value || null })}><option value="">-</option>{cats?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="แบรนด์"><select className="in" value={edit.brandId ?? ''} onChange={(e) => setEdit({ ...edit, brandId: e.target.value || null })}><option value="">-</option>{brands?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="หน่วยนับ"><select className="in" value={edit.unitId ?? ''} onChange={(e) => setEdit({ ...edit, unitId: e.target.value || null })}><option value="">-</option>{units?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <Field label="ราคาขาย"><MoneyInput value={edit.price} onChange={(v) => setEdit({ ...edit, price: v ?? 0 })} /></Field>
            <Field label="ราคาทุน"><MoneyInput value={edit.cost} onChange={(v) => setEdit({ ...edit, cost: v ?? 0 })} /></Field>
            <Field label="ราคาสมาชิก"><MoneyInput value={edit.memberPrice} onChange={(v) => setEdit({ ...edit, memberPrice: v })} /></Field>
            <Field label="ราคาส่ง"><MoneyInput value={edit.wholesalePrice} onChange={(v) => setEdit({ ...edit, wholesalePrice: v })} /></Field>
            <Field label="ราคาส่งเมื่อซื้อขั้นต่ำ (ชิ้น)"><input className="in" type="number" value={edit.wholesaleMinQty ?? ''} onChange={(e) => setEdit({ ...edit, wholesaleMinQty: e.target.value })} /></Field>
            <Field label="สต็อกขั้นต่ำ (แจ้งเตือน)"><input className="in" type="number" value={edit.minStock} onChange={(e) => setEdit({ ...edit, minStock: e.target.value })} /></Field>
            <Field label="รูปสินค้า (URL)"><input className="in" value={edit.imageUrl ?? ''} onChange={(e) => setEdit({ ...edit, imageUrl: e.target.value })} /></Field>
          </div>
          <div className="row" style={{ margin: '12px 0' }}>
            <label className="check"><input type="checkbox" checked={edit.isWeighted} onChange={(e) => setEdit({ ...edit, isWeighted: e.target.checked })} /> สินค้าชั่งน้ำหนัก (ราคาต่อ กก.)</label>
            <label className="check"><input type="checkbox" checked={edit.trackStock} onChange={(e) => setEdit({ ...edit, trackStock: e.target.checked })} /> ตัดสต็อก</label>
            <label className="check"><input type="checkbox" checked={edit.vatExempt} onChange={(e) => setEdit({ ...edit, vatExempt: e.target.checked })} /> ยกเว้น VAT</label>
            <label className="check"><input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> เปิดขาย</label>
            <label className="check"><input type="checkbox" checked={edit.saleBlocked} onChange={(e) => setEdit({ ...edit, saleBlocked: e.target.checked })} /> ห้ามจำหน่าย</label>
            {edit.saleBlocked && <input className="in" style={{ width: 260 }} placeholder="เหตุผลที่ห้ามจำหน่าย" value={edit.blockReason ?? ''} onChange={(e) => setEdit({ ...edit, blockReason: e.target.value })} />}
          </div>
          <h3>บาร์โค้ด (หลายบาร์โค้ดต่อสินค้า / แพ็ก)</h3>
          <table className="t"><thead><tr><th>บาร์โค้ด (EAN-13/EAN-8/UPC/Code128)</th><th>จำนวนต่อแพ็ก</th><th>ราคาแพ็ก</th><th></th></tr></thead><tbody>
            {edit.barcodes.map((b: any, i: number) => (
              <tr key={i}>
                <td><input className="in mono" value={b.barcode} onChange={(e) => { const bs = [...edit.barcodes]; bs[i] = { ...b, barcode: e.target.value }; setEdit({ ...edit, barcodes: bs }); }} /></td>
                <td><input className="in" type="number" min={1} value={b.packQty} onChange={(e) => { const bs = [...edit.barcodes]; bs[i] = { ...b, packQty: e.target.value }; setEdit({ ...edit, barcodes: bs }); }} /></td>
                <td><MoneyInput value={b.packPrice} onChange={(v) => { const bs = [...edit.barcodes]; bs[i] = { ...b, packPrice: v }; setEdit({ ...edit, barcodes: bs }); }} placeholder="ราคาปกติ × จำนวน" /></td>
                <td><button className="btn sm ghost" onClick={() => setEdit({ ...edit, barcodes: edit.barcodes.filter((_: any, j: number) => j !== i) })}>✕</button></td>
              </tr>
            ))}
          </tbody></table>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn sm" onClick={() => setEdit({ ...edit, barcodes: [...edit.barcodes, { barcode: '', packQty: 1, packPrice: null }] })}>+ เพิ่มบาร์โค้ด</button>
            <button className="btn sm" onClick={() => { const body = '29' + String(Date.now()).slice(-10); setEdit({ ...edit, barcodes: [...edit.barcodes, { barcode: body + gtinCheckDigit(body), packQty: 1, packPrice: null }] }); }}>สร้าง EAN-13 ภายในร้าน</button>
          </div>
          {edit.isWeighted && <p className="xs muted">สำหรับสินค้าชั่งน้ำหนัก: ใส่บาร์โค้ด PLU 7 หลัก (เช่น 2000101) เพื่อรองรับฉลากเครื่องชั่ง EAN-13 แบบฝังน้ำหนัก</p>}
        </Modal>
      )}
      {importRes && (
        <Modal title="ผลการนำเข้า" onClose={() => setImportRes(null)}>
          <p>สร้างใหม่ {importRes.created} · อัปเดต {importRes.updated} · ผิดพลาด {importRes.errors.length}</p>
          <table className="t"><tbody>{importRes.errors.map((e: any, i: number) => <tr key={i}><td>แถว {e.row}</td><td className="err">{e.error}</td></tr>)}</tbody></table>
          <p className="xs muted">คอลัมน์ที่รองรับ: sku, name, name_en, name_zh, category, brand, unit, price, cost, member_price, wholesale_price, wholesale_min_qty, is_weighted, min_stock, barcodes (คั่นด้วย |), stock, lot_no, expiry_date</p>
        </Modal>
      )}
    </div>
  );
}

function MetaList({ title, path, rows, reload, extra = [] }: { title: string; path: string; rows: any[]; reload: () => void; extra?: string[] }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [ex, setEx] = useState<Record<string, string>>({});
  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="grid" style={{ gap: 6 }}>
        <input className="in" placeholder="ชื่อ" value={name} onChange={(e) => setName(e.target.value)} />
        {extra.map((k) => <input key={k} className="in" placeholder={k} value={ex[k] ?? ''} onChange={(e) => setEx({ ...ex, [k]: e.target.value })} />)}
        <button className="btn sm primary" disabled={!name} onClick={async () => { try { await api(`/api/products/meta/${path}`, { body: { name, ...ex } }); setName(''); setEx({}); reload(); } catch (e) { toast(errMsg(e), 'err'); } }}>+ เพิ่ม</button>
      </div>
      <table className="t" style={{ marginTop: 8 }}><tbody>
        {rows.map((r) => <tr key={r.id}><td>{r.name}<div className="xs muted">{[r.name_en, r.name_zh].filter(Boolean).join(' · ')}</div></td><td className="right"><button className="btn sm ghost" onClick={async () => { try { await api(`/api/products/meta/${path}/${r.id}`, { method: 'DELETE' }); reload(); } catch (e) { toast(errMsg(e), 'err'); } }}>ลบ</button></td></tr>)}
      </tbody></table>
    </div>
  );
}

function Labels({ products }: { products: any[] }) {
  const [copies, setCopies] = useState(1);
  const [kind, setKind] = useState<'price' | 'barcode'>('price');
  const items = useMemo(() => products.flatMap((p) => Array.from({ length: copies }, () => p)), [products, copies]);
  if (!products.length) return <div className="card muted">เลือกสินค้าจากแท็บ “รายการสินค้า” ก่อน</div>;
  return (
    <div className="grid">
      <div className="row no-print">
        <select className="in" style={{ width: 200 }} value={kind} onChange={(e) => setKind(e.target.value as any)}><option value="price">ป้ายราคา (Shelf label)</option><option value="barcode">ฉลากบาร์โค้ด</option></select>
        <input className="in" style={{ width: 100 }} type="number" min={1} value={copies} onChange={(e) => setCopies(Math.max(1, Number(e.target.value)))} /> สำเนา/สินค้า
        <button className="btn primary" onClick={() => window.print()}>🖨️ พิมพ์ (50×30 มม.)</button>
      </div>
      <div className="print-area label-sheet">
        {items.map((p, i) => {
          const code = p.barcodes.find((b: any) => Number(b.packQty) === 1)?.barcode ?? p.sku;
          return (
            <div key={i} className="label">
              <div style={{ fontWeight: 700, lineHeight: 1.1 }}>{p.name}</div>
              {kind === 'price' && <div className="p">฿{(p.price / 100).toFixed(2)}{p.isWeighted ? '/กก.' : ''}</div>}
              {kind === 'price' && p.memberPrice != null && <div style={{ fontSize: '8pt' }}>สมาชิก ฿{(p.memberPrice / 100).toFixed(2)}</div>}
              <BarcodeSvg value={code} height={kind === 'price' ? 22 : 40} width={1.4} fontSize={10} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
