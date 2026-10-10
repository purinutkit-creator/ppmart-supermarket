import { useEffect, useState } from 'react';
import { useApi } from '../components/ui';
import { fmtMoney, fmtQty } from '../lib/format';
import { adminBus } from './AdminApp';
import { PAYMENT_LABELS } from '../../../shared/receipt';

export function Bars({ data, label, value }: { data: any[]; label: (r: any) => string; value: (r: any) => number }) {
  const max = Math.max(1, ...data.map(value));
  return (
    <div>
      <div className="bars">{data.map((r, i) => <div key={i} className="bar" style={{ height: `${(value(r) / max) * 100}%` }} title={`${label(r)}: ${fmtMoney(value(r))}`} />)}</div>
      <div className="row between xs muted"><span>{data[0] ? label(data[0]) : ''}</span><span>{data.length ? label(data[data.length - 1]) : ''}</span></div>
    </div>
  );
}

export function HBars({ rows, label, value, fmt = fmtMoney }: { rows: any[]; label: (r: any) => string; value: (r: any) => number; fmt?: (n: number) => string }) {
  const max = Math.max(1, ...rows.map(value));
  return (
    <div className="grid" style={{ gap: 6 }}>
      {rows.map((r, i) => (
        <div key={i}>
          <div className="row between small"><span>{label(r)}</span><b className="num">{fmt(value(r))}</b></div>
          <div className="hbar" style={{ width: `${(value(r) / max) * 100}%` }} />
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [branchId, setBranchId] = useState('');
  const { data: branches } = useApi<any[]>('/api/admin/branches');
  const { data, reload } = useApi<any>(`/api/reports/summary?branchId=${branchId}`, [branchId]);
  const [live, setLive] = useState<any[]>([]);

  useEffect(() => {
    const ws = adminBus.ws;
    if (!ws) return;
    const off = ws.on('sale.completed', (p) => {
      setLive((l) => [{ ...p, at: new Date() }, ...l].slice(0, 12));
      clearTimeout((window as any).__dash);
      (window as any).__dash = setTimeout(reload, 800);
    });
    return () => { off(); };
  }, [reload]);

  if (!data) return <div className="muted">กำลังโหลด…</div>;
  const k = data.kpi, tt = data.totals;
  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head">
        <h1>Dashboard <span className="small muted">(Real-Time)</span></h1>
        <select className="in" style={{ width: 220 }} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          <option value="">ทุกสาขา</option>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      </div>
      <div className="grid g4">
        <div className="card kpi"><div className="l">ยอดขายวันนี้</div><div className="v">{fmtMoney(Number(k.today_total))}</div><div className="xs muted">{k.today_bills} บิล</div></div>
        <div className="card kpi"><div className="l">ยอดขายเดือนนี้</div><div className="v">{fmtMoney(Number(k.month_total))}</div><div className="xs muted">{k.month_bills} บิล</div></div>
        <div className="card kpi"><div className="l">ยอดเฉลี่ยต่อบิล (วันนี้)</div><div className="v">{fmtMoney(tt.avg_bill)}</div></div>
        <div className="card kpi"><div className="l">กำไรขั้นต้น (วันนี้)</div><div className="v">{data.showCost ? fmtMoney(tt.gross_profit) : '—'}</div><div className="xs muted">{data.showCost ? `Margin ${(tt.margin * 100).toFixed(1)}%` : 'ไม่มีสิทธิ์ดูต้นทุน'}</div></div>
      </div>
      <div className="grid g4">
        <div className="card kpi"><div className="l">⚠️ สินค้าใกล้หมดอายุ (30 วัน)</div><div className="v warn-t">{data.alerts.expiring}</div></div>
        <div className="card kpi"><div className="l">📉 สต็อกต่ำกว่าขั้นต่ำ</div><div className="v err">{data.alerts.low_stock}</div></div>
        <div className="card kpi"><div className="l">💳 รอตรวจสอบการชำระ</div><div className="v">{data.alerts.payments_review}</div></div>
        <div className="card kpi"><div className="l">🎟 คูปองรอผู้จัดการตรวจ</div><div className="v">{data.alerts.coupons_review}</div></div>
      </div>
      <div className="grid g2">
        <div className="card"><h3>ยอดขายรายชั่วโมง (วันนี้)</h3><Bars data={Array.from({ length: 24 }, (_, h) => data.byHour.find((x: any) => x.hour === h) ?? { hour: h, total: 0 })} label={(r) => `${r.hour}:00`} value={(r) => Number(r.total)} /></div>
        <div className="card"><h3>บิลล่าสุด (Live)</h3>
          {live.length === 0 && <div className="muted small">รอรายการขายใหม่…</div>}
          <table className="t"><tbody>{live.map((l, i) => <tr key={i}><td className="small">{l.at.toLocaleTimeString('th-TH')}</td><td className="mono small">{l.billNo}</td><td className="right num">{fmtMoney(l.total)}</td></tr>)}</tbody></table>
        </div>
      </div>
      <div className="grid g3">
        <div className="card"><h3>🔥 สินค้าขายดี</h3><HBars rows={data.top.slice(0, 8)} label={(r) => `${r.name} (${fmtQty(Number(r.qty))})`} value={(r) => Number(r.total)} /></div>
        <div className="card"><h3>🐢 สินค้าขายช้า</h3><table className="t"><tbody>{data.slow.slice(0, 8).map((r: any) => <tr key={r.id}><td>{r.name}</td><td className="right small">ขาย {fmtQty(Number(r.sold))} · คงเหลือ {fmtQty(Number(r.on_hand))}</td></tr>)}</tbody></table></div>
        <div className="card"><h3>ช่องทางชำระเงิน</h3><HBars rows={data.byMethod} label={(r) => PAYMENT_LABELS[r.method] ?? r.method} value={(r) => Number(r.total)} /></div>
      </div>
      <div className="grid g2">
        <div className="card"><h3>ยอดขายตามสาขา</h3><HBars rows={data.byBranch} label={(r) => `${r.name} (${r.bills} บิล)`} value={(r) => Number(r.total)} /></div>
        <div className="card"><h3>ยอดขายตามหมวดหมู่</h3><HBars rows={data.byCategory.slice(0, 8)} label={(r) => r.name} value={(r) => Number(r.total)} /></div>
      </div>
    </div>
  );
}
