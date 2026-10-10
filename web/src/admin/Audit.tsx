import { useState } from 'react';
import { useApi } from '../components/ui';
import { fmtDate } from '../lib/format';
import { ExportBar } from '../components/ExportBar';

export default function Audit() {
  const [q, setQ] = useState('');
  const { data } = useApi<any[]>(`/api/admin/audit?q=${encodeURIComponent(q)}`, [q]);
  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>Activity Log</h1>
        <ExportBar rows={data ?? []} name="audit-log" cols={[{ key: 'created_at', label: 'เวลา', get: (r) => fmtDate(r.created_at) }, { key: 'staff_name', label: 'ผู้ดำเนินการ' }, { key: 'action', label: 'การกระทำ' }, { key: 'bill_no', label: 'เลขบิล' }, { key: 'reason', label: 'เหตุผล' }, { key: 'approved_by_name', label: 'ผู้อนุมัติ' }, { key: 'entity', label: 'Entity', get: (r) => `${r.entity ?? ''} ${r.entity_id ?? ''}` }, { key: 'details', label: 'รายละเอียด', get: (r) => JSON.stringify(r.details) }]} /></div>
      <input className="in" style={{ maxWidth: 360 }} placeholder="ค้นหา action / เลขบิล / ชื่อ / เหตุผล" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap"><table className="t"><thead><tr><th>เวลา</th><th>ผู้ดำเนินการ</th><th>การกระทำ</th><th>เลขบิล</th><th>เหตุผล</th><th>ผู้อนุมัติ</th><th>รายละเอียด</th></tr></thead>
        <tbody>{(data ?? []).map((a) => <tr key={a.id}><td className="small">{fmtDate(a.created_at)}</td><td>{a.staff_name}</td><td><span className="badge">{a.action}</span></td><td className="mono small">{a.bill_no}</td><td className="small">{a.reason}</td><td className="small">{a.approved_by_name}</td><td className="xs mono" style={{ maxWidth: 360, wordBreak: 'break-all' }}>{a.entity} {a.entity_id} {Object.keys(a.details || {}).length ? JSON.stringify(a.details).slice(0, 240) : ''}</td></tr>)}</tbody></table></div>
    </div>
  );
}
