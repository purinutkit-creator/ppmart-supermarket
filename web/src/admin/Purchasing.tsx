import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApi, Modal, Field, MoneyInput, useToast, errMsg } from '../components/ui';
import { fmtMoney, fmtDate, fmtQty } from '../lib/format';
import { ProductPicker } from './Stock';

export default function Purchasing() {
  const toast = useToast();
  const [tab, setTab] = useState('orders');
  const { data: suppliers, reload: rsup } = useApi<any[]>('/api/purchasing/suppliers');
  const { data: branches } = useApi<any[]>('/api/admin/branches');
  const { data: orders, reload: ro } = useApi<any[]>(tab === 'orders' ? '/api/purchasing/orders' : null, [tab]);
  const { data: receipts } = useApi<any[]>(tab === 'receipts' ? '/api/purchasing/receipts' : null, [tab]);
  const { data: invoices, reload: ri } = useApi<any[]>(tab === 'invoices' ? '/api/purchasing/invoices' : null, [tab]);
  const { data: returns, reload: rr } = useApi<any[]>(tab === 'returns' ? '/api/purchasing/returns' : null, [tab]);
  const [po, setPo] = useState<any>(null);
  const [poView, setPoView] = useState<any>(null);
  const [recv, setRecv] = useState<any>(null);
  const [sup, setSup] = useState<any>(null);
  const [ret, setRet] = useState<any>(null);
  const [sugg, setSugg] = useState<any>({ branchId: null, supplierId: '', coverDays: 7, days: 30 });
  const { data: suggestions } = useApi<any[]>(tab === 'suggest' && (sugg.branchId || branches?.[0]) ? `/api/purchasing/suggestions?branchId=${sugg.branchId ?? branches?.[0]?.id}&supplierId=${sugg.supplierId}&coverDays=${sugg.coverDays}&days=${sugg.days}` : null, [tab, sugg, branches]);

  const openPo = async (id: number) => setPoView(await api(`/api/purchasing/orders/${id}`));
  const startReceive = (p: any) => setRecv({ poId: p.id, supplierId: p.supplier_id, branchId: p.branch_id, invoiceNo: '', invoiceAmount: null, dueDate: '', updateCost: true, items: p.items.filter((i: any) => Number(i.received_qty) < Number(i.qty)).map((i: any) => ({ poItemId: i.id, productId: i.product_id, name: i.name, ordered: Number(i.qty), received: Number(i.received_qty), qty: Number(i.qty) - Number(i.received_qty), unitCost: Number(i.unit_cost), lotNo: '', expiryDate: '' })) });

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>จัดซื้อและซัพพลายเออร์</h1>
        <div className="row"><button className="btn primary" onClick={() => setPo({ supplierId: suppliers?.[0]?.id, branchId: branches?.[0]?.id, expectedDate: '', note: '', status: 'ordered', items: [] })}>+ ใบสั่งซื้อ (PO)</button>
          <button className="btn" onClick={() => setRecv({ poId: null, supplierId: suppliers?.[0]?.id, branchId: branches?.[0]?.id, invoiceNo: '', invoiceAmount: null, dueDate: '', updateCost: true, items: [] })}>+ รับสินค้า (ไม่มี PO)</button></div>
      </div>
      <div className="tabs">{[['orders', 'ใบสั่งซื้อ'], ['receipts', 'รับสินค้า (GRN)'], ['invoices', 'ใบแจ้งหนี้ซัพพลายเออร์'], ['returns', 'คืนสินค้าซัพพลายเออร์'], ['suggest', '💡 แนะนำการสั่งซื้อ'], ['suppliers', 'ซัพพลายเออร์']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>

      {tab === 'orders' && <div className="table-wrap"><table className="t"><thead><tr><th>เลขที่</th><th>ซัพพลายเออร์</th><th>สาขา</th><th>กำหนดรับ</th><th className="right">ยอด</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>{(orders ?? []).map((o) => <tr key={o.id}><td className="mono small">{o.po_no}</td><td>{o.supplier_name}</td><td>{o.branch_name}</td><td className="small">{o.expected_date ?? '-'}</td><td className="right num">{fmtMoney(Number(o.total))}</td><td><span className={`badge ${o.status}`}>{o.status}</span></td><td className="right"><button className="btn sm" onClick={() => openPo(o.id)}>เปิด</button></td></tr>)}</tbody></table></div>}
      {tab === 'receipts' && <div className="table-wrap"><table className="t"><thead><tr><th>GRN</th><th>PO</th><th>ซัพพลายเออร์</th><th>สาขา</th><th>Invoice</th><th>รายการ</th><th className="right">ยอด</th><th>รับโดย</th><th>วันที่</th></tr></thead>
        <tbody>{(receipts ?? []).map((g) => <tr key={g.id}><td className="mono small">{g.grn_no}</td><td className="mono small">{g.po_no ?? '-'}</td><td>{g.supplier_name}</td><td>{g.branch_name}</td><td>{g.invoice_no}</td><td className="xs">{(g.items ?? []).map((i: any) => `${i.name} ×${fmtQty(Number(i.qty))}${i.lotNo ? ` [${i.lotNo}]` : ''}${i.expiryDate ? ` exp ${i.expiryDate}` : ''}`).join(', ')}</td><td className="right num">{fmtMoney(Number(g.total))}</td><td className="small">{g.received_by_name}</td><td className="small">{fmtDate(g.created_at)}</td></tr>)}</tbody></table></div>}
      {tab === 'invoices' && <div className="table-wrap"><table className="t"><thead><tr><th>Invoice</th><th>ซัพพลายเออร์</th><th>GRN</th><th className="right">ยอด</th><th>ครบกำหนด</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>{(invoices ?? []).map((i) => <tr key={i.id}><td>{i.invoice_no}</td><td>{i.supplier_name}</td><td className="mono small">{i.grn_no}</td><td className="right num">{fmtMoney(Number(i.amount))}</td><td className={`small ${i.status === 'unpaid' && i.due_date && new Date(i.due_date) < new Date() ? 'err' : ''}`}>{i.due_date ?? '-'}</td><td><span className={`badge ${i.status === 'paid' ? 'ok' : 'pending'}`}>{i.status}</span></td><td>{i.status === 'unpaid' && <button className="btn sm" onClick={async () => { await api(`/api/purchasing/invoices/${i.id}/pay`, { body: {} }); ri(); }}>บันทึกจ่ายแล้ว</button>}</td></tr>)}</tbody></table></div>}
      {tab === 'returns' && <>
        <div><button className="btn" onClick={() => setRet({ supplierId: suppliers?.[0]?.id, branchId: branches?.[0]?.id, reason: '', items: [] })}>+ คืนสินค้า</button></div>
        <div className="table-wrap"><table className="t"><thead><tr><th>เลขที่</th><th>ซัพพลายเออร์</th><th>สาขา</th><th>เหตุผล</th><th className="right">ยอด</th><th>วันที่</th></tr></thead>
          <tbody>{(returns ?? []).map((r) => <tr key={r.id}><td className="mono small">{r.return_no}</td><td>{r.supplier_name}</td><td>{r.branch_name}</td><td>{r.reason}</td><td className="right num">{fmtMoney(Number(r.total))}</td><td className="small">{fmtDate(r.created_at)}</td></tr>)}</tbody></table></div>
      </>}
      {tab === 'suggest' && (
        <div className="grid">
          <div className="card row">
            <Field label="สาขา"><select className="in" value={sugg.branchId ?? branches?.[0]?.id ?? ''} onChange={(e) => setSugg({ ...sugg, branchId: Number(e.target.value) })}>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <Field label="ซัพพลายเออร์ (Lead time)"><select className="in" value={sugg.supplierId} onChange={(e) => setSugg({ ...sugg, supplierId: e.target.value })}><option value="">ทั่วไป (3 วัน)</option>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.lead_time_days} วัน)</option>)}</select></Field>
            <Field label="ยอดขายย้อนหลัง (วัน)"><input className="in" type="number" value={sugg.days} onChange={(e) => setSugg({ ...sugg, days: Number(e.target.value) })} /></Field>
            <Field label="สำรองขายได้ (วัน)"><input className="in" type="number" value={sugg.coverDays} onChange={(e) => setSugg({ ...sugg, coverDays: Number(e.target.value) })} /></Field>
            <button className="btn primary" style={{ alignSelf: 'end' }} disabled={!suggestions?.length} onClick={() => setPo({ supplierId: sugg.supplierId ? Number(sugg.supplierId) : suppliers?.[0]?.id, branchId: sugg.branchId ?? branches?.[0]?.id, expectedDate: '', note: 'สร้างจากระบบแนะนำการสั่งซื้อ', status: 'draft', items: suggestions!.map((s) => ({ productId: s.product_id, name: s.name, qty: s.suggestedQty, unitCost: Number(s.last_cost) })) })}>สร้าง PO จากคำแนะนำ</button>
          </div>
          <div className="table-wrap"><table className="t"><thead><tr><th>สินค้า</th><th className="right">คงเหลือ</th><th className="right">ค้างรับ</th><th className="right">ขายเฉลี่ย/วัน</th><th className="right">ขั้นต่ำ</th><th className="right">เป้าหมาย</th><th className="right">แนะนำสั่ง</th><th className="right">ต้นทุนล่าสุด</th></tr></thead>
            <tbody>{(suggestions ?? []).map((s) => <tr key={s.product_id}><td>{s.name}</td><td className="right num">{fmtQty(Number(s.on_hand))}</td><td className="right num">{fmtQty(Number(s.on_order))}</td><td className="right num">{Number(s.avg_daily).toFixed(2)}</td><td className="right num">{fmtQty(Number(s.min_stock))}</td><td className="right num">{s.target}</td><td className="right num"><b>{s.suggestedQty}</b></td><td className="right num">{fmtMoney(Number(s.last_cost))}</td></tr>)}</tbody></table></div>
          <p className="xs muted">สูตร: ขายเฉลี่ยต่อวัน × (Lead time + วันสำรอง) + สต็อกขั้นต่ำ − คงเหลือ − ค้างรับจาก PO</p>
        </div>
      )}
      {tab === 'suppliers' && <>
        <div><button className="btn" onClick={() => setSup({ code: '', name: '', contactName: '', phone: '', email: '', address: '', taxId: '', leadTimeDays: 3, paymentTermsDays: 30, isActive: true })}>+ ซัพพลายเออร์</button></div>
        <div className="table-wrap"><table className="t"><thead><tr><th>รหัส</th><th>ชื่อ</th><th>ผู้ติดต่อ</th><th>โทร</th><th>Lead time</th><th>เครดิต</th><th></th></tr></thead>
          <tbody>{(suppliers ?? []).map((s) => <tr key={s.id}><td className="mono">{s.code}</td><td>{s.name}</td><td>{s.contact_name}</td><td>{s.phone}</td><td>{s.lead_time_days} วัน</td><td>{s.payment_terms_days} วัน</td><td><button className="btn sm" onClick={() => setSup({ id: s.id, code: s.code, name: s.name, contactName: s.contact_name, phone: s.phone, email: s.email, address: s.address, taxId: s.tax_id, leadTimeDays: s.lead_time_days, paymentTermsDays: s.payment_terms_days, isActive: s.is_active })}>แก้ไข</button></td></tr>)}</tbody></table></div>
      </>}

      {po && (
        <Modal title="ใบสั่งซื้อ (Purchase Order)" onClose={() => setPo(null)} width={820} footer={<button className="btn primary" disabled={!po.items.length} onClick={async () => { try { await api('/api/purchasing/orders', { body: { ...po, items: po.items.map((i: any) => ({ productId: i.productId, qty: Number(i.qty), unitCost: Number(i.unitCost) })) } }); toast('สร้าง PO แล้ว', 'ok'); setPo(null); setTab('orders'); ro(); } catch (e) { toast(errMsg(e), 'err'); } }}>บันทึก PO</button>}>
          <div className="grid g4">
            <Field label="ซัพพลายเออร์"><select className="in" value={po.supplierId} onChange={(e) => setPo({ ...po, supplierId: Number(e.target.value) })}>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="สาขาที่รับ"><select className="in" value={po.branchId} onChange={(e) => setPo({ ...po, branchId: Number(e.target.value) })}>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <Field label="กำหนดรับ"><input className="in" type="date" value={po.expectedDate} onChange={(e) => setPo({ ...po, expectedDate: e.target.value })} /></Field>
            <Field label="สถานะ"><select className="in" value={po.status} onChange={(e) => setPo({ ...po, status: e.target.value })}><option value="draft">ร่าง</option><option value="ordered">สั่งซื้อแล้ว</option></select></Field>
          </div>
          <div style={{ margin: '10px 0' }}><ProductPicker onPick={(p) => setPo({ ...po, items: [...po.items, { productId: p.id, name: p.name, qty: 1, unitCost: p.cost ?? 0 }] })} /></div>
          <table className="t"><thead><tr><th>สินค้า</th><th>จำนวน</th><th>ต้นทุน/หน่วย</th><th className="right">รวม</th><th></th></tr></thead><tbody>
            {po.items.map((i: any, k: number) => <tr key={k}><td>{i.name}</td><td><input className="in" type="number" value={i.qty} onChange={(e) => { const it = [...po.items]; it[k] = { ...i, qty: e.target.value }; setPo({ ...po, items: it }); }} /></td><td><MoneyInput value={i.unitCost} onChange={(v) => { const it = [...po.items]; it[k] = { ...i, unitCost: v ?? 0 }; setPo({ ...po, items: it }); }} /></td><td className="right num">{fmtMoney(Math.round(Number(i.qty) * i.unitCost))}</td><td><button className="btn sm ghost" onClick={() => setPo({ ...po, items: po.items.filter((_: any, j: number) => j !== k) })}>✕</button></td></tr>)}
          </tbody></table>
          <div className="right" style={{ marginTop: 8 }}><b>รวม {fmtMoney(po.items.reduce((a: number, i: any) => a + Math.round(Number(i.qty) * i.unitCost), 0))}</b></div>
        </Modal>
      )}
      {poView && (
        <Modal title={`PO ${poView.po_no}`} onClose={() => setPoView(null)} width={820}
          footer={<>{poView.status === 'draft' && <button className="btn" onClick={async () => { await api(`/api/purchasing/orders/${poView.id}/status`, { body: { status: 'ordered' } }); openPo(poView.id); ro(); }}>ยืนยันสั่งซื้อ</button>}
            {['draft', 'ordered'].includes(poView.status) && <button className="btn danger" onClick={async () => { await api(`/api/purchasing/orders/${poView.id}/status`, { body: { status: 'cancelled' } }); setPoView(null); ro(); }}>ยกเลิก PO</button>}
            {['ordered', 'partial', 'draft'].includes(poView.status) && <button className="btn primary" onClick={() => { startReceive(poView); setPoView(null); }}>รับสินค้า</button>}</>}>
          <p>{poView.supplier_name} → {poView.branch_name} · <span className={`badge ${poView.status}`}>{poView.status}</span></p>
          <table className="t"><thead><tr><th>สินค้า</th><th className="right">สั่ง</th><th className="right">รับแล้ว</th><th className="right">ต้นทุน PO</th><th className="right">ต้นทุนปัจจุบัน</th></tr></thead><tbody>
            {poView.items.map((i: any) => <tr key={i.id}><td>{i.name}</td><td className="right">{fmtQty(Number(i.qty))}</td><td className={`right ${Number(i.received_qty) >= Number(i.qty) ? 'ok' : ''}`}>{fmtQty(Number(i.received_qty))}</td><td className="right num">{fmtMoney(Number(i.unit_cost))}</td><td className="right num">{fmtMoney(Number(i.current_cost))}</td></tr>)}
          </tbody></table>
        </Modal>
      )}
      {recv && (
        <Modal title="รับสินค้า (Goods Receiving)" onClose={() => setRecv(null)} width={980} footer={<button className="btn primary" disabled={!recv.items.some((i: any) => Number(i.qty) > 0)} onClick={async () => {
          try {
            const r = await api('/api/purchasing/receipts', { body: { poId: recv.poId, supplierId: recv.supplierId, branchId: recv.branchId, invoiceNo: recv.invoiceNo || null, updateCost: recv.updateCost, invoice: recv.invoiceNo && recv.invoiceAmount ? { amount: recv.invoiceAmount, dueDate: recv.dueDate || null } : undefined, items: recv.items.filter((i: any) => Number(i.qty) > 0).map((i: any) => ({ poItemId: i.poItemId ?? null, productId: i.productId, qty: Number(i.qty), unitCost: i.unitCost, lotNo: i.lotNo || null, expiryDate: i.expiryDate || null })) } });
            toast(`รับสินค้าแล้ว ${r.grnNo}${r.costWarnings.length ? `\n⚠ ต้นทุนไม่ตรง PO ${r.costWarnings.length} รายการ` : ''}`, r.costWarnings.length ? 'warn' : 'ok'); setRecv(null); ro();
          } catch (e) { toast(errMsg(e), 'err'); }
        }}>ยืนยันรับสินค้าเข้าสต็อก</button>}>
          <div className="grid g4">
            {!recv.poId && <Field label="ซัพพลายเออร์"><select className="in" value={recv.supplierId} onChange={(e) => setRecv({ ...recv, supplierId: Number(e.target.value) })}>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
            {!recv.poId && <Field label="สาขา"><select className="in" value={recv.branchId} onChange={(e) => setRecv({ ...recv, branchId: Number(e.target.value) })}>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
            <Field label="เลขที่ใบแจ้งหนี้/ใบส่งของ"><input className="in" value={recv.invoiceNo} onChange={(e) => setRecv({ ...recv, invoiceNo: e.target.value })} /></Field>
            <Field label="ยอดตาม Invoice"><MoneyInput value={recv.invoiceAmount} onChange={(v) => setRecv({ ...recv, invoiceAmount: v })} /></Field>
            <Field label="ครบกำหนดชำระ"><input className="in" type="date" value={recv.dueDate} onChange={(e) => setRecv({ ...recv, dueDate: e.target.value })} /></Field>
            <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={recv.updateCost} onChange={(e) => setRecv({ ...recv, updateCost: e.target.checked })} /> อัปเดตต้นทุนเฉลี่ย</label>
          </div>
          {!recv.poId && <div style={{ margin: '10px 0' }}><ProductPicker onPick={(p) => setRecv({ ...recv, items: [...recv.items, { productId: p.id, name: p.name, qty: 1, unitCost: p.cost ?? 0, lotNo: '', expiryDate: '' }] })} /></div>}
          <table className="t"><thead><tr><th>สินค้า</th>{recv.poId && <th className="right">สั่ง/รับแล้ว</th>}<th>รับครั้งนี้</th><th>ต้นทุน/หน่วย</th><th>เลขล็อต</th><th>วันหมดอายุ</th></tr></thead><tbody>
            {recv.items.map((i: any, k: number) => {
              const up = (patch: any) => { const it = [...recv.items]; it[k] = { ...i, ...patch }; setRecv({ ...recv, items: it }); };
              return <tr key={k}><td>{i.name}</td>{recv.poId && <td className="right small">{fmtQty(i.ordered)} / {fmtQty(i.received)}</td>}<td><input className="in" type="number" style={{ width: 90 }} value={i.qty} onChange={(e) => up({ qty: e.target.value })} /></td><td><MoneyInput value={i.unitCost} onChange={(v) => up({ unitCost: v ?? 0 })} /></td><td><input className="in" value={i.lotNo} onChange={(e) => up({ lotNo: e.target.value })} /></td><td><input className="in" type="date" value={i.expiryDate} onChange={(e) => up({ expiryDate: e.target.value })} /></td></tr>;
            })}
          </tbody></table>
        </Modal>
      )}
      {sup && (
        <Modal title="ซัพพลายเออร์" onClose={() => setSup(null)} width={640} footer={<button className="btn primary" onClick={async () => { try { if (sup.id) await api(`/api/purchasing/suppliers/${sup.id}`, { method: 'PUT', body: sup }); else await api('/api/purchasing/suppliers', { body: sup }); setSup(null); rsup(); } catch (e) { toast(errMsg(e), 'err'); } }}>บันทึก</button>}>
          <div className="grid g2">{[['code', 'รหัส'], ['name', 'ชื่อ'], ['contactName', 'ผู้ติดต่อ'], ['phone', 'โทร'], ['email', 'อีเมล'], ['taxId', 'เลขผู้เสียภาษี'], ['address', 'ที่อยู่']].map(([k, l]) => <Field key={k} label={l}><input className="in" value={sup[k] ?? ''} onChange={(e) => setSup({ ...sup, [k]: e.target.value })} /></Field>)}
            <Field label="Lead time (วัน)"><input className="in" type="number" value={sup.leadTimeDays} onChange={(e) => setSup({ ...sup, leadTimeDays: Number(e.target.value) })} /></Field>
            <Field label="เครดิต (วัน)"><input className="in" type="number" value={sup.paymentTermsDays} onChange={(e) => setSup({ ...sup, paymentTermsDays: Number(e.target.value) })} /></Field></div>
        </Modal>
      )}
      {ret && (
        <Modal title="คืนสินค้าให้ซัพพลายเออร์ (Purchase Return)" onClose={() => setRet(null)} width={760} footer={<button className="btn primary" disabled={!ret.items.length || ret.reason.length < 2} onClick={async () => { try { await api('/api/purchasing/returns', { body: { ...ret, items: ret.items.map((i: any) => ({ productId: i.productId, qty: Number(i.qty), unitCost: i.unitCost })) } }); toast('บันทึกการคืนและตัดสต็อกแล้ว', 'ok'); setRet(null); rr(); } catch (e) { toast(errMsg(e), 'err'); } }}>บันทึก</button>}>
          <div className="grid g3">
            <Field label="ซัพพลายเออร์"><select className="in" value={ret.supplierId} onChange={(e) => setRet({ ...ret, supplierId: Number(e.target.value) })}>{suppliers?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="สาขา"><select className="in" value={ret.branchId} onChange={(e) => setRet({ ...ret, branchId: Number(e.target.value) })}>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <Field label="เหตุผล"><input className="in" value={ret.reason} onChange={(e) => setRet({ ...ret, reason: e.target.value })} /></Field>
          </div>
          <div style={{ margin: '10px 0' }}><ProductPicker onPick={(p) => setRet({ ...ret, items: [...ret.items, { productId: p.id, name: p.name, qty: 1, unitCost: p.cost ?? 0 }] })} /></div>
          <table className="t"><tbody>{ret.items.map((i: any, k: number) => <tr key={k}><td>{i.name}</td><td><input className="in" type="number" value={i.qty} onChange={(e) => { const it = [...ret.items]; it[k] = { ...i, qty: e.target.value }; setRet({ ...ret, items: it }); }} /></td><td className="right num">{fmtMoney(i.unitCost)}</td></tr>)}</tbody></table>
        </Modal>
      )}
    </div>
  );
}

export function useInterval(fn: () => void, ms: number) { useEffect(() => { const i = setInterval(fn, ms); return () => clearInterval(i); }, [fn, ms]); }
