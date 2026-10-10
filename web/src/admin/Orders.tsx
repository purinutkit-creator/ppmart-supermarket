import { useEffect, useState } from 'react';
import { api, can } from '../lib/api';
import { useApi, Modal, useToast, errMsg, Field, QrCanvas } from '../components/ui';
import { fmtMoney, fmtDate, fmtQty } from '../lib/format';
import { adminBus } from './AdminApp';

const STATUS: Record<string, string> = {
  pending_payment: 'รอชำระเงิน', paid: 'ชำระแล้ว', preparing: 'กำลังจัดเตรียม', ready: 'พร้อมรับ', shipped: 'จัดส่งแล้ว', completed: 'สำเร็จ', cancelled: 'ยกเลิก',
};
const PAY: Record<string, string> = { promptpay: 'พร้อมเพย์', pay_at_store: 'ชำระที่ร้าน', cod: 'เก็บเงินปลายทาง' };
const FILTERS: [string, string][] = [['active', 'ต้องดำเนินการ'], ['pending_payment', 'รอชำระ'], ['paid,preparing', 'ชำระแล้ว/จัดเตรียม'], ['ready,shipped', 'พร้อมรับ/จัดส่งแล้ว'], ['completed', 'สำเร็จ'], ['cancelled', 'ยกเลิก'], ['', 'ทั้งหมด']];

/** Back office for online-shop orders: payment confirmation, fulfilment workflow, cancellation (returns stock). */
export default function Orders() {
  const [filter, setFilter] = useState('active');
  const [q, setQ] = useState('');
  const [store, setStore] = useState('');
  const { data: stores } = useApi<any[]>('/api/storefronts');
  const status = filter === 'active' ? 'pending_payment,paid,preparing,ready,shipped' : filter;
  const { data, reload } = useApi<any[]>(`/api/orders?status=${status}&q=${encodeURIComponent(q)}&store=${store}`, [status, q, store]);
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => adminBus.ws?.on('shop.order', () => reload()), [reload]);
  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>ออเดอร์ออนไลน์</h1><a className="btn" href="/shop" target="_blank" rel="noreferrer">🌐 เปิดหน้าร้านออนไลน์</a></div>
      <div className="row">
        <div className="tabs" style={{ margin: 0 }}>{FILTERS.map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}</div>
        {(stores?.length ?? 0) > 1 && <select className="in" style={{ width: 180 }} value={store} onChange={(e) => setStore(e.target.value)}><option value="">ทุกร้าน</option>{stores!.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        <input className="in" style={{ maxWidth: 260 }} placeholder="ค้นหาเลขออเดอร์ / ชื่อ / เบอร์" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="table-wrap"><table className="t">
        <thead><tr><th>เลขที่</th><th>เวลา</th><th>ลูกค้า</th><th>รับสินค้า</th><th>ชำระ</th><th className="right">ยอด</th><th>สถานะ</th></tr></thead>
        <tbody>{(data ?? []).map((o) => (
          <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => setSel(o.id)}>
            <td className="mono small"><b>{o.order_no}</b>{o.store_name && <div className="xs muted" style={{ fontFamily: 'inherit' }}>{o.store_name}</div>}</td><td className="small">{fmtDate(o.created_at)}</td>
            <td>{o.customer_name}<div className="xs muted">{o.customer_phone}{o.member_name ? ` · สมาชิก ${o.member_name}` : ''}</div></td>
            <td>{o.fulfillment === 'pickup' ? '🏪 รับที่ร้าน' : '🚚 จัดส่ง'}</td>
            <td className="small">{PAY[o.payment_method]}{o.payment_status === 'needs_review' && <span className="badge needs_review" style={{ marginLeft: 4 }}>มีสลิป</span>}</td>
            <td className="right num"><b>{fmtMoney(Number(o.total))}</b><div className="xs muted">{o.lines} รายการ</div></td>
            <td><span className={`badge ${o.status}`}>{STATUS[o.status]}</span></td>
          </tr>
        ))}</tbody>
      </table>{!data?.length && <div className="muted center" style={{ padding: '1.5rem' }}>ไม่มีออเดอร์</div>}</div>
      {sel && <OrderDetail id={sel} onClose={() => setSel(null)} onChanged={reload} />}
    </div>
  );
}

function OrderDetail({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { data: o, reload } = useApi<any>(`/api/orders/${id}`, [id]);
  const [pay, setPay] = useState<{ method: string; reference: string } | null>(null);
  const [cancel, setCancel] = useState<string | null>(null);
  const [tracking, setTracking] = useState('');
  useEffect(() => adminBus.ws?.on('shop.order', () => reload()), [reload]);
  if (!o) return null;
  const act = async (path: string, body: any, msg: string) => {
    try { await api(`/api/orders/${id}/${path}`, { body }); toast(msg, 'ok'); reload(); onChanged(); setPay(null); setCancel(null); }
    catch (e) { toast(errMsg(e), 'err'); }
  };
  const status = (s: string, extra: any = {}) => act('status', { status: s, ...extra }, `เปลี่ยนสถานะเป็น “${STATUS[s]}” แล้ว`);
  const unpaid = !o.saleId;
  const canManage = can('orders.manage');
  const open = !['completed', 'cancelled'].includes(o.status);
  return (
    <Modal title={<>ออเดอร์ {o.orderNo} <span className={`badge ${o.status}`}>{STATUS[o.status]}</span></>} onClose={onClose} width={760}
      footer={<>
        <button className="btn" onClick={() => window.print()}>🖨️ พิมพ์ใบจัดสินค้า</button><span className="spacer" />
        {canManage && open && !(o.saleId) && <button className="btn danger" onClick={() => setCancel('')}>ยกเลิกออเดอร์</button>}
        {unpaid && o.status !== 'cancelled' && <button className="btn primary" onClick={() => setPay({ method: o.paymentMethod === 'promptpay' ? 'promptpay' : 'cash', reference: '' })}>💰 บันทึกรับชำระเงิน</button>}
        {canManage && ['paid', 'pending_payment'].includes(o.status) && !(o.status === 'pending_payment' && o.paymentMethod === 'promptpay') && <button className="btn" onClick={() => status('preparing')}>เริ่มจัดเตรียม</button>}
        {canManage && ['paid', 'preparing', 'pending_payment'].includes(o.status) && o.fulfillment === 'pickup' && !(o.status === 'pending_payment' && o.paymentMethod === 'promptpay') && <button className="btn" onClick={() => status('ready')}>พร้อมให้รับ</button>}
        {canManage && ['paid', 'preparing', 'pending_payment'].includes(o.status) && o.fulfillment === 'delivery' && !(o.status === 'pending_payment' && o.paymentMethod === 'promptpay') && <button className="btn" onClick={() => status('shipped', tracking ? { trackingNo: tracking } : {})}>จัดส่งแล้ว</button>}
        {canManage && o.saleId && open && <button className="btn primary" onClick={() => status('completed')}>✔ ปิดออเดอร์ (ส่งมอบแล้ว)</button>}
      </>}>
      <div className="print-area order-slip">
        <div className="grid g2" style={{ gap: 8 }}>
          <div><b>{o.customer.name}</b><div className="small">{o.customer.phone}{o.customer.email ? ` · ${o.customer.email}` : ''}</div>{o.member && <div className="small">สมาชิก {o.member.member_no} {o.member.name}</div>}</div>
          <div className="small">{fmtDate(o.createdAt)}<div>{o.fulfillment === 'pickup' ? `🏪 รับที่ร้าน ${o.branch?.name ?? ''}` : '🚚 จัดส่ง'} · {PAY[o.paymentMethod]}</div>{o.paidAt && <div className="ok">ชำระเมื่อ {fmtDate(o.paidAt)}</div>}</div>
        </div>
        {o.address && <div className="card small" style={{ margin: '8px 0' }}><b>ที่อยู่จัดส่ง:</b> {o.address}</div>}
        {o.note && <div className="card small" style={{ margin: '8px 0', background: '#fffbeb' }}><b>หมายเหตุ:</b> {o.note}</div>}
        <table className="t" style={{ marginTop: 8 }}>
          <thead><tr><th>☐</th><th>สินค้า</th><th className="right">จำนวน</th><th className="right">ราคา</th><th className="right">รวม</th></tr></thead>
          <tbody>{o.items.map((i: any, k: number) => <tr key={k}><td>☐</td><td>{i.name}</td><td className="right num"><b>{fmtQty(Number(i.qty))}</b></td><td className="right num">{fmtMoney(Number(i.unit_price))}</td><td className="right num">{fmtMoney(Number(i.line_total))}</td></tr>)}</tbody>
          <tfoot>
            {o.discount > 0 && <tr><td colSpan={4} className="right">ส่วนลด</td><td className="right num">−{fmtMoney(o.discount)}</td></tr>}
            {o.shipping > 0 && <tr><td colSpan={4} className="right">ค่าจัดส่ง</td><td className="right num">{fmtMoney(o.shipping)}</td></tr>}
            <tr><td colSpan={4} className="right"><b>ยอดรวม</b></td><td className="right num"><b>{fmtMoney(o.total)}</b></td></tr>
          </tfoot>
        </table>
      </div>
      {o.trackingNo && <div className="small">เลขพัสดุ: <b className="mono">{o.trackingNo}</b></div>}
      {o.cancelledReason && <div className="small err">เหตุผลที่ยกเลิก: {o.cancelledReason}</div>}
      {o.saleId && <div className="small muted">บันทึกเป็นบิลขาย {o.orderNo} แล้ว (รายงานยอดขาย/คะแนนสมาชิก) — การคืนเงินทำที่หน้าขาย → ประวัติบิล</div>}
      {canManage && open && o.fulfillment === 'delivery' && <Field label="เลขพัสดุ (Tracking)"><input className="in mono" value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder={o.trackingNo ?? ''} /></Field>}
      {o.status === 'pending_payment' && o.payment?.qrPayload && <div className="small muted" style={{ marginTop: 8 }}>QR พร้อมเพย์ที่ลูกค้าได้รับ: <QrCanvas value={o.payment.qrPayload} size={120} /></div>}

      {pay && (
        <Modal title="บันทึกรับชำระเงิน" onClose={() => setPay(null)}
          footer={<><button className="btn" onClick={() => setPay(null)}>ยกเลิก</button><button className="btn primary" disabled={pay.method !== 'cash' && pay.reference.trim().length < 3} onClick={() => act('mark-paid', { method: pay.method, reference: pay.reference || null }, 'บันทึกการชำระเงินแล้ว')}>ยืนยันรับเงิน {fmtMoney(o.total)}</button></>}>
          <Field label="ช่องทาง"><select className="in" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
            <option value="cash">เงินสด</option><option value="promptpay">พร้อมเพย์</option><option value="transfer">โอนเงิน</option><option value="credit_card">บัตรเครดิต</option><option value="debit_card">บัตรเดบิต</option><option value="ewallet">e-Wallet</option>
          </select></Field>
          {pay.method !== 'cash' && <Field label="เลขอ้างอิงธุรกรรม (ตรวจจากบัญชี/แอปธนาคาร)"><input className="in mono" value={pay.reference} onChange={(e) => setPay({ ...pay, reference: e.target.value })} /></Field>}
          <p className="xs muted">ระบบจะบันทึกเป็นบิลขาย (ช่องทางออนไลน์) เข้ารายงานยอดขาย และให้คะแนนสมาชิกอัตโนมัติ</p>
        </Modal>
      )}
      {cancel != null && (
        <Modal title="ยกเลิกออเดอร์" onClose={() => setCancel(null)}
          footer={<><button className="btn" onClick={() => setCancel(null)}>ไม่ยกเลิก</button><button className="btn danger" disabled={cancel.trim().length < 2} onClick={() => status('cancelled', { reason: cancel })}>ยืนยันยกเลิก</button></>}>
          <Field label="เหตุผล"><input className="in" value={cancel} onChange={(e) => setCancel(e.target.value)} autoFocus /></Field>
          <p className="xs muted">สินค้าจะถูกคืนเข้าสต็อกอัตโนมัติ</p>
        </Modal>
      )}
    </Modal>
  );
}
