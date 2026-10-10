import { useState } from 'react';
import { api } from '../lib/api';
import { useApi, Modal, Field, useToast, errMsg } from '../components/ui';
import { fmtDate } from '../lib/format';

export default function Staff() {
  const toast = useToast();
  const [tab, setTab] = useState<'staff' | 'roles'>('staff');
  const { data: staff, reload } = useApi<any[]>('/api/admin/staff');
  const { data: roles, reload: rr } = useApi<any[]>('/api/admin/roles');
  const { data: perms } = useApi<Record<string, string>>('/api/admin/permissions');
  const { data: branches } = useApi<any[]>('/api/admin/branches');
  const [e, setE] = useState<any>(null);
  const [r, setR] = useState<any>(null);
  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>พนักงานและสิทธิ์</h1>
        {tab === 'staff' ? <button className="btn primary" onClick={() => setE({ employeeCode: '', name: '', roleId: roles?.find((x) => x.key === 'cashier')?.id, branchId: null, isActive: true, pin: '' })}>+ พนักงาน</button>
          : <button className="btn primary" onClick={() => setR({ key: '', name: '', permissions: [], maxDiscountPct: 0 })}>+ บทบาทใหม่</button>}</div>
      <div className="tabs"><button className={tab === 'staff' ? 'on' : ''} onClick={() => setTab('staff')}>พนักงาน</button><button className={tab === 'roles' ? 'on' : ''} onClick={() => setTab('roles')}>บทบาทและสิทธิ์</button></div>
      {tab === 'staff' && (
        <div className="table-wrap"><table className="t"><thead><tr><th>รหัส</th><th>ชื่อ</th><th>บทบาท</th><th>สาขา</th><th>สถานะ</th><th>ล็อก</th><th></th></tr></thead>
          <tbody>{(staff ?? []).map((s) => <tr key={s.id}><td className="mono">{s.employee_code}</td><td>{s.name}</td><td>{s.role_name}</td><td>{s.branch_name ?? 'ทุกสาขา'}</td><td><span className={`badge ${s.is_active ? 'ok' : ''}`}>{s.is_active ? 'ใช้งาน' : 'ปิด'}</span></td>
            <td className="small">{s.locked_until && new Date(s.locked_until) > new Date() ? <span className="err">ล็อกถึง {fmtDate(s.locked_until)} <button className="btn sm" onClick={async () => { await api(`/api/admin/staff/${s.id}/unlock`, { body: {} }); reload(); }}>ปลดล็อก</button></span> : s.failed_attempts ? `ผิด ${s.failed_attempts} ครั้ง` : ''}</td>
            <td><button className="btn sm" onClick={() => setE({ id: s.id, employeeCode: s.employee_code, name: s.name, roleId: s.role_id, branchId: s.branch_id, isActive: s.is_active, pin: '' })}>แก้ไข</button></td></tr>)}</tbody></table></div>
      )}
      {tab === 'roles' && (
        <div className="table-wrap"><table className="t"><thead><tr><th>บทบาท</th><th>สิทธิ์</th><th>ส่วนลดสูงสุด</th><th></th></tr></thead>
          <tbody>{(roles ?? []).map((x) => <tr key={x.id}><td><b>{x.name}</b><div className="xs muted">{x.key}{x.is_system ? ' · ระบบ' : ''}</div></td><td className="xs">{x.permissions.map((p: string) => perms?.[p] ?? p).join(' · ')}</td><td>{x.max_discount_pct}%</td>
            <td>{x.key !== 'owner' && <button className="btn sm" onClick={() => setR({ id: x.id, key: x.key, name: x.name, permissions: x.permissions, maxDiscountPct: Number(x.max_discount_pct) })}>แก้ไข</button>}{!x.is_system && <button className="btn sm ghost" onClick={async () => { await api(`/api/admin/roles/${x.id}`, { method: 'DELETE' }).catch((er) => toast(errMsg(er), 'err')); rr(); }}>ลบ</button>}</td></tr>)}</tbody></table></div>
      )}
      {e && (
        <Modal title={e.id ? 'แก้ไขพนักงาน' : 'เพิ่มพนักงาน'} onClose={() => setE(null)} footer={<button className="btn primary" onClick={async () => { try { await api('/api/admin/staff', { body: { ...e, roleId: Number(e.roleId), branchId: e.branchId ? Number(e.branchId) : null, pin: e.pin || undefined } }); toast('บันทึกแล้ว', 'ok'); setE(null); reload(); } catch (er) { toast(errMsg(er), 'err'); } }}>บันทึก</button>}>
          <div className="grid g2">
            <Field label="รหัสพนักงาน"><input className="in" value={e.employeeCode} onChange={(x) => setE({ ...e, employeeCode: x.target.value })} /></Field>
            <Field label="ชื่อ"><input className="in" value={e.name} onChange={(x) => setE({ ...e, name: x.target.value })} /></Field>
            <Field label="บทบาท"><select className="in" value={e.roleId} onChange={(x) => setE({ ...e, roleId: x.target.value })}>{roles?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="สาขา"><select className="in" value={e.branchId ?? ''} onChange={(x) => setE({ ...e, branchId: x.target.value || null })}><option value="">ทุกสาขา</option>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <Field label={e.id ? 'PIN ใหม่ (เว้นว่างถ้าไม่เปลี่ยน)' : 'PIN 4–6 หลัก'}><input className="in" type="password" inputMode="numeric" maxLength={6} value={e.pin} onChange={(x) => setE({ ...e, pin: x.target.value.replace(/\D/g, '') })} /></Field>
            <label className="check"><input type="checkbox" checked={e.isActive} onChange={(x) => setE({ ...e, isActive: x.target.checked })} /> ใช้งาน</label>
          </div>
        </Modal>
      )}
      {r && (
        <Modal title={r.id ? `แก้ไขบทบาท ${r.name}` : 'สร้างบทบาท'} onClose={() => setR(null)} width={720} footer={<button className="btn primary" onClick={async () => { try { await api('/api/admin/roles', { body: r }); setR(null); rr(); } catch (er) { toast(errMsg(er), 'err'); } }}>บันทึก</button>}>
          <div className="grid g3">
            <Field label="Key (a-z_)"><input className="in" disabled={!!r.id} value={r.key} onChange={(x) => setR({ ...r, key: x.target.value })} /></Field>
            <Field label="ชื่อบทบาท"><input className="in" value={r.name} onChange={(x) => setR({ ...r, name: x.target.value })} /></Field>
            <Field label="ส่วนลดสูงสุดโดยไม่ต้องอนุมัติ (%)"><input className="in" type="number" value={r.maxDiscountPct} onChange={(x) => setR({ ...r, maxDiscountPct: Number(x.target.value) })} /></Field>
          </div>
          <div className="grid g2" style={{ marginTop: 10 }}>
            {Object.entries(perms ?? {}).map(([k, v]) => <label key={k} className="check"><input type="checkbox" checked={r.permissions.includes(k)} onChange={(x) => setR({ ...r, permissions: x.target.checked ? [...r.permissions, k] : r.permissions.filter((p: string) => p !== k) })} /> {v} <span className="xs muted mono">{k}</span></label>)}
          </div>
          <p className="xs muted">รายการที่ไม่มีสิทธิ์ (ลดราคา คืนเงิน ยกเลิกบิล เปิดลิ้นชัก ฯลฯ) ทำได้เมื่อผู้จัดการกรอกรหัสและ PIN อนุมัติ และถูกบันทึกใน Activity Log</p>
        </Modal>
      )}
    </div>
  );
}
