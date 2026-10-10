import { useEffect, useState } from 'react';
import { api, can } from '../lib/api';
import { useApi, Modal, Field, useToast, errMsg, Empty } from '../components/ui';
import { fmtDate, fmtQty } from '../lib/format';
import { ExportBar } from '../components/ExportBar';

export default function Stock() {
  const toast = useToast();
  const { data: branches } = useApi<any[]>('/api/admin/branches');
  const [branchId, setBranchId] = useState<number | null>(null);
  useEffect(() => { if (!branchId && branches?.length) setBranchId(branches[0].id); }, [branches, branchId]);
  const [tab, setTab] = useState('levels');
  const { data: levels, reload: rl } = useApi<any[]>(branchId ? `/api/stock/levels?branchId=${branchId}` : null, [branchId]);
  const { data: low } = useApi<any[]>(tab === 'low' ? `/api/stock/low?branchId=${branchId ?? ''}` : null, [tab, branchId]);
  const [days, setDays] = useState(30);
  const { data: expiring } = useApi<any[]>(tab === 'expiring' ? `/api/stock/expiring?days=${days}&branchId=${branchId ?? ''}` : null, [tab, days, branchId]);
  const [mvType, setMvType] = useState('');
  const [mvProduct, setMvProduct] = useState<number | null>(null);
  const { data: moves, reload: rm } = useApi<any[]>(tab === 'moves' ? `/api/stock/movements?branchId=${branchId ?? ''}&type=${mvType}${mvProduct ? `&productId=${mvProduct}` : ''}` : null, [tab, branchId, mvType, mvProduct]);
  const [adjust, setAdjust] = useState<any>(null);
  const [q, setQ] = useState('');
  const filtered = (levels ?? []).filter((l) => !q || l.name.toLowerCase().includes(q.toLowerCase()) || l.sku.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>สต็อกสินค้า</h1>
        <select className="in" style={{ width: 220 }} value={branchId ?? ''} onChange={(e) => setBranchId(Number(e.target.value))}>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      </div>
      <div className="tabs">
        {[['levels', 'คงเหลือ'], ['low', 'ต่ำกว่าขั้นต่ำ'], ['expiring', 'ใกล้หมดอายุ'], ['moves', 'Stock Movement'], ['transfers', 'โอนระหว่างสาขา'], ['counts', 'ตรวจนับสต็อก']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'levels' && (
        <>
          <div className="row between"><input className="in" style={{ maxWidth: 320 }} placeholder="ค้นหา" value={q} onChange={(e) => setQ(e.target.value)} />
            <ExportBar rows={filtered} name="stock-levels" cols={[{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'สินค้า' }, { key: 'qty', label: 'คงเหลือ' }, { key: 'min_stock', label: 'ขั้นต่ำ' }, { key: 'next_expiry', label: 'หมดอายุถัดไป' }]} /></div>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>SKU</th><th>สินค้า</th><th className="right">คงเหลือ</th><th className="right">ขั้นต่ำ</th><th>หมดอายุถัดไป</th><th></th></tr></thead>
            <tbody>{filtered.map((l) => (
              <tr key={l.product_id}><td className="mono small">{l.sku}</td><td>{l.name}</td><td className={`right num ${Number(l.qty) <= Number(l.min_stock) ? 'err' : ''}`}>{fmtQty(Number(l.qty))} {l.unit_name}</td><td className="right num">{fmtQty(Number(l.min_stock))}</td><td className="small">{l.next_expiry ?? '-'}</td>
                <td className="right"><button className="btn sm" onClick={() => { setMvProduct(l.product_id); setTab('moves'); }}>ประวัติ</button>{can('stock.adjust') && <button className="btn sm" onClick={() => setAdjust({ productId: l.product_id, name: l.name, qty: '', reason: '', lotNo: '', expiryDate: '' })}>ปรับยอด</button>}</td></tr>
            ))}</tbody></table></div>
        </>
      )}
      {tab === 'low' && (
        <div className="table-wrap"><table className="t"><thead><tr><th>สินค้า</th><th>สาขา</th><th className="right">คงเหลือ</th><th className="right">ขั้นต่ำ</th></tr></thead>
          <tbody>{(low ?? []).map((l, i) => <tr key={i}><td>{l.name}</td><td>{l.branch_name}</td><td className="right err num">{fmtQty(Number(l.qty))}</td><td className="right num">{fmtQty(Number(l.min_stock))}</td></tr>)}</tbody></table>{!low?.length && <Empty />}</div>
      )}
      {tab === 'expiring' && (
        <>
          <div className="row">ภายใน <input className="in" style={{ width: 90 }} type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} /> วัน</div>
          <div className="table-wrap"><table className="t"><thead><tr><th>สินค้า</th><th>สาขา</th><th>ล็อต</th><th>วันหมดอายุ</th><th className="right">เหลือ (วัน)</th><th className="right">จำนวน</th></tr></thead>
            <tbody>{(expiring ?? []).map((l) => <tr key={l.id}><td>{l.name}</td><td>{l.branch_name}</td><td className="mono small">{l.lot_no}</td><td>{l.expiry_date}</td><td className={`right ${l.days_left <= 3 ? 'err' : 'warn-t'}`}>{l.days_left}</td><td className="right num">{fmtQty(Number(l.qty))}</td></tr>)}</tbody></table>{!expiring?.length && <Empty />}</div>
        </>
      )}
      {tab === 'moves' && (
        <>
          <div className="row">
            <select className="in" style={{ width: 200 }} value={mvType} onChange={(e) => setMvType(e.target.value)}><option value="">ทุกประเภท</option>{['sale', 'refund', 'void', 'receive', 'adjust', 'count', 'transfer_out', 'transfer_in', 'purchase_return'].map((t) => <option key={t}>{t}</option>)}</select>
            {mvProduct && <button className="btn sm" onClick={() => setMvProduct(null)}>ล้างตัวกรองสินค้า ✕</button>}
            <button className="btn sm" onClick={rm}>รีเฟรช</button>
          </div>
          <div className="table-wrap"><table className="t"><thead><tr><th>เวลา</th><th>สินค้า</th><th>ประเภท</th><th className="right">จำนวน</th><th className="right">คงเหลือหลังทำรายการ</th><th>ล็อต / หมดอายุ</th><th>อ้างอิง</th><th>เหตุผล</th><th>ผู้ทำรายการ</th></tr></thead>
            <tbody>{(moves ?? []).map((m) => <tr key={m.id}><td className="small">{fmtDate(m.created_at)}</td><td>{m.name}</td><td><span className="badge">{m.type}</span></td><td className={`right num ${Number(m.qty) < 0 ? 'err' : 'ok'}`}>{Number(m.qty) > 0 ? '+' : ''}{fmtQty(Number(m.qty))}</td><td className="right num">{fmtQty(Number(m.balance_after))}</td><td className="small">{m.lot_no ?? ''} {m.expiry_date ?? ''}</td><td className="small mono">{m.ref_type} {m.ref_id}</td><td className="small">{m.reason}</td><td className="small">{m.staff_name}</td></tr>)}</tbody></table></div>
        </>
      )}
      {tab === 'transfers' && branches && <Transfers branches={branches} />}
      {tab === 'counts' && branchId && <Counts branchId={branchId} levels={levels ?? []} />}
      {adjust && (
        <Modal title={`ปรับยอดสต็อก: ${adjust.name}`} onClose={() => setAdjust(null)} width={480}
          footer={<button className="btn primary" onClick={async () => { try { await api('/api/stock/adjust', { body: { branchId, productId: adjust.productId, qty: Number(adjust.qty), reason: adjust.reason, lotNo: adjust.lotNo || undefined, expiryDate: adjust.expiryDate || undefined } }); toast('ปรับยอดแล้ว', 'ok'); setAdjust(null); rl(); } catch (e) { toast(errMsg(e), 'err'); } }}>บันทึก</button>}>
          <div className="grid">
            <Field label="จำนวน (+ เพิ่ม / − ลด)"><input className="in" type="number" value={adjust.qty} onChange={(e) => setAdjust({ ...adjust, qty: e.target.value })} /></Field>
            <Field label="เหตุผล (จำเป็น)"><select className="in" value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })}><option value="">-- เลือก --</option>{['สินค้าชำรุด', 'สินค้าหมดอายุ', 'สูญหาย', 'ใช้ภายในร้าน', 'ยอดยกมา', 'ปรับยอดผิดพลาด'].map((r) => <option key={r}>{r}</option>)}</select></Field>
            {Number(adjust.qty) > 0 && <div className="grid g2"><Field label="เลขล็อต"><input className="in" value={adjust.lotNo} onChange={(e) => setAdjust({ ...adjust, lotNo: e.target.value })} /></Field><Field label="วันหมดอายุ"><input className="in" type="date" value={adjust.expiryDate} onChange={(e) => setAdjust({ ...adjust, expiryDate: e.target.value })} /></Field></div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ProductPicker({ onPick }: { onPick: (p: any) => void }) {
  const [q, setQ] = useState('');
  const { data } = useApi<any[]>(q.length >= 2 ? `/api/products?q=${encodeURIComponent(q)}` : null, [q]);
  return (
    <div style={{ position: 'relative' }}>
      <input className="in" placeholder="ค้นหาสินค้าเพื่อเพิ่ม (ชื่อ/SKU/บาร์โค้ด)" value={q} onChange={(e) => setQ(e.target.value)} />
      {data && q.length >= 2 && (
        <div className="card" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, maxHeight: 260, overflow: 'auto', padding: 4 }}>
          {data.slice(0, 20).map((p) => <div key={p.id} style={{ padding: 6, cursor: 'pointer' }} onClick={() => { onPick(p); setQ(''); }}>{p.name} <span className="xs muted mono">{p.sku}</span></div>)}
        </div>
      )}
    </div>
  );
}
export { ProductPicker };

function Transfers({ branches }: { branches: any[] }) {
  const toast = useToast();
  const { data, reload } = useApi<any[]>('/api/stock/transfers');
  const [form, setForm] = useState<any>(null);
  return (
    <div className="grid">
      <div><button className="btn primary" onClick={() => setForm({ fromBranchId: branches[0]?.id, toBranchId: branches[1]?.id, note: '', items: [] })}>+ สร้างใบโอน</button></div>
      <div className="table-wrap"><table className="t"><thead><tr><th>เลขที่</th><th>จาก → ไป</th><th>รายการ</th><th>สถานะ</th><th>วันที่</th><th></th></tr></thead>
        <tbody>{(data ?? []).map((t) => <tr key={t.id}><td className="mono small">{t.transfer_no}</td><td>{t.from_name} → {t.to_name}</td><td className="small">{(t.items ?? []).map((i: any) => `${i.name} ×${fmtQty(Number(i.qty))}${i.receivedQty != null ? ` (รับ ${fmtQty(Number(i.receivedQty))})` : ''}`).join(', ')}</td><td><span className={`badge ${t.status}`}>{t.status}</span></td><td className="small">{fmtDate(t.created_at)}</td>
          <td>{t.status === 'in_transit' && <button className="btn sm primary" onClick={async () => { try { await api(`/api/stock/transfers/${t.id}/receive`, { body: {} }); toast('รับสินค้าเข้าสาขาปลายทางแล้ว', 'ok'); reload(); } catch (e) { toast(errMsg(e), 'err'); } }}>รับสินค้า</button>}</td></tr>)}</tbody></table></div>
      {form && (
        <Modal title="โอนสินค้าระหว่างสาขา" onClose={() => setForm(null)} width={640} footer={<button className="btn primary" disabled={!form.items.length} onClick={async () => { try { await api('/api/stock/transfers', { body: { ...form, items: form.items.map((i: any) => ({ productId: i.productId, qty: Number(i.qty) })) } }); toast('สร้างใบโอนแล้ว (ตัดสต็อกสาขาต้นทาง)', 'ok'); setForm(null); reload(); } catch (e) { toast(errMsg(e), 'err'); } }}>ยืนยันโอน</button>}>
          <div className="grid g2">
            <Field label="จากสาขา"><select className="in" value={form.fromBranchId} onChange={(e) => setForm({ ...form, fromBranchId: Number(e.target.value) })}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <Field label="ไปสาขา"><select className="in" value={form.toBranchId} onChange={(e) => setForm({ ...form, toBranchId: Number(e.target.value) })}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          </div>
          <div style={{ margin: '10px 0' }}><ProductPicker onPick={(p) => setForm({ ...form, items: [...form.items, { productId: p.id, name: p.name, qty: 1 }] })} /></div>
          <table className="t"><tbody>{form.items.map((i: any, k: number) => <tr key={k}><td>{i.name}</td><td><input className="in" type="number" value={i.qty} onChange={(e) => { const it = [...form.items]; it[k] = { ...i, qty: e.target.value }; setForm({ ...form, items: it }); }} /></td><td><button className="btn sm ghost" onClick={() => setForm({ ...form, items: form.items.filter((_: any, j: number) => j !== k) })}>✕</button></td></tr>)}</tbody></table>
          <Field label="หมายเหตุ"><input className="in" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        </Modal>
      )}
    </div>
  );
}

function Counts({ branchId, levels }: { branchId: number; levels: any[] }) {
  const toast = useToast();
  const { data, reload } = useApi<any[]>('/api/stock/counts');
  const [open, setOpen] = useState<any>(null);
  const loadOne = async (id: number) => setOpen(await api(`/api/stock/counts/${id}`));
  const [reason, setReason] = useState('');
  return (
    <div className="grid">
      <div><button className="btn primary" onClick={async () => { const c = await api('/api/stock/counts', { body: { branchId, note: 'ตรวจนับ ' + new Date().toLocaleDateString('th-TH') } }); reload(); loadOne(c.id); }}>+ เริ่มตรวจนับ</button></div>
      <table className="t"><tbody>{(data ?? []).map((c) => <tr key={c.id}><td>#{c.id} {c.note}</td><td>{c.branch_name}</td><td>{c.lines} รายการ</td><td><span className={`badge ${c.status}`}>{c.status}</span></td><td className="small">{fmtDate(c.created_at)}</td><td><button className="btn sm" onClick={() => loadOne(c.id)}>เปิด</button></td></tr>)}</tbody></table>
      {open && (
        <Modal title={`ใบตรวจนับ #${open.id}`} onClose={() => setOpen(null)} width={760}
          footer={open.status === 'open' ? <><input className="in" style={{ maxWidth: 300 }} placeholder="เหตุผลการปรับยอด" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="btn primary" onClick={async () => { try { const r = await api(`/api/stock/counts/${open.id}/apply`, { body: { reason } }); toast(`ปรับยอดแล้ว ${r.adjusted} รายการ`, 'ok'); setOpen(null); reload(); } catch (e) { toast(errMsg(e), 'err'); } }}>ยืนยันปรับยอดตามผลนับ</button></> : undefined}>
          {open.status === 'open' && <div style={{ marginBottom: 8 }}><ProductPicker onPick={async (p) => { const qty = prompt(`นับได้ ${p.name}`); if (qty == null) return; await api(`/api/stock/counts/${open.id}/items`, { body: { productId: p.id, countedQty: Number(qty) } }); loadOne(open.id); }} /><p className="xs muted">หรือกรอกจากรายการด้านล่าง ({levels.length} สินค้า)</p></div>}
          <table className="t"><thead><tr><th>สินค้า</th><th className="right">ในระบบ</th><th className="right">นับได้</th><th className="right">ส่วนต่าง</th></tr></thead><tbody>
            {open.items.map((i: any) => { const sys = open.status === 'open' ? Number(i.current_qty) : Number(i.system_qty); const d = Number(i.counted_qty) - sys; return <tr key={i.id}><td>{i.name}</td><td className="right num">{fmtQty(sys)}</td><td className="right num">{fmtQty(Number(i.counted_qty))}</td><td className={`right num ${d ? 'err' : 'ok'}`}>{d > 0 ? '+' : ''}{fmtQty(d)}</td></tr>; })}
          </tbody></table>
        </Modal>
      )}
    </div>
  );
}
