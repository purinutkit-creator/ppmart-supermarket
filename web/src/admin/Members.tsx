import { useState } from 'react';
import { api } from '../lib/api';
import { useApi, Modal, Field, MoneyInput, useToast, errMsg } from '../components/ui';
import { fmtMoney, fmtDate } from '../lib/format';
import { ExportBar } from '../components/ExportBar';

export default function Members() {
  const toast = useToast();
  const [tab, setTab] = useState<'list' | 'tiers' | 'points'>('list');
  const [q, setQ] = useState('');
  const { data: list, reload } = useApi<any[]>(`/api/members?q=${encodeURIComponent(q)}`, [q]);
  const { data: tiers, reload: rt } = useApi<any[]>('/api/members/tiers');
  const { data: settings, reload: rs } = useApi<any>('/api/admin/settings');
  const [detail, setDetail] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [tierEdit, setTierEdit] = useState<any>(null);
  const open = async (id: number) => setDetail(await api(`/api/members/${id}`));

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>สมาชิกและสะสมคะแนน</h1><button className="btn primary" onClick={() => setEdit({ firstName: '', lastName: '', phone: '', email: '', birthday: '' })}>+ สมัครสมาชิก</button></div>
      <div className="tabs">
        <button className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>สมาชิก</button>
        <button className={tab === 'tiers' ? 'on' : ''} onClick={() => setTab('tiers')}>ระดับสมาชิก (Tier)</button>
        <button className={tab === 'points' ? 'on' : ''} onClick={() => setTab('points')}>กติกาคะแนน</button>
      </div>
      {tab === 'list' && (
        <>
          <div className="row between"><input className="in" style={{ maxWidth: 360 }} placeholder="ค้นหาชื่อ / เบอร์ / เลขสมาชิก" value={q} onChange={(e) => setQ(e.target.value)} />
            <ExportBar rows={list ?? []} name="members" cols={[{ key: 'member_no', label: 'เลขสมาชิก' }, { key: 'first_name', label: 'ชื่อ' }, { key: 'last_name', label: 'นามสกุล' }, { key: 'phone', label: 'โทร' }, { key: 'email', label: 'อีเมล' }, { key: 'birthday', label: 'วันเกิด' }, { key: 'tier_name', label: 'Tier' }, { key: 'points', label: 'คะแนน' }, { key: 'total_spend', label: 'ยอดซื้อสะสม', get: (r) => (Number(r.total_spend) / 100).toFixed(2) }, { key: 'created_at', label: 'วันที่สมัคร', get: (r) => fmtDate(r.created_at, false) }]} /></div>
          <div className="table-wrap"><table className="t">
            <thead><tr><th>เลขสมาชิก</th><th>ชื่อ</th><th>โทร</th><th>Tier</th><th className="right">คะแนน</th><th className="right">ยอดซื้อสะสม</th><th className="right">ครั้ง</th><th>สมัครเมื่อ</th></tr></thead>
            <tbody>{(list ?? []).map((m) => <tr key={m.id} style={{ cursor: 'pointer' }} onClick={() => open(m.id)}><td className="mono small">{m.member_no}</td><td>{m.first_name} {m.last_name}</td><td>{m.phone}</td><td><span className="badge" style={{ background: m.tier_color, color: '#fff' }}>{m.tier_name}</span></td><td className="right num">{m.points.toLocaleString()}</td><td className="right num">{fmtMoney(Number(m.total_spend))}</td><td className="right">{m.visit_count}</td><td className="small">{fmtDate(m.created_at, false)}</td></tr>)}</tbody>
          </table></div>
        </>
      )}
      {tab === 'tiers' && (
        <div className="grid">
          <div className="row"><button className="btn primary" onClick={() => setTierEdit({ name: '', rank: (tiers?.length ?? 0) + 1, minSpend: 0, minPoints: 0, minVisits: 0, pointMultiplier: 1, discountPct: 0, color: '#888888', benefits: '' })}>+ เพิ่ม Tier</button>
            <button className="btn" onClick={async () => { const r = await api('/api/members/tiers/recalculate', { body: {} }); toast(`คำนวณ Tier ใหม่ ${r.members} คน`, 'ok'); reload(); }}>คำนวณระดับสมาชิกทั้งหมดใหม่</button></div>
          <table className="t"><thead><tr><th>ลำดับ</th><th>ชื่อ</th><th>เงื่อนไขเลื่อนระดับ</th><th>ตัวคูณคะแนน</th><th>ส่วนลด</th><th>สิทธิประโยชน์</th><th></th></tr></thead>
            <tbody>{(tiers ?? []).map((t) => <tr key={t.id}><td>{t.rank}</td><td><span className="badge" style={{ background: t.color, color: '#fff' }}>{t.name}</span></td><td className="small">ยอดซื้อ ≥ {fmtMoney(Number(t.min_spend))}{t.min_points ? ` · คะแนน ≥ ${t.min_points}` : ''}{t.min_visits ? ` · ซื้อ ≥ ${t.min_visits} ครั้ง` : ''}</td><td>×{t.point_multiplier}</td><td>{t.discount_pct}%</td><td className="small">{t.benefits}</td>
              <td><button className="btn sm" onClick={() => setTierEdit({ id: t.id, name: t.name, rank: t.rank, minSpend: Number(t.min_spend), minPoints: t.min_points, minVisits: t.min_visits, pointMultiplier: Number(t.point_multiplier), discountPct: Number(t.discount_pct), color: t.color, benefits: t.benefits })}>แก้ไข</button><button className="btn sm ghost" onClick={async () => { try { await api(`/api/members/tiers/${t.id}`, { method: 'DELETE' }); rt(); } catch (e) { toast(errMsg(e), 'err'); } }}>ลบ</button></td></tr>)}</tbody></table>
          <p className="xs muted">ระบบเลือก Tier สูงสุดที่ผ่านเงื่อนไขทุกข้อ (ยอดซื้อสะสม / คะแนน / จำนวนครั้ง) อัตโนมัติหลังการขายทุกครั้ง</p>
        </div>
      )}
      {tab === 'points' && settings && <PointsRules value={settings.points} onSave={async (v) => { await api('/api/admin/settings/points', { method: 'PUT', body: v }); toast('บันทึกแล้ว', 'ok'); rs(); }} />}

      {detail && (
        <Modal title={`${detail.first_name} ${detail.last_name ?? ''} — ${detail.member_no}`} onClose={() => setDetail(null)} width={860}
          footer={<><button className="btn" onClick={() => { setEdit({ id: detail.id, firstName: detail.first_name, lastName: detail.last_name, phone: detail.phone, email: detail.email ?? '', birthday: detail.birthday ?? '', isActive: detail.is_active, tierId: detail.tier_id }); }}>แก้ไขข้อมูล</button>
            <button className="btn" onClick={async () => { const p = prompt('ปรับคะแนน (+/-)'); const r = p && prompt('เหตุผล'); if (p && r) { try { await api(`/api/members/${detail.id}/points`, { body: { points: Number(p), reason: r } }); open(detail.id); reload(); } catch (e) { toast(errMsg(e), 'err'); } } }}>ปรับคะแนน</button>
            <button className="btn" onClick={async () => { const v = prompt('มูลค่าคูปองสมาชิก (บาท)', '50'); if (!v) return; try { const c = await api(`/api/members/${detail.id}/coupons`, { body: { title: 'MEMBER COUPON', reward: { type: 'amount', value: Math.round(Number(v) * 100) }, minSpend: 0, validDays: 30 } }); toast('ออกคูปอง ' + c.code, 'ok'); open(detail.id); } catch (e) { toast(errMsg(e), 'err'); } }}>ออกคูปองสมาชิก</button></>}>
          <div className="grid g4">
            <div className="card kpi"><div className="l">Tier</div><div className="v">{detail.tier_name}</div></div>
            <div className="card kpi"><div className="l">คะแนน</div><div className="v">{detail.points.toLocaleString()}</div></div>
            <div className="card kpi"><div className="l">ยอดซื้อสะสม</div><div className="v">{fmtMoney(Number(detail.total_spend))}</div></div>
            <div className="card kpi"><div className="l">จำนวนครั้ง</div><div className="v">{detail.visit_count}</div></div>
          </div>
          <p className="small">โทร {detail.phone} · {detail.email} · วันเกิด {detail.birthday ?? '-'} · สมัคร {fmtDate(detail.created_at, false)}</p>
          <div className="grid g2">
            <div><h3>ประวัติการซื้อ</h3><table className="t"><tbody>{detail.sales.map((s: any) => <tr key={s.id}><td className="small">{fmtDate(s.created_at)}</td><td className="mono small">{s.bill_no}</td><td className="right">{fmtMoney(s.total)}</td><td className="small ok">+{s.points_earned}</td></tr>)}</tbody></table></div>
            <div><h3>ประวัติคะแนน</h3><table className="t"><tbody>{detail.ledger.map((l: any) => <tr key={l.id}><td className="small">{fmtDate(l.created_at)}</td><td className="small">{l.note}</td><td className={`right ${l.points > 0 ? 'ok' : 'err'}`}>{l.points}</td><td className="xs muted">{l.expires_at ? 'หมด ' + fmtDate(l.expires_at, false) : ''}</td></tr>)}</tbody></table>
              <h3>คูปองสมาชิก</h3><table className="t"><tbody>{detail.coupons.map((c: any) => <tr key={c.id}><td className="mono small">{c.code}</td><td className="small">{c.rewardText}</td><td><span className={`badge ${c.status}`}>{c.status}</span></td></tr>)}</tbody></table></div>
          </div>
        </Modal>
      )}
      {edit && (
        <Modal title={edit.id ? 'แก้ไขสมาชิก' : 'สมัครสมาชิก'} onClose={() => setEdit(null)} footer={<button className="btn primary" onClick={async () => { try { if (edit.id) await api(`/api/members/${edit.id}`, { method: 'PUT', body: edit }); else await api('/api/members', { body: edit }); toast('บันทึกแล้ว', 'ok'); setEdit(null); reload(); if (detail) open(detail.id); } catch (e) { toast(errMsg(e), 'err'); } }}>บันทึก</button>}>
          <div className="grid g2">
            <Field label="ชื่อ"><input className="in" value={edit.firstName} onChange={(e) => setEdit({ ...edit, firstName: e.target.value })} /></Field>
            <Field label="นามสกุล"><input className="in" value={edit.lastName ?? ''} onChange={(e) => setEdit({ ...edit, lastName: e.target.value })} /></Field>
            <Field label="เบอร์โทร"><input className="in" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label="อีเมล"><input className="in" value={edit.email ?? ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
            <Field label="วันเกิด"><input className="in" type="date" value={edit.birthday ?? ''} onChange={(e) => setEdit({ ...edit, birthday: e.target.value })} /></Field>
            {edit.id && <Field label="Tier (กำหนดเอง)"><select className="in" value={edit.tierId ?? ''} onChange={(e) => setEdit({ ...edit, tierId: Number(e.target.value) })}>{tiers?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
            {edit.id && <label className="check"><input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> ใช้งาน</label>}
          </div>
        </Modal>
      )}
      {tierEdit && (
        <Modal title={tierEdit.id ? 'แก้ไข Tier' : 'เพิ่ม Tier'} onClose={() => setTierEdit(null)} footer={<button className="btn primary" onClick={async () => { try { await api('/api/members/tiers', { body: tierEdit }); setTierEdit(null); rt(); } catch (e) { toast(errMsg(e), 'err'); } }}>บันทึก</button>}>
          <div className="grid g2">
            <Field label="ชื่อ Tier"><input className="in" value={tierEdit.name} onChange={(e) => setTierEdit({ ...tierEdit, name: e.target.value })} /></Field>
            <Field label="ลำดับ (สูง = ระดับสูง)"><input className="in" type="number" value={tierEdit.rank} onChange={(e) => setTierEdit({ ...tierEdit, rank: Number(e.target.value) })} /></Field>
            <Field label="ยอดซื้อสะสมขั้นต่ำ"><MoneyInput value={tierEdit.minSpend} onChange={(v) => setTierEdit({ ...tierEdit, minSpend: v ?? 0 })} /></Field>
            <Field label="คะแนนขั้นต่ำ"><input className="in" type="number" value={tierEdit.minPoints} onChange={(e) => setTierEdit({ ...tierEdit, minPoints: Number(e.target.value) })} /></Field>
            <Field label="จำนวนครั้งที่ซื้อขั้นต่ำ"><input className="in" type="number" value={tierEdit.minVisits} onChange={(e) => setTierEdit({ ...tierEdit, minVisits: Number(e.target.value) })} /></Field>
            <Field label="ตัวคูณคะแนน"><input className="in" type="number" step="0.1" value={tierEdit.pointMultiplier} onChange={(e) => setTierEdit({ ...tierEdit, pointMultiplier: Number(e.target.value) })} /></Field>
            <Field label="ส่วนลดทุกบิล (%)"><input className="in" type="number" value={tierEdit.discountPct} onChange={(e) => setTierEdit({ ...tierEdit, discountPct: Number(e.target.value) })} /></Field>
            <Field label="สี"><input className="in" type="color" value={tierEdit.color} onChange={(e) => setTierEdit({ ...tierEdit, color: e.target.value })} /></Field>
            <Field label="สิทธิประโยชน์"><input className="in" value={tierEdit.benefits ?? ''} onChange={(e) => setTierEdit({ ...tierEdit, benefits: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PointsRules({ value, onSave }: { value: any; onSave: (v: any) => void }) {
  const [v, setV] = useState(value);
  return (
    <div className="card grid g3">
      <label className="check"><input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> เปิดระบบสะสมคะแนน</label>
      <Field label="ยอดซื้อต่อ 1 คะแนน (บาท)"><MoneyInput value={v.spendPerPoint} onChange={(x) => setV({ ...v, spendPerPoint: x ?? 100 })} /></Field>
      <Field label="มูลค่า 1 คะแนนเมื่อแลก (บาท)"><MoneyInput value={v.pointValue} onChange={(x) => setV({ ...v, pointValue: x ?? 0 })} /></Field>
      <Field label="แลกขั้นต่ำ (คะแนน)"><input className="in" type="number" value={v.minRedeem} onChange={(e) => setV({ ...v, minRedeem: Number(e.target.value) })} /></Field>
      <Field label="คะแนนหมดอายุ (เดือน, 0 = ไม่หมดอายุ)"><input className="in" type="number" value={v.expiryMonths} onChange={(e) => setV({ ...v, expiryMonths: Number(e.target.value) })} /></Field>
      <div style={{ alignSelf: 'end' }}><button className="btn primary" onClick={() => onSave(v)}>บันทึก</button></div>
    </div>
  );
}
