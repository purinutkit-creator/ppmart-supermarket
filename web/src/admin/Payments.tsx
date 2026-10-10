import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApi, Modal, useToast, errMsg, Field } from '../components/ui';
import { fmtMoney, fmtDate } from '../lib/format';
import { adminBus } from './AdminApp';
import { PAYMENT_LABELS } from '../../../shared/receipt';

/** Staff verification of transfers / slips. Approval requires a bank reference — never the slip image alone. */
export default function Payments() {
  const toast = useToast();
  const { data, reload } = useApi<any[]>('/api/payments/review');
  const { data: hist, reload: rh } = useApi<any[]>('/api/payments/history');
  const [sel, setSel] = useState<any>(null);
  const [ref, setRef] = useState('');
  const [checked, setChecked] = useState(false);
  useEffect(() => adminBus.ws?.on('payment.review', () => { reload(); rh(); }), [reload, rh]);
  const decide = async (approve: boolean) => {
    try { await api(`/api/payments/intents/${sel.id}/verify`, { body: { approve, reference: approve ? ref : undefined, note: approve ? 'ตรวจสอบยอดเข้าบัญชีแล้ว' : 'ไม่พบยอดเงินเข้า' } }); toast(approve ? 'ยืนยันการชำระเงินแล้ว' : 'ปฏิเสธรายการแล้ว', approve ? 'ok' : 'warn'); setSel(null); reload(); rh(); }
    catch (e) { toast(errMsg(e), 'err'); }
  };
  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>ตรวจสอบการชำระเงิน</h1></div>
      <div className="banner warn">ยืนยันได้เฉพาะเมื่อเห็นยอดเงินเข้าจริงในบัญชีธนาคาร/แอป และต้องกรอกเลขอ้างอิงธุรกรรม — ห้ามยืนยันจากภาพสลิปเพียงอย่างเดียว</div>
      <div className="table-wrap"><table className="t"><thead><tr><th>เวลา</th><th>เครื่อง</th><th>ช่องทาง</th><th className="right">ยอด</th><th>อ้างอิงที่แคชเชียร์กรอก</th><th>สลิป</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>{(data ?? []).map((p) => <tr key={p.id}><td className="small">{fmtDate(p.created_at)}</td><td>{p.terminal_code}<div className="xs muted">{p.created_by_name}</div></td><td>{PAYMENT_LABELS[p.method]}</td><td className="right num"><b>{fmtMoney(Number(p.amount))}</b></td><td className="mono small">{p.reference}</td><td>{p.slip_image ? '📎' : '-'}</td><td><span className={`badge ${p.status}`}>{p.status}</span></td><td><button className="btn sm primary" onClick={() => { setSel(p); setRef(p.reference ?? ''); setChecked(false); }}>ตรวจสอบ</button></td></tr>)}</tbody></table>
        {!data?.length && <div className="muted center" style={{ padding: '1.5rem' }}>ไม่มีรายการรอตรวจสอบ</div>}</div>
      <h3>ประวัติ</h3>
      <div className="table-wrap" style={{ maxHeight: 360 }}><table className="t"><thead><tr><th>เวลา</th><th>Provider</th><th>ช่องทาง</th><th className="right">ยอด</th><th>อ้างอิง</th><th>สถานะ</th><th>ผู้ตรวจ</th><th>บิล</th></tr></thead>
        <tbody>{(hist ?? []).map((p) => <tr key={p.id}><td className="small">{fmtDate(p.created_at)}</td><td className="small">{p.provider}</td><td>{PAYMENT_LABELS[p.method]}</td><td className="right num">{fmtMoney(Number(p.amount))}</td><td className="mono xs">{p.reference ?? p.provider_ref}</td><td><span className={`badge ${p.status}`}>{p.status}</span></td><td className="small">{p.verified_by_name}</td><td className="small">{p.sale_id ?? ''}</td></tr>)}</tbody></table></div>
      {sel && (
        <Modal title={`ตรวจสอบ ${PAYMENT_LABELS[sel.method]} ${fmtMoney(Number(sel.amount))}`} onClose={() => setSel(null)} width={620}
          footer={<><button className="btn danger" onClick={() => decide(false)}>ไม่พบยอด / ปฏิเสธ</button><button className="btn primary" disabled={!checked || ref.trim().length < 3} onClick={() => decide(true)}>ยืนยันยอดเข้าแล้ว</button></>}>
          {sel.slip_image && <img src={sel.slip_image} style={{ maxWidth: '100%', maxHeight: 360, display: 'block', margin: '0 auto 10px', borderRadius: 8 }} />}
          <Field label="เลขอ้างอิงธุรกรรมจากรายการเดินบัญชี (จำเป็น)"><input className="in mono" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
          <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> ฉันตรวจสอบแล้วว่ามียอด {fmtMoney(Number(sel.amount))} เข้าบัญชีร้านจริง</label>
        </Modal>
      )}
    </div>
  );
}
