import { useState } from 'react';
import { useApi, Field } from '../components/ui';
import { fmtMoney, fmtQty, fmtDate, baht } from '../lib/format';
import { exportCSV, exportXLSX, exportPDF, type Col } from '../lib/export';
import { Bars, HBars } from './Dashboard';
import { PAYMENT_LABELS } from '../../../shared/receipt';

export default function Reports() {
  const today = new Date().toLocaleDateString('en-CA');
  const monthStart = today.slice(0, 8) + '01';
  const [f, setF] = useState({ from: monthStart, to: today, branchId: '', staffId: '', terminalId: '', categoryId: '', method: '' });
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const { data } = useApi<any>(`/api/reports/summary?${qs}`, [qs]);
  const { data: sales } = useApi<any[]>(`/api/reports/sales?${qs}`, [qs]);
  const { data: products } = useApi<any[]>(`/api/reports/products?${qs}`, [qs]);
  const { data: branches } = useApi<any[]>('/api/admin/branches');
  const { data: staff } = useApi<any[]>('/api/admin/staff');
  const { data: terminals } = useApi<any[]>('/api/admin/terminals');
  const { data: cats } = useApi<any[]>('/api/products/meta/categories');
  const showCost = !!data?.showCost;

  const saleCols: Col[] = [
    { key: 'bill_no', label: 'เลขที่บิล' }, { key: 'created_at', label: 'วันที่', get: (r) => fmtDate(r.created_at) }, { key: 'branch', label: 'สาขา' }, { key: 'terminal', label: 'เครื่อง' },
    { key: 'staff', label: 'พนักงาน' }, { key: 'member_no', label: 'สมาชิก' }, { key: 'status', label: 'สถานะ' }, { key: 'subtotal', label: 'ยอดรวม', get: (r) => baht(r.subtotal) },
    { key: 'discount_total', label: 'ส่วนลด', get: (r) => baht(r.discount_total) }, { key: 'vat_amount', label: 'VAT', get: (r) => baht(r.vat_amount) }, { key: 'total', label: 'ยอดสุทธิ', get: (r) => baht(r.total) }, { key: 'payments', label: 'ชำระโดย' },
  ];
  const prodCols: Col[] = [
    { key: 'sku', label: 'SKU' }, { key: 'name', label: 'สินค้า' }, { key: 'category', label: 'หมวด' }, { key: 'qty', label: 'จำนวน' }, { key: 'total', label: 'ยอดขาย', get: (r) => baht(Number(r.total)) },
    { key: 'discount', label: 'ส่วนลด', get: (r) => baht(Number(r.discount)) },
    ...(showCost ? [{ key: 'cost', label: 'ต้นทุน', get: (r: any) => baht(Number(r.cost)) }, { key: 'profit', label: 'กำไรขั้นต้น', get: (r: any) => baht(Number(r.total) - Number(r.cost)) }] : []),
  ];
  const name = `sales-report-${f.from}-${f.to}`;

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>รายงานยอดขาย</h1>
        <div className="row">
          <button className="btn sm" onClick={() => sales && exportCSV(sales, saleCols, name)}>⬇ CSV (บิล)</button>
          <button className="btn sm" onClick={() => products && exportXLSX(products, prodCols, name + '-products')}>⬇ Excel (สินค้า)</button>
          <button className="btn sm" onClick={() => data && exportPDF(`รายงานยอดขาย ${f.from} – ${f.to}`, [
            { title: 'สรุป', rows: [{ k: 'จำนวนบิล', v: data.totals.bills }, { k: 'ยอดขาย', v: baht(Number(data.totals.gross_sales)) }, { k: 'ส่วนลด', v: baht(Number(data.totals.discounts)) }, { k: 'ยอดเฉลี่ย/บิล', v: baht(data.totals.avg_bill) }, ...(showCost ? [{ k: 'กำไรขั้นต้น', v: baht(data.totals.gross_profit) }] : [])], cols: [{ key: 'k', label: 'รายการ' }, { key: 'v', label: 'ค่า' }] },
            { title: 'ช่องทางชำระเงิน', rows: data.byMethod, cols: [{ key: 'method', label: 'ช่องทาง', get: (r) => PAYMENT_LABELS[r.method] ?? r.method }, { key: 'bills', label: 'บิล' }, { key: 'total', label: 'ยอด', get: (r) => baht(Number(r.total)) }] },
            { title: 'สินค้า', rows: products ?? [], cols: prodCols },
          ])}>⬇ PDF</button>
        </div>
      </div>
      <div className="card grid g4">
        <Field label="ตั้งแต่"><input className="in" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="ถึง"><input className="in" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="สาขา"><select className="in" value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">ทั้งหมด</option>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="พนักงาน"><select className="in" value={f.staffId} onChange={(e) => setF({ ...f, staffId: e.target.value })}><option value="">ทั้งหมด</option>{staff?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="เครื่อง POS"><select className="in" value={f.terminalId} onChange={(e) => setF({ ...f, terminalId: e.target.value })}><option value="">ทั้งหมด</option>{terminals?.map((b) => <option key={b.id} value={b.id}>{b.code}</option>)}</select></Field>
        <Field label="หมวดหมู่สินค้า"><select className="in" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}><option value="">ทั้งหมด</option>{cats?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="ช่องทางชำระเงิน"><select className="in" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="">ทั้งหมด</option>{Object.entries(PAYMENT_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
      </div>
      {data && (
        <>
          <div className="grid g4">
            <div className="card kpi"><div className="l">ยอดขายสุทธิ</div><div className="v">{fmtMoney(Number(data.totals.gross_sales))}</div><div className="xs muted">{data.totals.bills} บิล · {fmtQty(Number(data.totals.qty))} ชิ้น</div></div>
            <div className="card kpi"><div className="l">ส่วนลดรวม</div><div className="v">{fmtMoney(Number(data.totals.discounts))}</div><div className="xs muted">คูปอง {fmtMoney(Number(data.totals.coupon_discount))}</div></div>
            <div className="card kpi"><div className="l">คืนเงิน</div><div className="v">{fmtMoney(Number(data.refunds.total))}</div><div className="xs muted">{data.refunds.n} รายการ</div></div>
            <div className="card kpi"><div className="l">กำไรขั้นต้น</div><div className="v">{showCost ? fmtMoney(data.totals.gross_profit) : '—'}</div><div className="xs muted">{showCost ? `ต้นทุน ${fmtMoney(data.totals.cost)} · ${(data.totals.margin * 100).toFixed(1)}%` : 'ต้องมีสิทธิ์ reports.cost'}</div></div>
          </div>
          <div className="card"><h3>ยอดขายรายวัน</h3><Bars data={data.byDay} label={(r) => r.day} value={(r) => Number(r.total)} /></div>
          <div className="grid g3">
            <div className="card"><h3>ตามพนักงาน</h3><HBars rows={data.byStaff} label={(r) => `${r.name} (${r.bills})`} value={(r) => Number(r.total)} /></div>
            <div className="card"><h3>ตามเครื่อง POS</h3><HBars rows={data.byTerminal} label={(r) => `${r.code} (${r.bills})`} value={(r) => Number(r.total)} /></div>
            <div className="card"><h3>ตามช่องทางชำระ</h3><HBars rows={data.byMethod} label={(r) => PAYMENT_LABELS[r.method] ?? r.method} value={(r) => Number(r.total)} /></div>
          </div>
        </>
      )}
      <div className="card">
        <div className="row between"><h3>ยอดขายตามสินค้า</h3></div>
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="t"><thead><tr>{prodCols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>{(products ?? []).map((r, i) => <tr key={i}>{prodCols.map((c) => <td key={c.key} className={['qty', 'total', 'discount', 'cost', 'profit'].includes(c.key) ? 'num right' : ''}>{c.get ? c.get(r) : r[c.key]}</td>)}</tr>)}</tbody></table>
        </div>
      </div>
      <div className="card">
        <h3>รายการบิล ({sales?.length ?? 0})</h3>
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="t"><thead><tr>{saleCols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>{(sales ?? []).slice(0, 500).map((r) => <tr key={r.id}>{saleCols.map((c) => <td key={c.key}>{c.key === 'status' ? <span className={`badge ${r.status}`}>{r.status}</span> : c.get ? c.get(r) : r[c.key]}</td>)}</tr>)}</tbody></table>
        </div>
      </div>
    </div>
  );
}
