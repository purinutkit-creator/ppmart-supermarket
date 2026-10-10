import { useState } from 'react';
import { api } from '../lib/api';
import { useApi, Modal } from '../components/ui';
import { fmtMoney, fmtDate } from '../lib/format';
import { printShiftReport } from '../pages/pos/panels';
import { PAYMENT_LABELS } from '../../../shared/receipt';
import { ExportBar } from '../components/ExportBar';

export default function Shifts() {
  const { data } = useApi<any[]>('/api/shifts');
  const [sel, setSel] = useState<any>(null);
  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>กะแคชเชียร์</h1><ExportBar rows={data ?? []} name="shifts" cols={[{ key: 'id', label: 'กะ' }, { key: 'terminal_code', label: 'เครื่อง' }, { key: 'staff_name', label: 'พนักงาน' }, { key: 'opened_at', label: 'เปิด', get: (r) => fmtDate(r.opened_at) }, { key: 'closed_at', label: 'ปิด', get: (r) => fmtDate(r.closed_at) }, { key: 'opening_float', label: 'เงินทอนเริ่มต้น', get: (r) => Number(r.opening_float) / 100 }, { key: 'expected_cash', label: 'ควรมี', get: (r) => (r.expected_cash != null ? Number(r.expected_cash) / 100 : '') }, { key: 'counted_cash', label: 'นับได้', get: (r) => (r.counted_cash != null ? Number(r.counted_cash) / 100 : '') }, { key: 'difference', label: 'ส่วนต่าง', get: (r) => (r.difference != null ? Number(r.difference) / 100 : '') }]} /></div>
      <div className="table-wrap"><table className="t"><thead><tr><th>#</th><th>สาขา/เครื่อง</th><th>พนักงาน</th><th>เปิด</th><th>ปิด</th><th className="right">เงินทอนเริ่มต้น</th><th className="right">ควรมี</th><th className="right">นับได้</th><th className="right">ขาด/เกิน</th><th>สถานะ</th></tr></thead>
        <tbody>{(data ?? []).map((s) => <tr key={s.id} style={{ cursor: 'pointer' }} onClick={async () => setSel(await api(`/api/shifts/${s.id}/summary`))}><td>{s.id}</td><td>{s.branch_name} / {s.terminal_code}</td><td>{s.staff_name}</td><td className="small">{fmtDate(s.opened_at)}</td><td className="small">{fmtDate(s.closed_at)}</td><td className="right num">{fmtMoney(Number(s.opening_float))}</td><td className="right num">{s.expected_cash != null ? fmtMoney(Number(s.expected_cash)) : '-'}</td><td className="right num">{s.counted_cash != null ? fmtMoney(Number(s.counted_cash)) : '-'}</td><td className={`right num ${Number(s.difference) < 0 ? 'err' : Number(s.difference) > 0 ? 'warn-t' : 'ok'}`}>{s.difference != null ? fmtMoney(Number(s.difference)) : '-'}</td><td><span className={`badge ${s.status}`}>{s.status}</span></td></tr>)}</tbody></table></div>
      {sel && (
        <Modal title={`กะ #${sel.shift.id} — ${sel.shift.staff_name}`} onClose={() => setSel(null)} width={720} footer={<button className="btn" onClick={() => printShiftReport(sel)}>🖨️ พิมพ์รายงานกะ</button>}>
          <table className="t"><tbody>
            {sel.byMethod.map((m: any) => <tr key={m.method}><td>{PAYMENT_LABELS[m.method] ?? m.method}</td><td>{m.bills} บิล</td><td className="right num">{fmtMoney(Number(m.amount))}</td></tr>)}
            <tr><td>เงินสดที่ควรมี</td><td></td><td className="right num"><b>{fmtMoney(sel.cash.expected)}</b></td></tr>
          </tbody></table>
          <h3>เงินเข้า–ออก / เปิดลิ้นชัก</h3>
          <table className="t"><tbody>{sel.cashMovements.map((c: any) => <tr key={c.id}><td className="small">{fmtDate(c.created_at)}</td><td>{c.type}</td><td>{c.reason} {c.ref}</td><td className="right num">{c.amount ? fmtMoney(Number(c.amount)) : ''}</td><td className="small">{c.staff_name}</td></tr>)}</tbody></table>
        </Modal>
      )}
    </div>
  );
}
