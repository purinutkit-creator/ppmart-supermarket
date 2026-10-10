import { useState } from 'react';
import { api } from '../lib/api';
import { useApi, Modal, Field, MoneyInput, useToast, errMsg, BarcodeSvg } from '../components/ui';
import { fmtMoney, fmtDate } from '../lib/format';
import { useBarcodeScanner } from '../lib/scanner';
import { ExportBar } from '../components/ExportBar';

const STATUSES = ['ACTIVE', 'RESERVED', 'USED', 'EXPIRED', 'CANCELLED', 'VOID', 'PENDING_REVIEW'];

export default function Coupons() {
  const toast = useToast();
  const [tab, setTab] = useState<'coupons' | 'gift' | 'policy'>('coupons');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [promoId, setPromoId] = useState('');
  const { data: stats, reload: rs } = useApi<any>(`/api/marketing/coupons/stats?promotionId=${promoId}`, [promoId]);
  const { data: list, reload } = useApi<any[]>(`/api/marketing/coupons?q=${encodeURIComponent(q)}&status=${status}&promotionId=${promoId}`, [q, status, promoId]);
  const { data: promos } = useApi<any[]>('/api/marketing/promotions');
  const [sel, setSel] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [issue, setIssue] = useState<any>(null);
  useBarcodeScanner((c) => { setTab('coupons'); setQ(c); });

  const open = async (c: any) => { setSel(c); setEvents(await api(`/api/marketing/coupons/${c.id}/events`)); };
  const act = async (action: string) => {
    const reason = prompt('เหตุผล (บันทึกใน Audit Log)');
    if (!reason) return;
    let expiresAt: string | undefined;
    if (action === 'extend' || (action === 'reactivate' && new Date(sel.expiresAt) < new Date())) { const d = prompt('วันหมดอายุใหม่ (YYYY-MM-DD)'); if (!d) return; expiresAt = new Date(d + 'T23:59:59').toISOString(); }
    try { await api(`/api/marketing/coupons/${sel.id}/status`, { body: { action, reason, expiresAt } }); toast('อัปเดตแล้ว', 'ok'); setSel(null); reload(); rs(); } catch (e) { toast(errMsg(e), 'err'); }
  };

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>Marketing → Receipt Coupon</h1><button className="btn primary" onClick={() => setIssue({ promotionId: promos?.find((p) => p.type === 'receipt_coupon')?.id, count: 1, reason: '' })}>+ ออกคูปองด้วยตนเอง</button></div>
      <div className="tabs">
        <button className={tab === 'coupons' ? 'on' : ''} onClick={() => setTab('coupons')}>คูปอง</button>
        <button className={tab === 'gift' ? 'on' : ''} onClick={() => setTab('gift')}>บัตรของขวัญ</button>
        <button className={tab === 'policy' ? 'on' : ''} onClick={() => setTab('policy')}>นโยบายคืนเงิน/การออกคูปอง</button>
      </div>
      {tab === 'coupons' && (
        <>
          {stats && (
            <div className="grid g4">
              <div className="card kpi"><div className="l">Issued</div><div className="v">{stats.issued.toLocaleString()}</div></div>
              <div className="card kpi"><div className="l">Redeemed</div><div className="v ok">{stats.redeemed.toLocaleString()}</div><div className="xs muted">Redemption Rate {(stats.redemptionRate * 100).toFixed(1)}%</div></div>
              <div className="card kpi"><div className="l">Active</div><div className="v">{stats.active.toLocaleString()}</div><div className="xs muted">Reserved {stats.reserved} · Review {stats.pending_review}</div></div>
              <div className="card kpi"><div className="l">Expired</div><div className="v">{stats.expired.toLocaleString()}</div><div className="xs muted">Cancelled/Void {stats.cancelled}</div></div>
              <div className="card kpi" style={{ gridColumn: 'span 2' }}><div className="l">มูลค่าส่วนลดที่ถูกใช้</div><div className="v">{fmtMoney(Number(stats.discount_used))}</div></div>
              <div className="card" style={{ gridColumn: 'span 2' }}>
                <table className="t"><thead><tr><th>โปรโมชั่น</th><th className="right">ออก</th><th className="right">ใช้</th><th className="right">Rate</th><th className="right">ส่วนลด</th><th className="right">ยอดขายที่ใช้คูปอง</th></tr></thead>
                  <tbody>{stats.byPromotion.map((p: any) => <tr key={p.id}><td className="small">{p.name}</td><td className="right">{p.issued}</td><td className="right">{p.redeemed}</td><td className="right">{p.issued ? ((p.redeemed / p.issued) * 100).toFixed(0) : 0}%</td><td className="right num">{fmtMoney(Number(p.discount_used))}</td><td className="right num">{fmtMoney(Number(p.redeemed_sales))}</td></tr>)}</tbody></table>
              </div>
            </div>
          )}
          <div className="row between">
            <div className="row">
              <input className="in" style={{ width: 280 }} placeholder="ค้นหา/สแกน Coupon Code หรือ Barcode" value={q} onChange={(e) => setQ(e.target.value)} />
              <select className="in" style={{ width: 170 }} value={status} onChange={(e) => setStatus(e.target.value)}><option value="">ทุกสถานะ</option>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
              <select className="in" style={{ width: 240 }} value={promoId} onChange={(e) => setPromoId(e.target.value)}><option value="">ทุกโปรโมชั่น</option>{promos?.filter((p) => p.type === 'receipt_coupon').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            </div>
            <ExportBar rows={list ?? []} name="coupons" cols={[{ key: 'code', label: 'Coupon Code' }, { key: 'promotionName', label: 'Promotion' }, { key: 'rewardText', label: 'Reward' }, { key: 'issuedAt', label: 'Issued', get: (r) => fmtDate(r.issuedAt) }, { key: 'expiresAt', label: 'Expiry', get: (r) => fmtDate(r.expiresAt, false) }, { key: 'status', label: 'Status' }, { key: 'issuedBillNo', label: 'Issued Order' }, { key: 'redeemedBillNo', label: 'Redeemed Order' }, { key: 'memberNo', label: 'Member' }, { key: 'issuedBranch', label: 'Branch' }, { key: 'discountAmount', label: 'Discount', get: (r) => (r.discountAmount ? (r.discountAmount / 100).toFixed(2) : '') }]} />
          </div>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Coupon Code</th><th>Promotion</th><th>Reward</th><th>Issued</th><th>Expiry</th><th>Status</th><th>Issued Order</th><th>Redeemed Order</th><th>Member</th><th>Branch</th></tr></thead>
            <tbody>{(list ?? []).map((c) => (
              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => open(c)}>
                <td className="mono">{c.code}</td><td className="small">{c.promotionName ?? c.source}</td><td className="small">{c.rewardText}</td><td className="small">{fmtDate(c.issuedAt)}</td><td className="small">{fmtDate(c.expiresAt, false)}</td>
                <td><span className={`badge ${c.status}`}>{c.status}</span></td><td className="mono xs">{c.issuedBillNo}</td><td className="mono xs">{c.redeemedBillNo}{c.discountAmount ? <div className="ok">-{fmtMoney(c.discountAmount)}</div> : null}</td>
                <td className="small">{c.memberNo}</td><td className="small">{c.issuedBranch}{c.redeemedBranch ? ` → ${c.redeemedBranch}` : ''}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </>
      )}
      {tab === 'gift' && <GiftCards />}
      {tab === 'policy' && <Policy />}

      {sel && (
        <Modal title={`คูปอง ${sel.code}`} onClose={() => setSel(null)} width={760}
          footer={<>
            {['ACTIVE', 'RESERVED', 'PENDING_REVIEW'].includes(sel.status) && <button className="btn danger" onClick={() => act('cancel')}>ยกเลิก (CANCELLED)</button>}
            {['ACTIVE', 'RESERVED', 'PENDING_REVIEW'].includes(sel.status) && <button className="btn" onClick={() => act('void')}>VOID</button>}
            {['PENDING_REVIEW', 'CANCELLED', 'EXPIRED'].includes(sel.status) && <button className="btn primary" onClick={() => act('reactivate')}>เปิดใช้งาน (ACTIVE)</button>}
            {sel.status === 'ACTIVE' && <button className="btn" onClick={() => act('extend')}>ขยายวันหมดอายุ</button>}
          </>}>
          <div className="grid g2">
            <div className="center card"><BarcodeSvg value={sel.barcodeValue} height={60} /><div className="small">{sel.rewardText}</div><span className={`badge ${sel.status}`}>{sel.status}</span></div>
            <table className="t"><tbody>
              {[['Coupon ID', sel.id], ['Barcode Value', sel.barcodeValue], ['Promotion', sel.promotionName], ['Issued Order', sel.issuedBillNo], ['Issued Branch / POS', `${sel.issuedBranch ?? '-'} / ${sel.issuedTerminal ?? '-'}`], ['Issued Date/Time', fmtDate(sel.issuedAt)], ['Expiry Date', fmtDate(sel.expiresAt)], ['Redeemed Order', sel.redeemedBillNo ?? '-'], ['Redeemed Branch / POS', `${sel.redeemedBranch ?? '-'} / ${sel.redeemedTerminal ?? '-'}`], ['Redeemed Cashier', sel.redeemedStaff ?? '-'], ['Redeemed Date/Time', fmtDate(sel.redeemedAt)], ['Discount Amount', sel.discountAmount ? fmtMoney(sel.discountAmount) : '-'], ['หมายเหตุ', sel.note ?? '-']].map(([k, v]) => <tr key={k as string}><td className="muted small">{k}</td><td className="small mono">{v as any}</td></tr>)}
            </tbody></table>
          </div>
          <h3>ประวัติสถานะ (Audit)</h3>
          <table className="t"><tbody>{events.map((e) => <tr key={e.id}><td className="small">{fmtDate(e.created_at)}</td><td>{e.from_status ?? '∅'} → <b>{e.to_status}</b></td><td className="small">{e.reason}</td><td className="small mono">{e.bill_no ?? e.cart_id ?? ''}</td><td className="small">{e.staff_name}</td></tr>)}</tbody></table>
        </Modal>
      )}
      {issue && (
        <Modal title="ออกคูปองด้วยตนเอง" onClose={() => setIssue(null)} footer={<button className="btn primary" onClick={async () => { try { const r = await api('/api/marketing/coupons/issue', { body: { ...issue, promotionId: Number(issue.promotionId), count: Number(issue.count) } }); toast(`ออกคูปอง ${r.length} ใบ: ${r.slice(0, 3).map((c: any) => c.code).join(', ')}`, 'ok'); setIssue(null); reload(); rs(); } catch (e) { toast(errMsg(e), 'err'); } }}>ออกคูปอง</button>}>
          <div className="grid">
            <Field label="โปรโมชั่นคูปอง"><select className="in" value={issue.promotionId ?? ''} onChange={(e) => setIssue({ ...issue, promotionId: e.target.value })}>{promos?.filter((p) => p.type === 'receipt_coupon').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label="จำนวน"><input className="in" type="number" min={1} max={1000} value={issue.count} onChange={(e) => setIssue({ ...issue, count: e.target.value })} /></Field>
            <Field label="เหตุผล"><input className="in" value={issue.reason} onChange={(e) => setIssue({ ...issue, reason: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function GiftCards() {
  const toast = useToast();
  const { data, reload } = useApi<any[]>('/api/marketing/gift-cards');
  const [amt, setAmt] = useState<number | null>(50000);
  const [n, setN] = useState(1);
  return (
    <div className="grid">
      <div className="row"><Field label="มูลค่า"><MoneyInput value={amt} onChange={setAmt} /></Field><Field label="จำนวนใบ"><input className="in" type="number" value={n} onChange={(e) => setN(Number(e.target.value))} /></Field>
        <button className="btn primary" style={{ alignSelf: 'end' }} onClick={async () => { try { await api('/api/marketing/gift-cards', { body: { amount: amt, count: n } }); reload(); } catch (e) { toast(errMsg(e), 'err'); } }}>ออกบัตรของขวัญ</button></div>
      <div className="table-wrap"><table className="t"><thead><tr><th>รหัส</th><th className="right">มูลค่าเริ่มต้น</th><th className="right">คงเหลือ</th><th>สถานะ</th><th>หมดอายุ</th><th></th></tr></thead>
        <tbody>{(data ?? []).map((g) => <tr key={g.id}><td className="mono">{g.code}</td><td className="right num">{fmtMoney(Number(g.initial_balance))}</td><td className="right num">{fmtMoney(Number(g.balance))}</td><td><span className={`badge ${g.status === 'active' ? 'ok' : 'err'}`}>{g.status}</span></td><td className="small">{fmtDate(g.expires_at, false)}</td><td><BarcodeSvg value={g.code} height={28} width={1} displayValue={false} /></td></tr>)}</tbody></table></div>
    </div>
  );
}

function Policy() {
  const toast = useToast();
  const { data, reload } = useApi<any>('/api/admin/settings');
  const [v, setV] = useState<any>(null);
  const c = v ?? data?.coupons;
  if (!c) return null;
  return (
    <div className="card grid g2">
      <Field label="เมื่อบิลที่ “ใช้” คูปองถูกคืนเงิน"><select className="in" value={c.onRedeemedOrderRefund} onChange={(e) => setV({ ...c, onRedeemedOrderRefund: e.target.value })}><option value="none">ไม่คืน Coupon</option><option value="reactivate">คืน Coupon กลับเป็น ACTIVE</option><option value="reissue">สร้าง Coupon ใหม่ทดแทน</option></select></Field>
      <Field label="เมื่อบิลต้นทางที่ “ออก” คูปองถูกคืนเงิน"><select className="in" value={c.onIssuedOrderRefund} onChange={(e) => setV({ ...c, onIssuedOrderRefund: e.target.value })}><option value="cancel">ยกเลิก Coupon ที่ยังไม่ได้ใช้</option><option value="keep">ไม่ยกเลิก Coupon</option><option value="review">ส่งให้ Manager ตรวจสอบ</option></select></Field>
      <Field label="คูปองสูงสุดต่อบิล (ทุกโปรรวมกัน)"><input className="in" type="number" value={c.maxPerBill} onChange={(e) => setV({ ...c, maxPerBill: Number(e.target.value) })} /></Field>
      <Field label="เวลาจองคูปองกับบิล (นาที)"><input className="in" type="number" value={c.reservationMinutes} onChange={(e) => setV({ ...c, reservationMinutes: Number(e.target.value) })} /></Field>
      <div><button className="btn primary" onClick={async () => { await api('/api/admin/settings/coupons', { method: 'PUT', body: c }); toast('บันทึกแล้ว', 'ok'); setV(null); reload(); }}>บันทึก</button></div>
    </div>
  );
}
