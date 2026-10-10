import { useEffect, useState } from 'react';
import { Modal, Numpad, errMsg, useToast, useWithApproval, Field, MoneyInput, BarcodeSvg } from '../../components/ui';
import { api } from '../../lib/api';
import { fmtMoney, fmtDate, uuid, fmtQty } from '../../lib/format';
import { printer } from '../../lib/printer';
import { renderReport } from '../../lib/receipt-render';
import { receiptJob } from '../../lib/escpos';
import { printSettings, printSaleReceipts, toReceiptData, openDrawer } from '../../lib/receipt-print';
import { scale } from '../../lib/scale';
import { PAYMENT_LABELS } from '../../../../shared/receipt';

// ---------------- Shift ----------------
export async function printShiftReport(sum: any) {
  const ps = printSettings();
  const s = sum.shift;
  const rows: any[] = [
    { l: 'เครื่อง', r: s.terminal_code }, { l: 'พนักงาน', r: s.staff_name }, { l: 'เปิดกะ', r: fmtDate(s.opened_at) }, { l: 'ปิดกะ', r: s.closed_at ? fmtDate(s.closed_at) : '-' },
    { divider: true, l: '' }, { l: 'จำนวนบิล', r: String(sum.totals.bills) }, { l: 'ยอดขายรวม', r: fmtMoney(Number(sum.totals.total)), bold: true },
    { l: 'ส่วนลดรวม', r: fmtMoney(Number(sum.totals.discounts)) }, { l: 'บิลที่ Void', r: String(sum.totals.voided) }, { l: 'คืนเงิน', r: `${sum.refunds.n} / ${fmtMoney(Number(sum.refunds.total))}` },
    { divider: true, l: '' }, { l: 'แยกตามช่องทางชำระเงิน', bold: true },
    ...sum.byMethod.map((m: any) => ({ l: `${PAYMENT_LABELS[m.method] || m.method} (${m.bills})`, r: fmtMoney(Number(m.amount)) })),
    { divider: true, l: '' }, { l: 'เงินทอนเริ่มต้น', r: fmtMoney(sum.cash.openingFloat) }, { l: 'ขายเงินสด', r: fmtMoney(sum.cash.cashSales) },
    { l: 'นำเงินเข้า', r: fmtMoney(sum.cash.payIn) }, { l: 'นำเงินออก', r: fmtMoney(sum.cash.payOut) }, { l: 'คืนเงินสด', r: fmtMoney(sum.cash.refundCash) },
    { l: 'เงินสดที่ควรมี', r: fmtMoney(sum.cash.expected), bold: true },
    ...(s.counted_cash != null ? [{ l: 'นับได้จริง', r: fmtMoney(Number(s.counted_cash)), bold: true }, { l: Number(s.difference) >= 0 ? 'เงินเกิน' : 'เงินขาด', r: fmtMoney(Number(s.difference)), bold: true }] : []),
    { l: 'เปิดลิ้นชัก', r: `${sum.cash.drawerOpens} ครั้ง` }, { divider: true, l: '' }, { l: 'ลงชื่อ ______________________', center: true },
  ];
  const c = await renderReport('รายงานปิดกะ / Shift Report', rows, { paperWidth: printer.config?.paperWidth ?? 80, dpi: printer.config?.dpi ?? 203, fontFamily: ps?.receipt.customer.defaultStyle.fontFamily || 'Sarabun', storeName: ps?.store?.name });
  printer.enqueue({ saleId: null, kind: 'shift', build: async () => ({ bytes: receiptJob(c, { cut: 'partial', feedLines: 3 }), canvas: c }) });
}

export function OpenShiftModal({ onOpened, onClose }: { onOpened: (s: any) => void; onClose?: () => void }) {
  const [float, setFloat] = useState<number | null>(100000);
  const [err, setErr] = useState('');
  return (
    <Modal title="🔓 เปิดกะแคชเชียร์" onClose={onClose} width={420}
      footer={<button className="btn primary lg block" onClick={async () => { try { onOpened(await api('/api/shifts/open', { body: { openingFloat: float ?? 0 } })); } catch (e) { setErr(errMsg(e)); } }}>เปิดกะ</button>}>
      <Field label="เงินทอนเริ่มต้นในลิ้นชัก (บาท)"><MoneyInput value={float} onChange={setFloat} autoFocus style={{ fontSize: '1.4rem' }} /></Field>
      {err && <p className="err">{err}</p>}
    </Modal>
  );
}

export function ShiftModal({ summary, onChanged, onClosed, onClose }: { summary: any; onChanged: (s: any) => void; onClosed: (r: any) => void; onClose: () => void }) {
  const toast = useToast();
  const withApproval = useWithApproval();
  const [tab, setTab] = useState<'sum' | 'cash' | 'close'>('sum');
  const [amt, setAmt] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [handover, setHandover] = useState(false);
  const [hCode, setHCode] = useState('');
  const [hPin, setHPin] = useState('');
  const s = summary;

  const cashMove = async (type: 'pay_in' | 'pay_out') => {
    try {
      const r = await withApproval('pos.open_drawer', reason, (approvalId) => api(`/api/shifts/${s.shift.id}/cash`, { body: { type, amount: amt, reason, approvalId } }));
      if (r) { onChanged(r); openDrawer(); setAmt(null); setReason(''); toast('บันทึกแล้ว', 'ok'); }
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  const close = async () => {
    if (counted == null) return;
    try {
      const r = await api(`/api/shifts/${s.shift.id}/close`, { body: { countedCash: counted, note, handover: handover ? { employeeCode: hCode, pin: hPin } : undefined } });
      await printShiftReport(r);
      onClosed(r);
    } catch (e) { toast(errMsg(e), 'err'); }
  };

  return (
    <Modal title={`กะ #${s.shift.id} — ${s.shift.staff_name}`} onClose={onClose} width={640}>
      <div className="tabs">
        <button className={tab === 'sum' ? 'on' : ''} onClick={() => setTab('sum')}>สรุปกะ</button>
        <button className={tab === 'cash' ? 'on' : ''} onClick={() => setTab('cash')}>เงินเข้า–ออก</button>
        <button className={tab === 'close' ? 'on' : ''} onClick={() => setTab('close')}>ปิดกะ / ส่งมอบกะ</button>
      </div>
      {tab === 'sum' && (
        <div className="grid">
          <div className="grid g3">
            <div className="card kpi"><div className="l">บิล</div><div className="v">{s.totals.bills}</div></div>
            <div className="card kpi"><div className="l">ยอดขาย</div><div className="v">{fmtMoney(Number(s.totals.total))}</div></div>
            <div className="card kpi"><div className="l">เงินสดที่ควรมี</div><div className="v">{fmtMoney(s.cash.expected)}</div></div>
          </div>
          <table className="t"><tbody>
            {s.byMethod.map((m: any) => <tr key={m.method}><td>{PAYMENT_LABELS[m.method] || m.method}</td><td>{m.bills} บิล</td><td className="right num">{fmtMoney(Number(m.amount))}</td></tr>)}
            <tr><td>เงินทอนเริ่มต้น</td><td></td><td className="right num">{fmtMoney(s.cash.openingFloat)}</td></tr>
            <tr><td>นำเงินเข้า / ออก</td><td></td><td className="right num">+{fmtMoney(s.cash.payIn)} / -{fmtMoney(s.cash.payOut)}</td></tr>
            <tr><td>คืนเงินสด</td><td></td><td className="right num">-{fmtMoney(s.cash.refundCash)}</td></tr>
            <tr><td>เปิดลิ้นชัก</td><td></td><td className="right">{s.cash.drawerOpens} ครั้ง</td></tr>
          </tbody></table>
          <button className="btn" onClick={() => printShiftReport(s)}>🖨️ พิมพ์รายงาน X (ระหว่างกะ)</button>
        </div>
      )}
      {tab === 'cash' && (
        <div className="grid">
          <Field label="จำนวนเงิน"><MoneyInput value={amt} onChange={setAmt} /></Field>
          <Field label="เหตุผล"><input className="in" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="เช่น เติมเงินทอน / นำส่งเงินเข้าตู้เซฟ" /></Field>
          <div className="row"><button className="btn primary" disabled={!amt || reason.length < 2} onClick={() => cashMove('pay_in')}>+ นำเงินเข้า</button><button className="btn warn" disabled={!amt || reason.length < 2} onClick={() => cashMove('pay_out')}>− นำเงินออก</button></div>
          <table className="t"><tbody>{s.cashMovements.map((c: any) => <tr key={c.id}><td className="small">{fmtDate(c.created_at)}</td><td>{c.type}</td><td>{c.reason}{c.ref ? ` (${c.ref})` : ''}</td><td className="right num">{c.amount ? fmtMoney(Number(c.amount)) : ''}</td><td className="small muted">{c.staff_name}</td></tr>)}</tbody></table>
        </div>
      )}
      {tab === 'close' && (
        <div className="grid">
          <div className="banner info">เงินสดที่ควรมีในลิ้นชัก: <b>{fmtMoney(s.cash.expected)}</b></div>
          <Field label="นับเงินสดได้จริง (บาท)"><MoneyInput value={counted} onChange={setCounted} style={{ fontSize: '1.3rem' }} /></Field>
          {counted != null && <div className={counted - s.cash.expected === 0 ? 'ok' : 'err'}>{counted - s.cash.expected >= 0 ? 'เงินเกิน' : 'เงินขาด'} {fmtMoney(counted - s.cash.expected)}</div>}
          <Field label="หมายเหตุ"><input className="in" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <label className="check"><input type="checkbox" checked={handover} onChange={(e) => setHandover(e.target.checked)} /> ส่งมอบกะให้พนักงานคนถัดไป (ใช้เงินที่นับได้เป็นเงินทอนเริ่มต้น)</label>
          {handover && <div className="grid g2"><Field label="รหัสพนักงานผู้รับกะ"><input className="in" value={hCode} onChange={(e) => setHCode(e.target.value)} /></Field><Field label="PIN ผู้รับกะ"><input className="in" type="password" inputMode="numeric" value={hPin} onChange={(e) => setHPin(e.target.value)} /></Field></div>}
          <button className="btn danger lg" disabled={counted == null} onClick={close}>ปิดกะและพิมพ์รายงาน Z</button>
        </div>
      )}
    </Modal>
  );
}

// ---------------- Sales history / refund / void / reprint ----------------
export function SalesModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const withApproval = useWithApproval();
  const [q, setQ] = useState('');
  const [list, setList] = useState<any[]>([]);
  const [sel, setSel] = useState<any>(null);
  const [refundQty, setRefundQty] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const load = () => api(`/api/pos/sales?mine=1&q=${encodeURIComponent(q)}`).then(setList).catch((e) => toast(errMsg(e), 'err'));
  useEffect(() => { load(); }, []); // eslint-disable-line
  const open = async (id: number) => { setSel(await api(`/api/pos/sales/${id}/receipt`)); setRefundQty({}); };

  const reprint = async (only?: 'summary' | 'customer') => {
    try {
      const r = await withApproval('pos.reprint', 'พิมพ์ซ้ำ ' + sel.sale.billNo, (approvalId) => api(`/api/pos/sales/${sel.sale.id}/reprint`, { body: { approvalId, kind: only ?? 'both' } }));
      if (r) { const ps = printSettings(); printSaleReceipts(toReceiptData(r, ps?.store, ps?.tax, true), { only, force: true }); toast('ส่งพิมพ์ซ้ำแล้ว', 'ok'); }
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  const doRefund = async (type: 'refund' | 'void') => {
    if (reason.trim().length < 2) { toast('กรุณาระบุเหตุผล', 'warn'); return; }
    const items = type === 'refund' ? Object.entries(refundQty).filter(([, v]) => v > 0).map(([k, v]) => ({ saleItemId: Number(k), qty: v, restock })) : undefined;
    if (type === 'refund' && items && !items.length && !confirm('คืนเงินทั้งบิล?')) return;
    const key = uuid();
    try {
      const r = await withApproval(type === 'void' ? 'pos.void_bill' : 'pos.refund', `${type} ${sel.sale.billNo}`, (approvalId) => api(`/api/pos/sales/${sel.sale.id}/refund`, { body: { idempotencyKey: key, type, reason, items: items?.length ? items : undefined, restockAll: restock, method: 'cash', approvalId } }));
      if (r) {
        toast(`${type === 'void' ? 'ยกเลิกบิล' : 'คืนเงิน'}สำเร็จ ${fmtMoney(r.total)}${r.couponNotes?.length ? '\n' + r.couponNotes.join('\n') : ''}`, 'ok');
        openDrawer();
        await api('/api/shifts/drawer-open', { body: { reason: `${type} ${r.billNo}`, saleId: sel.sale.id } }).catch(() => {});
        open(sel.sale.id); load();
      }
    } catch (e) { toast(errMsg(e), 'err'); }
  };

  return (
    <Modal title="🧾 ประวัติบิล / คืนเงิน / พิมพ์ซ้ำ" onClose={onClose} width={900}>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div>
          <div className="row"><input className="in" style={{ flex: 1 }} placeholder="ค้นหาเลขบิล" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} /><button className="btn" onClick={load}>ค้นหา</button></div>
          <div className="table-wrap" style={{ maxHeight: 460, marginTop: 8 }}>
            <table className="t"><tbody>
              {list.map((s) => <tr key={s.id} onClick={() => open(s.id)} style={{ cursor: 'pointer', background: sel?.sale.id === s.id ? '#ecfdf5' : undefined }}><td className="mono small">{s.bill_no}<div className="xs muted">{fmtDate(s.created_at)}</div></td><td className="right num">{fmtMoney(s.total)}</td><td><span className={`badge ${s.status}`}>{s.status}</span></td></tr>)}
            </tbody></table>
          </div>
        </div>
        {sel && (
          <div className="grid">
            <div className="row between"><b className="mono">{sel.sale.billNo}</b><span className={`badge ${sel.sale.status}`}>{sel.sale.status}</span></div>
            <table className="t"><tbody>
              {sel.items.map((i: any) => (
                <tr key={i.id}><td>{i.name}<div className="xs muted">{fmtQty(i.qty, i.isWeighted)} × {fmtMoney(i.unitPrice)}</div></td><td className="right num">{fmtMoney(i.total)}</td>
                  <td style={{ width: 90 }}>{sel.sale.status !== 'refunded' && sel.sale.status !== 'voided' && <input className="in" type="number" min={0} step={i.isWeighted ? 0.001 : 1} max={i.qty} placeholder="คืน" value={refundQty[i.id] ?? ''} onChange={(e) => setRefundQty({ ...refundQty, [i.id]: Number(e.target.value) })} />}</td></tr>
              ))}
            </tbody></table>
            <div className="row between"><b>ยอดสุทธิ</b><b className="num">{fmtMoney(sel.sale.total)}</b></div>
            {sel.redeemedCoupons?.length > 0 && <div className="small">ใช้คูปอง: {sel.redeemedCoupons.map((c: any) => c.code).join(', ')}</div>}
            {sel.coupons?.length > 0 && <div className="small">ออกคูปอง: {sel.coupons.map((c: any) => `${c.code} (${c.status})`).join(', ')}</div>}
            <div className="row"><button className="btn" onClick={() => reprint()}>🖨️ พิมพ์ซ้ำทั้ง 2 ใบ</button><button className="btn sm" onClick={() => reprint('summary')}>ใบสรุป</button><button className="btn sm" onClick={() => reprint('customer')}>ใบลูกค้า</button></div>
            {sel.sale.status !== 'refunded' && sel.sale.status !== 'voided' && (
              <div className="card grid" style={{ background: '#fff7ed' }}>
                <Field label="เหตุผล (บันทึกใน Activity Log)"><input className="in" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> คืนสินค้าเข้าสต็อก (สภาพดี)</label>
                <div className="row"><button className="btn warn" onClick={() => doRefund('refund')}>↩ คืนเงิน/รับคืน</button><button className="btn danger" onClick={() => doRefund('void')}>✕ Void บิล</button></div>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------- Customer display pairing ----------------
export function DisplayModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<any>(null);
  const load = () => api('/api/pos/display/list').then(setInfo).catch(() => {});
  useEffect(() => { load(); }, []);
  return (
    <Modal title="🖥️ หน้าจอลูกค้า (Customer Display)" onClose={onClose} width={480}>
      <p className="small muted">เปิด <b>{location.origin}/display</b> บนจอที่สองหรือแท็บเล็ต แล้วกรอกรหัส 6 หลักที่แสดงบนจอนั้น</p>
      <div className="row"><input className="in mono" style={{ fontSize: '1.6rem', letterSpacing: '.3em', flex: 1 }} maxLength={6} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" />
        <button className="btn primary" disabled={code.length !== 6} onClick={async () => { try { await api('/api/pos/display/pair', { body: { code } }); toast('จับคู่หน้าจอสำเร็จ', 'ok'); setCode(''); load(); } catch (e) { toast(errMsg(e), 'err'); } }}>จับคู่</button></div>
      <Numpad onKey={(k) => setCode((v) => (k === '⌫' ? v.slice(0, -1) : (v + k).slice(0, 6)))} />
      <h3 style={{ marginTop: 12 }}>จอที่จับคู่แล้ว</h3>
      <table className="t"><tbody>
        {(info?.displays ?? []).map((d: any) => {
          const online = info?.presence?.displays?.some((x: any) => x.id === d.id);
          return <tr key={d.id}><td><span className={`dot ${online ? 'on' : 'off'}`} /> {d.name}</td><td className="small">{d.lang}</td><td className="small muted">{fmtDate(d.last_seen_at)}</td><td><button className="btn sm ghost" onClick={async () => { await api(`/api/pos/display/${d.id}/unpair`, { body: {} }); load(); }}>ยกเลิก</button></td></tr>;
        })}
      </tbody></table>
    </Modal>
  );
}

// ---------------- Weight entry for weighed goods ----------------
export function WeightModal({ product, onDone, onClose }: { product: any; onDone: (kg: number) => void; onClose: () => void }) {
  const [txt, setTxt] = useState('');
  const [live, setLive] = useState<{ kg: number; stable: boolean } | null>(scale.last);
  useEffect(() => { scale.poll(); return scale.on((w) => setLive(w)); }, []);
  const kg = txt ? Number(txt) : live?.kg ?? 0;
  return (
    <Modal title={`⚖️ ชั่งน้ำหนัก: ${product.name}`} onClose={onClose} width={420}
      footer={<button className="btn primary lg block" disabled={!(kg > 0)} onClick={() => onDone(Math.round(kg * 1000) / 1000)}>เพิ่ม {kg.toFixed(3)} กก. = {fmtMoney(Math.round(product.price * kg))}</button>}>
      {scale.connected ? <div className="banner info">เครื่องชั่ง: <b>{live ? `${live.kg.toFixed(3)} kg` : '—'}</b> {live && !live.stable && <span className="warn-t">(ยังไม่นิ่ง)</span>}</div> : <div className="banner warn small">ไม่ได้เชื่อมต่อเครื่องชั่ง — กรอกน้ำหนักเอง</div>}
      <input className="in num" style={{ fontSize: '1.6rem', margin: '8px 0' }} autoFocus placeholder="น้ำหนัก (กก.)" value={txt} onChange={(e) => setTxt(e.target.value.replace(/[^0-9.]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && kg > 0 && onDone(Math.round(kg * 1000) / 1000)} />
      <Numpad onKey={(k) => setTxt((v) => (k === '⌫' ? v.slice(0, -1) : k === '00' ? v + '.' : v + k))} />
      <p className="xs muted">ปุ่ม 00 = จุดทศนิยม · ราคา {fmtMoney(product.price)} / กก.</p>
    </Modal>
  );
}

// ---------------- Coupon confirm ----------------
export function CouponConfirm({ check, discount, onUse, onClose }: { check: any; discount: number | null; onUse: () => void; onClose: () => void }) {
  return (
    <Modal title={check.valid ? 'Coupon Valid ✓' : check.reason === 'USED' ? 'Coupon Used' : 'Coupon Invalid'} onClose={onClose} width={420}
      footer={check.valid ? <><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn primary lg" disabled={!discount} onClick={onUse} autoFocus>ใช้ Coupon</button></> : <button className="btn" onClick={onClose}>ปิด</button>}>
      <div className="center grid">
        <div className="mono" style={{ fontSize: '1.2rem' }}>{check.code}</div>
        {check.coupon && <BarcodeSvg value={check.coupon.barcodeValue} height={40} displayValue={false} />}
        {check.valid ? (
          <>
            <div style={{ fontSize: '1.1rem' }}>{check.coupon?.rewardText}</div>
            {discount ? <div className="ok" style={{ fontSize: '1.8rem', fontWeight: 800 }}>ส่วนลด {fmtMoney(discount)}</div> : <div className="err">{check.previewError || 'ยังไม่ตรงเงื่อนไขของคูปองในบิลนี้'}</div>}
            {check.coupon?.minSpend > 0 && <div className="small muted">เมื่อซื้อครบ {fmtMoney(check.coupon.minSpend)}</div>}
            <div className="small muted">ใช้ได้ถึง {fmtDate(check.coupon?.expiresAt, false)}</div>
          </>
        ) : <div className="err" style={{ whiteSpace: 'pre-line', fontSize: '1.1rem' }}>{check.message}</div>}
      </div>
    </Modal>
  );
}
