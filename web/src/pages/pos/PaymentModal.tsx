import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Numpad, QrCanvas, errMsg, useToast } from '../../components/ui';
import { api, can } from '../../lib/api';
import { fmtMoney } from '../../lib/format';
import type { RealtimeClient } from '../../lib/ws';
import { PAYMENT_LABELS } from '../../../../shared/receipt';

export interface Tender {
  method: 'cash' | 'promptpay' | 'transfer' | 'credit_card' | 'debit_card' | 'ewallet' | 'gift_card';
  amount: number;
  received?: number | null;
  reference?: string | null;
  paymentIntentId?: string | null;
  giftCardCode?: string | null;
}

const METHODS: Tender['method'][] = ['cash', 'promptpay', 'transfer', 'credit_card', 'debit_card', 'ewallet', 'gift_card'];

export function PaymentModal({ total, online, offlineMethods, cartId, ws, onDisplay, onComplete, onClose }: {
  total: number; online: boolean; offlineMethods: string[]; cartId: string; ws: RealtimeClient | null;
  onDisplay: (payment: any) => void; onComplete: (tenders: Tender[]) => Promise<void>; onClose: () => void;
}) {
  const toast = useToast();
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [method, setMethod] = useState<Tender['method']>('cash');
  const paid = tenders.reduce((a, t) => a + t.amount, 0);
  const remaining = total - paid;
  const [amountTxt, setAmountTxt] = useState('');
  const [busy, setBusy] = useState(false);
  const [intent, setIntent] = useState<any>(null);
  const [ref, setRef] = useState('');
  const [gift, setGift] = useState('');
  const [giftBal, setGiftBal] = useState<number | null>(null);
  const intentRef = useRef<any>(null);
  intentRef.current = intent;

  const received = amountTxt === '' ? remaining : Math.round(Number(amountTxt) * 100);
  const cashChange = method === 'cash' ? Math.max(0, received - remaining) : 0;

  useEffect(() => { onDisplay({ status: 'payment', method, amount: remaining, received: method === 'cash' ? received : null, change: cashChange, qrPayload: intent?.qr_payload, qrImageUrl: intent?.qr_image_url }); }, [method, remaining, received, intent]); // eslint-disable-line

  // live intent status updates (webhook → server → WS), with polling fallback
  useEffect(() => {
    if (!intent || intent.status === 'paid') return;
    const off = ws?.on('payment.updated', (p) => { if (p.id === intentRef.current?.id) setIntent((i: any) => ({ ...i, ...p })); });
    const iv = setInterval(async () => { try { const r = await api(`/api/payments/intents/${intentRef.current.id}`); setIntent(r); } catch { /* ignore */ } }, 3000);
    return () => { off?.(); clearInterval(iv); };
  }, [intent?.id, intent?.status, ws]); // eslint-disable-line

  useEffect(() => {
    if (intent?.status === 'paid') {
      setTenders((t) => t.some((x) => x.paymentIntentId === intent.id) ? t : [...t, { method: intent.method, amount: Number(intent.amount), paymentIntentId: intent.id, reference: intent.reference }]);
      toast('ยืนยันการชำระเงินแล้ว ✓', 'ok');
      setIntent(null);
    } else if (intent && ['failed', 'expired', 'cancelled'].includes(intent.status)) {
      toast('การชำระเงินไม่สำเร็จ: ' + intent.status, 'err');
      setIntent(null);
    }
  }, [intent?.status]); // eslint-disable-line

  const amountFor = () => Math.min(remaining, amountTxt === '' ? remaining : Math.round(Number(amountTxt) * 100));

  const addTender = async () => {
    if (remaining <= 0) return;
    if (!online && !offlineMethods.includes(method)) { toast('โหมดออฟไลน์รับได้เฉพาะเงินสด', 'err'); return; }
    if (method === 'cash') {
      if (received < remaining && amountTxt !== '') {
        setTenders([...tenders, { method: 'cash', amount: received, received }]);
      } else setTenders([...tenders, { method: 'cash', amount: remaining, received }]);
      setAmountTxt('');
      return;
    }
    const amt = amountFor();
    if (amt <= 0) return;
    if (method === 'credit_card' || method === 'debit_card') {
      if (ref.trim().length < 4) { toast('กรอกเลขอนุมัติ (Approval code) จากเครื่อง EDC', 'warn'); return; }
      setTenders([...tenders, { method, amount: amt, reference: ref.trim() }]);
      setRef(''); setAmountTxt('');
      return;
    }
    if (method === 'gift_card') {
      if (giftBal == null) { toast('กรุณาตรวจสอบยอดบัตรของขวัญก่อน', 'warn'); return; }
      const use = Math.min(amt, giftBal);
      setTenders([...tenders, { method, amount: use, giftCardCode: gift.trim().toUpperCase(), reference: gift.trim().toUpperCase() }]);
      setGift(''); setGiftBal(null); setAmountTxt('');
      return;
    }
    // promptpay / transfer / ewallet → payment intent that must be verified by gateway webhook or staff
    setBusy(true);
    try { setIntent(await api('/api/payments/intents', { body: { method, amount: amt, cartId } })); } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };

  const attachSlip = async (file?: File) => {
    if (!intent) return;
    let image: string | undefined;
    if (file) image = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(file); });
    try { setIntent(await api(`/api/payments/intents/${intent.id}/slip`, { body: { image, reference: ref || undefined } })); toast('ส่งให้พนักงานตรวจสอบแล้ว (ยังไม่ถือว่าชำระสำเร็จ)', 'warn'); } catch (e) { toast(errMsg(e), 'err'); }
  };
  const verifyHere = async () => {
    if (!ref.trim()) { toast('กรอกเลขอ้างอิงที่ตรวจสอบจากแอปธนาคาร/บัญชี', 'warn'); return; }
    try { setIntent(await api(`/api/payments/intents/${intent.id}/verify`, { body: { approve: true, reference: ref.trim() } })); } catch (e) { toast(errMsg(e), 'err'); }
  };
  const cancelIntent = async () => { if (intent) await api(`/api/payments/intents/${intent.id}/cancel`, { body: {} }).catch(() => {}); setIntent(null); };

  const finish = async () => {
    setBusy(true);
    try { await onComplete(tenders); } finally { setBusy(false); }
  };

  const quick = useMemo(() => {
    const r = remaining / 100;
    const set = new Set<number>([Math.ceil(r), Math.ceil(r / 20) * 20, Math.ceil(r / 100) * 100, Math.ceil(r / 500) * 500, Math.ceil(r / 1000) * 1000]);
    return [...set].filter((v) => v >= r).slice(0, 5);
  }, [remaining]);

  // keyboard: Enter = add tender / finish
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !(e.target as HTMLElement).closest('input')) {
        e.preventDefault();
        if (remaining <= 0) finish(); else if (!intent) addTender();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  return (
    <Modal title="💳 ชำระเงิน" onClose={busy || tenders.length ? undefined : onClose} width={760}
      footer={<>
        <button className="btn" disabled={busy || !!intent} onClick={() => { if (tenders.length && !confirm('ยกเลิกการรับชำระทั้งหมด?')) return; onClose(); }}>ยกเลิก</button>
        <button className="btn primary lg" disabled={busy || remaining > 0} onClick={finish}>✔ ยืนยันชำระเงิน (Enter)</button>
      </>}>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="grid">
          <div className="totals">
            <div className="r"><span>ยอดสุทธิ</span><span className="num">{fmtMoney(total)}</span></div>
            <div className="r"><span>ชำระแล้ว</span><span className="num">{fmtMoney(paid)}</span></div>
            <div className="grand num">{fmtMoney(Math.max(0, remaining))}</div>
            <div className="small" style={{ opacity: .8 }}>คงเหลือที่ต้องชำระ</div>
            {method === 'cash' && remaining > 0 && <div className="r" style={{ marginTop: 8, fontSize: '1.3rem' }}><span>เงินทอน</span><b className="num">{fmtMoney(cashChange)}</b></div>}
          </div>
          {tenders.length > 0 && (
            <table className="t"><tbody>
              {tenders.map((t, i) => (
                <tr key={i}><td>{PAYMENT_LABELS[t.method]}{t.reference ? <div className="xs muted">{t.reference}</div> : null}</td><td className="right num">{fmtMoney(t.amount)}{t.method === 'cash' && t.received ? <div className="xs muted">รับ {fmtMoney(t.received)}</div> : null}</td>
                  <td>{!t.paymentIntentId && !t.giftCardCode && <button className="btn sm ghost" onClick={() => setTenders(tenders.filter((_, j) => j !== i))}>✕</button>}</td></tr>
              ))}
            </tbody></table>
          )}
          {!online && <div className="banner offline">ออฟไลน์ — รับได้เฉพาะ: {offlineMethods.map((m) => PAYMENT_LABELS[m]).join(', ')} (จะซิงก์อัตโนมัติเมื่อกลับมาออนไลน์)</div>}
        </div>
        <div className="grid">
          <div className="row">
            {METHODS.map((m) => <button key={m} className={`btn sm ${method === m ? 'primary' : ''}`} disabled={!!intent || (!online && !offlineMethods.includes(m))} onClick={() => { setMethod(m); setAmountTxt(''); }}>{PAYMENT_LABELS[m]}</button>)}
          </div>
          {intent ? (
            <div className="card center">
              {intent.qr_payload && <><QrCanvas value={intent.qr_payload} size={220} /><div className="small muted">PromptPay QR (ระบุยอด {fmtMoney(Number(intent.amount))})</div></>}
              {intent.qr_image_url && <img src={intent.qr_image_url} style={{ width: 220 }} />}
              <div style={{ margin: '8px 0' }}>สถานะ: <span className={`badge ${intent.status}`}>{intent.status}</span></div>
              {intent.provider === 'omise' ? <p className="small muted">รอการยืนยันจาก Payment Gateway อัตโนมัติ (Webhook)</p> : (
                <div className="grid">
                  <p className="small muted">ไม่มีการยืนยันอัตโนมัติ: ต้องตรวจสอบยอดเงินเข้าจริงในบัญชี/แอปธนาคาร — <b>ห้ามยืนยันจากภาพสลิปเพียงอย่างเดียว</b></p>
                  <input className="in" placeholder="เลขอ้างอิงธุรกรรม (จากแอปธนาคาร)" value={ref} onChange={(e) => setRef(e.target.value)} />
                  <div className="row">
                    <label className="btn sm">📎 แนบสลิป<input type="file" accept="image/*" hidden onChange={(e) => attachSlip(e.target.files?.[0])} /></label>
                    <button className="btn sm" onClick={() => attachSlip()}>ส่งให้หัวหน้าตรวจสอบ</button>
                    {can('payments.verify') && <button className="btn sm primary" onClick={verifyHere}>✔ ตรวจสอบแล้ว ยอดเข้าจริง</button>}
                  </div>
                </div>
              )}
              <button className="btn sm ghost" onClick={cancelIntent}>ยกเลิกรายการนี้</button>
            </div>
          ) : remaining > 0 ? (
            <>
              <input className="in num" style={{ fontSize: '1.4rem' }} placeholder={`จำนวนเงิน (${(remaining / 100).toFixed(2)})`} value={amountTxt} onChange={(e) => setAmountTxt(e.target.value.replace(/[^0-9.]/g, ''))} autoFocus />
              {method === 'cash' && <div className="row">{quick.map((v) => <button key={v} className="btn" onClick={() => setAmountTxt(String(v))}>{v.toLocaleString()}</button>)}</div>}
              {(method === 'credit_card' || method === 'debit_card') && <input className="in" placeholder="Approval code จากเครื่อง EDC" value={ref} onChange={(e) => setRef(e.target.value)} />}
              {method === 'gift_card' && (
                <div className="row">
                  <input className="in" style={{ flex: 1 }} placeholder="รหัสบัตรของขวัญ GC-..." value={gift} onChange={(e) => { setGift(e.target.value); setGiftBal(null); }} />
                  <button className="btn" onClick={async () => { try { const g = await api(`/api/marketing/gift-cards/${encodeURIComponent(gift.trim())}`); if (g.status !== 'active') throw new Error('บัตรถูกระงับ'); setGiftBal(Number(g.balance)); } catch (e) { toast(errMsg(e), 'err'); } }}>ตรวจสอบ</button>
                </div>
              )}
              {giftBal != null && <div className="small ok">ยอดคงเหลือบัตร {fmtMoney(giftBal)}</div>}
              <Numpad onKey={(k) => setAmountTxt((v) => (k === '⌫' ? v.slice(0, -1) : v + k))} />
              <button className="btn primary lg" disabled={busy} onClick={addTender}>+ รับชำระ {PAYMENT_LABELS[method]}</button>
            </>
          ) : <div className="banner info center" style={{ fontSize: '1.2rem' }}>ชำระครบแล้ว — กด “ยืนยันชำระเงิน”</div>}
        </div>
      </div>
    </Modal>
  );
}
