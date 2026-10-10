import { useEffect, useState } from 'react';
import { Modal, errMsg, useToast, useWithApproval, Field, BarcodeSvg } from '../../components/ui';
import { IdentifyMethods, ProfileFields, emptyProfile, genderLabel, type IdentifyMethod, type RegisterProfile } from '../../components/MemberForms';
import { api, can } from '../../lib/api';
import { fmtDate, fmtMoney } from '../../lib/format';
import { printer } from '../../lib/printer';
import { receiptJob } from '../../lib/escpos';
import { renderMemberSlip } from '../../lib/receipt-render';
import { printSettings } from '../../lib/receipt-print';

export const memberSiteUrl = () => `${location.origin}/member`;

export async function identifyMember(method: IdentifyMethod, value: string) {
  return api('/api/pos/members/identify', { body: { method, value } });
}

/** Print the 80×80 mm member details slip with a QR code to the member website (only when the cashier presses print). */
export async function printMemberSlip(m: any) {
  const ps = printSettings();
  const canvas = await renderMemberSlip({
    storeName: ps?.store?.name ?? 'SUPERMARKET', name: `${m.first_name} ${m.last_name ?? ''}`.trim(), memberNo: m.member_no,
    phone: String(m.phone).replace(/^(\d{3})\d+(\d{3})$/, '$1-xxx-$2'), tier: m.tier_name, points: Number(m.points ?? 0), since: m.created_at,
    url: `${memberSiteUrl()}?id=${encodeURIComponent(m.member_no)}`, showPasswordHint: !m.has_password,
  }, { paperWidth: 80, dpi: printer.config?.dpi ?? 203, fontFamily: ps?.receipt.customer.defaultStyle.fontFamily || 'Sarabun' });
  printer.enqueue({ saleId: null, kind: 'member-slip', build: async () => ({ bytes: receiptJob(canvas, { cut: 'partial', feedLines: 2 }), canvas }) });
  return canvas;
}

// ---------------- Find / identify / register at the till ----------------
export function MemberModal({ onPick, onClose, onCustomerDisplay, displayOnline }: {
  onPick: (m: any) => void; onClose: () => void; onCustomerDisplay: (mode: 'identify' | 'register') => void; displayOnline: boolean;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<'identify' | 'search' | 'register'>('identify');
  const [q, setQ] = useState('');
  const [list, setList] = useState<any[]>([]);
  const [form, setForm] = useState<RegisterProfile>(emptyProfile());
  const [cardCode, setCardCode] = useState('');
  const search = async () => { try { setList(await api(`/api/pos/members/find?q=${encodeURIComponent(q)}`)); } catch (e) { toast(errMsg(e), 'err'); } };
  const identify = async (method: IdentifyMethod, value: string) => { try { onPick(await identifyMember(method, value)); } catch (e) { toast(errMsg(e), 'err'); } };
  const register = async () => {
    try {
      const m = await api('/api/members', { body: { ...form, gender: form.gender || null } });
      if (cardCode.trim()) await api(`/api/members/${m.id}/cards`, { body: { code: cardCode.trim(), kind: 'number' } }).catch((e) => toast('ผูกบัตรไม่สำเร็จ: ' + errMsg(e), 'warn'));
      toast('สมัครสมาชิกสำเร็จ ' + m.member_no, 'ok');
      onPick({ ...m, tier_name: 'Bronze', has_password: false });
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  return (
    <Modal title="👤 สมาชิก" onClose={onClose} width={640}>
      <div className="tabs">
        <button className={tab === 'identify' ? 'on' : ''} onClick={() => setTab('identify')}>ระบุสมาชิก</button>
        <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>ค้นหาชื่อ</button>
        <button className={tab === 'register' ? 'on' : ''} onClick={() => setTab('register')}>สมัครสมาชิกใหม่</button>
      </div>
      {tab === 'identify' && (
        <div className="grid">
          <IdentifyMethods lang="th" onSubmit={identify} />
          <button className="btn" disabled={!displayOnline} onClick={() => onCustomerDisplay('identify')}>🖥️ ให้ลูกค้าเลือกวิธีและกรอกเองที่จอลูกค้า{displayOnline ? '' : ' (จอลูกค้าออฟไลน์)'}</button>
        </div>
      )}
      {tab === 'search' && (
        <div className="grid">
          <div className="row"><input className="in" style={{ flex: 1 }} autoFocus placeholder="ชื่อ / เบอร์ / เลขสมาชิก / เลขบัตร" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} /><button className="btn primary" onClick={search}>ค้นหา</button></div>
          <table className="t"><tbody>
            {list.map((m) => <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => onPick(m)}><td><b>{m.first_name} {m.last_name}</b><div className="xs muted mono">{m.member_no} · {m.phone}</div></td><td>{m.tier_name}</td><td className="right">{m.points.toLocaleString()} pts</td></tr>)}
          </tbody></table>
        </div>
      )}
      {tab === 'register' && (
        <div className="grid">
          <ProfileFields v={form} set={(p) => setForm({ ...form, ...p })} lang="th" />
          <Field label="เลขบัตรสมาชิก (ถ้ามี — แตะ/สแกน/พิมพ์)"><input className="in mono" value={cardCode} onChange={(e) => setCardCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} /></Field>
          <p className="xs muted">รหัสผ่านเว็บไซต์สมาชิกครั้งแรกคือเลข 4 ตัวท้ายของเบอร์โทร (ระบบจะให้เปลี่ยนหลังเข้าสู่ระบบ)</p>
          <div className="row">
            <button className="btn primary" disabled={!form.firstName || form.phone.length < 9} onClick={register}>สมัครและใช้กับบิลนี้</button>
            <button className="btn" disabled={!displayOnline} onClick={() => onCustomerDisplay('register')}>🖥️ ให้ลูกค้าสมัครเองที่จอลูกค้า</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------- Member details (print slip, link card) ----------------
export function MemberDetailModal({ memberId, onClose, onRemove }: { memberId: number; onClose: () => void; onRemove: () => void }) {
  const toast = useToast();
  const withApproval = useWithApproval();
  const [m, setM] = useState<any>(null);
  const [cards, setCards] = useState<any[]>([]);
  const [linking, setLinking] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const load = async () => {
    try { setM(await api(`/api/members/${memberId}`)); setCards(await api(`/api/members/${memberId}/cards`)); } catch (e) { toast(errMsg(e), 'err'); }
  };
  useEffect(() => { load(); }, [memberId]); // eslint-disable-line
  if (!m) return <Modal title="สมาชิก" onClose={onClose}><div className="muted">กำลังโหลด…</div></Modal>;

  const link = async (method: IdentifyMethod, code: string) => {
    try {
      await api(`/api/members/${memberId}/cards`, { body: { code, kind: method === 'tap' ? 'rfid' : method === 'barcode' ? 'barcode' : 'number' } });
      toast('ซิงค์บัตรกับสมาชิกนี้แล้ว ✓', 'ok'); setLinking(false); load();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  const print = async () => { try { const c = await printMemberSlip(m); setPreview(c.toDataURL()); toast('ส่งพิมพ์รายละเอียดสมาชิกแล้ว', 'ok'); } catch (e) { toast(errMsg(e), 'err'); } };
  const resetPw = async () => {
    if (!confirm('รีเซ็ตรหัสผ่านเว็บไซต์สมาชิกเป็นเลข 4 ตัวท้ายเบอร์โทร?')) return;
    try { await api(`/api/members/${memberId}/reset-password`, { body: {} }); toast('รีเซ็ตรหัสผ่านแล้ว', 'ok'); load(); } catch (e) { toast(errMsg(e), 'err'); }
  };
  void withApproval;
  return (
    <Modal title={`👤 ${m.first_name} ${m.last_name ?? ''}`} onClose={onClose} width={720}
      footer={<><button className="btn danger" onClick={onRemove}>นำสมาชิกออกจากบิล</button><span className="spacer" /><button className="btn" onClick={() => setLinking(!linking)}>💳 ซิงค์/ผูกบัตรสมาชิก</button><button className="btn primary" onClick={print}>🖨️ พิมพ์รายละเอียดสมาชิก (80×80)</button></>}>
      <div className="grid g2" style={{ alignItems: 'start' }}>
        <div className="grid" style={{ gap: 6 }}>
          <div className="mono" style={{ fontSize: '1.2rem' }}>{m.member_no}</div>
          <BarcodeSvg value={m.member_no} height={40} displayValue={false} />
          <table className="t"><tbody>
            {[['ระดับ', m.tier_name], ['คะแนน', Number(m.points).toLocaleString()], ['ยอดซื้อสะสม', fmtMoney(Number(m.total_spend))], ['โทร', m.phone], ['วันเกิด', m.birthday ?? '-'], ['เพศ', genderLabel(m.gender)], ['สัญชาติ', m.nationality ?? '-'], ['ประเทศ', m.country ?? '-'], ['ที่อยู่', m.address ?? '-'], ['สมัครเมื่อ', fmtDate(m.created_at, false)], ['รหัสผ่านเว็บ', m.has_password ? 'ตั้งเองแล้ว' : 'ยังเป็น 4 ตัวท้ายเบอร์โทร']].map(([k, v]) => <tr key={k}><td className="muted small">{k}</td><td className="small">{v}</td></tr>)}
          </tbody></table>
          {can('pos.sell') && <button className="btn sm" onClick={resetPw}>รีเซ็ตรหัสผ่านเว็บไซต์สมาชิก</button>}
        </div>
        <div className="grid">
          <b>บัตรสมาชิกที่ผูกไว้ ({cards.length})</b>
          <table className="t"><tbody>{cards.map((c) => <tr key={c.code}><td className="mono small">{c.kind === 'rfid' ? '•••• ' + c.code.slice(-4) : c.code}</td><td className="small">{c.kind}</td><td className="small">{fmtDate(c.linked_at, false)}</td></tr>)}</tbody></table>
          {linking && (
            <div className="card" style={{ background: '#f0fdf4' }}>
              <p className="small">แตะ / สแกน / กรอกเลขบัตร แล้วบัตรนั้นจะเป็นของสมาชิกนี้</p>
              <IdentifyMethods lang="th" initial="tap" onSubmit={(meth, v) => link(meth, v)} />
            </div>
          )}
          {preview && <div className="paper-wrap"><img className="paper" src={preview} style={{ width: 300 }} /></div>}
        </div>
      </div>
    </Modal>
  );
}

// ---------------- Confirm a self-registration coming from the customer display ----------------
export function DisplayRegisterConfirm({ profile, onDone, onClose }: { profile: RegisterProfile & { cardCode?: string }; onDone: (m: any) => void; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<RegisterProfile & { cardCode?: string }>(profile);
  const save = async () => {
    try {
      const m = await api('/api/members', { body: { ...v, gender: v.gender || null } });
      if (v.cardCode) await api(`/api/members/${m.id}/cards`, { body: { code: v.cardCode, kind: 'number' } }).catch(() => {});
      onDone({ ...m, tier_name: 'Bronze', has_password: false });
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  return (
    <Modal title="📝 ลูกค้าสมัครสมาชิกจากจอลูกค้า — ตรวจสอบก่อนยืนยัน" onClose={onClose} width={640}
      footer={<><button className="btn" onClick={onClose}>ปฏิเสธ</button><button className="btn primary" onClick={save}>ยืนยันสมัครสมาชิก</button></>}>
      <ProfileFields v={v} set={(p) => setV({ ...v, ...p })} lang="th" />
    </Modal>
  );
}
