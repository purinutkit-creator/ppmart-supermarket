import { useEffect, useState } from 'react';
import { api, getSession } from '../lib/api';
import { useApi, Field, useToast, errMsg, Modal } from '../components/ui';
import { listFonts, loadFont } from '../lib/fonts';
import { fmtDate } from '../lib/format';

const fileToDataUrl = (f: File) => new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsDataURL(f); });

export default function Settings() {
  const toast = useToast();
  const { data, reload } = useApi<any>('/api/admin/settings');
  const [tab, setTab] = useState('store');
  const [s, setS] = useState<any>(null);
  useEffect(() => { if (data) setS(structuredClone(data)); }, [data]);
  if (!s) return <div className="muted">กำลังโหลด…</div>;
  const save = async (key: string) => { try { await api(`/api/admin/settings/${key}`, { method: 'PUT', body: s[key] }); toast('บันทึกแล้ว', 'ok'); reload(); } catch (e) { toast(errMsg(e), 'err'); } };
  const up = (key: string, patch: any) => setS({ ...s, [key]: { ...s[key], ...patch } });

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>ตั้งค่าระบบ</h1></div>
      <div className="tabs">{[['store', 'ร้านค้า'], ['tax', 'ภาษี'], ['pos', 'POS'], ['branches', 'สาขาและเครื่อง POS'], ['fonts', 'ฟอนต์'], ['display', 'Customer Display'], ['shop', '🛒 เว็บไซต์สั่งของ'], ['receipt', 'การพิมพ์ใบเสร็จ'], ['backup', 'สำรอง/กู้คืนข้อมูล']].map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>

      {tab === 'store' && (
        <div className="card grid g3">
          <Field label="ชื่อร้าน"><input className="in" value={s.store.name} onChange={(e) => up('store', { name: e.target.value })} /></Field>
          <Field label="ชื่อร้าน (EN)"><input className="in" value={s.store.nameEn ?? ''} onChange={(e) => up('store', { nameEn: e.target.value })} /></Field>
          <Field label="เลขประจำตัวผู้เสียภาษี"><input className="in" value={s.store.taxId ?? ''} onChange={(e) => up('store', { taxId: e.target.value })} /></Field>
          <Field label="ที่อยู่"><input className="in" value={s.store.address ?? ''} onChange={(e) => up('store', { address: e.target.value })} /></Field>
          <Field label="โทรศัพท์"><input className="in" value={s.store.phone ?? ''} onChange={(e) => up('store', { phone: e.target.value })} /></Field>
          <Field label="หมายเลขพร้อมเพย์ร้าน (สำหรับ QR)"><input className="in" value={s.store.promptPayId ?? ''} onChange={(e) => up('store', { promptPayId: e.target.value })} /></Field>
          <Field label="สกุลเงิน"><input className="in" value={s.store.currency} onChange={(e) => up('store', { currency: e.target.value })} /></Field>
          <Field label="สัญลักษณ์สกุลเงิน"><input className="in" value={s.store.currencySymbol} onChange={(e) => up('store', { currencySymbol: e.target.value })} /></Field>
          <Field label="Time zone"><input className="in" value={s.store.timeZone} onChange={(e) => up('store', { timeZone: e.target.value })} /></Field>
          <Field label="โลโก้ร้าน (ใช้บนใบเสร็จ/จอลูกค้า)"><input type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) up('store', { logo: await fileToDataUrl(f) }); }} /></Field>
          <div>{s.store.logo && <><img src={s.store.logo} style={{ height: 70 }} /><button className="btn sm ghost" onClick={() => up('store', { logo: null })}>ลบโลโก้</button></>}</div>
          <div style={{ alignSelf: 'end' }}><button className="btn primary" onClick={() => save('store')}>บันทึก</button></div>
        </div>
      )}
      {tab === 'tax' && (
        <div className="card grid g3">
          <Field label="รูปแบบ VAT"><select className="in" value={s.tax.mode} onChange={(e) => up('tax', { mode: e.target.value })}><option value="inclusive">ราคารวม VAT แล้ว</option><option value="exclusive">บวก VAT เพิ่มจากราคา</option><option value="none">ไม่คิด VAT</option></select></Field>
          <Field label="อัตรา VAT (%)"><input className="in" type="number" value={s.tax.rate} onChange={(e) => up('tax', { rate: Number(e.target.value) })} /></Field>
          <div style={{ alignSelf: 'end' }}><button className="btn primary" onClick={() => save('tax')}>บันทึก</button></div>
        </div>
      )}
      {tab === 'pos' && (
        <div className="card grid g3">
          <Field label="ล็อกหน้าจออัตโนมัติ (นาที, 0 = ปิด)"><input className="in" type="number" value={s.pos.autoLockMinutes} onChange={(e) => up('pos', { autoLockMinutes: Number(e.target.value) })} /></Field>
          <label className="check"><input type="checkbox" checked={s.pos.requireShift} onChange={(e) => up('pos', { requireShift: e.target.checked })} /> ต้องเปิดกะก่อนขาย</label>
          <label className="check"><input type="checkbox" checked={s.pos.allowNegativeStock} onChange={(e) => up('pos', { allowNegativeStock: e.target.checked })} /> อนุญาตขายเมื่อสต็อกไม่พอ</label>
          <Field label="Prefix บาร์โค้ดเครื่องชั่ง (คั่นด้วย ,)"><input className="in" value={s.pos.weightedBarcode.prefixes.join(',')} onChange={(e) => up('pos', { weightedBarcode: { ...s.pos.weightedBarcode, prefixes: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} /></Field>
          <Field label="จำนวนหลักรหัสสินค้า (PLU)"><input className="in" type="number" value={s.pos.weightedBarcode.itemDigits} onChange={(e) => up('pos', { weightedBarcode: { ...s.pos.weightedBarcode, itemDigits: Number(e.target.value) } })} /></Field>
          <Field label="ค่าที่ฝังในบาร์โค้ด"><select className="in" value={s.pos.weightedBarcode.mode} onChange={(e) => up('pos', { weightedBarcode: { ...s.pos.weightedBarcode, mode: e.target.value } })}><option value="weight">น้ำหนัก (กรัม)</option><option value="price">ราคา (สตางค์)</option></select></Field>
          <div style={{ alignSelf: 'end' }}><button className="btn primary" onClick={() => save('pos')}>บันทึก</button></div>
        </div>
      )}
      {tab === 'branches' && <Branches />}
      {tab === 'fonts' && <Fonts settings={s} setSettings={setS} onSave={() => save('fonts')} />}
      {tab === 'display' && (
        <div className="card grid g3">
          <Field label="สีหลัก"><input className="in" type="color" value={s.display.primaryColor} onChange={(e) => up('display', { primaryColor: e.target.value })} /></Field>
          <Field label="สีเน้น"><input className="in" type="color" value={s.display.accentColor} onChange={(e) => up('display', { accentColor: e.target.value })} /></Field>
          <Field label="สีพื้นหลัง"><input className="in" type="color" value={s.display.bgColor} onChange={(e) => up('display', { bgColor: e.target.value })} /></Field>
          <Field label="ฟอนต์จอลูกค้า"><input className="in" value={s.display.font} onChange={(e) => up('display', { font: e.target.value })} /></Field>
          <Field label="เปลี่ยนสไลด์ทุก (วินาที)"><input className="in" type="number" value={s.display.slideSeconds} onChange={(e) => up('display', { slideSeconds: Number(e.target.value) })} /></Field>
          <Field label="แสดงข้อความขอบคุณ (วินาที)"><input className="in" type="number" value={s.display.thankYouSeconds} onChange={(e) => up('display', { thankYouSeconds: Number(e.target.value) })} /></Field>
          <Field label="ภาพพื้นหลัง"><input type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) up('display', { background: await fileToDataUrl(f) }); }} /></Field>
          <Field label="รูปโปรโมชั่น (หลายรูป)"><input type="file" accept="image/*" multiple onChange={async (e) => { const fs = [...(e.target.files ?? [])]; const urls = await Promise.all(fs.map(fileToDataUrl)); up('display', { promoImages: [...(s.display.promoImages ?? []), ...urls] }); }} /></Field>
          <div className="row" style={{ gridColumn: '1/-1' }}>{(s.display.promoImages ?? []).map((u: string, i: number) => <div key={i} style={{ position: 'relative' }}><img src={u} style={{ height: 70, borderRadius: 6 }} /><button className="btn sm" style={{ position: 'absolute', top: 0, right: 0 }} onClick={() => up('display', { promoImages: s.display.promoImages.filter((_: any, j: number) => j !== i) })}>✕</button></div>)}{s.display.background && <><img src={s.display.background} style={{ height: 70 }} /><button className="btn sm" onClick={() => up('display', { background: null })}>ลบพื้นหลัง</button></>}</div>
          <p className="xs muted" style={{ gridColumn: '1/-1' }}>หากไม่อัปโหลดรูป จอลูกค้าจะแสดงโปรโมชั่นที่เปิด “แสดงบนจอลูกค้า” พร้อมชื่อ 3 ภาษา · โลโก้ใช้จากการตั้งค่าร้านค้า</p>
          <div><button className="btn primary" onClick={() => save('display')}>บันทึก</button></div>
        </div>
      )}
      {tab === 'shop' && <ShopSettings s={s} up={up} onSave={() => save('shop')} />}
      {tab === 'receipt' && (
        <div className="card grid g3">
          <Field label="ลำดับการพิมพ์"><select className="in" value={s.receipt.printOrder.join(',')} onChange={(e) => up('receipt', { printOrder: e.target.value.split(',') })}><option value="summary,customer">ใบสรุปยอด → ใบลูกค้า</option><option value="customer,summary">ใบลูกค้า → ใบสรุปยอด</option></select></Field>
          <div><label className="check"><input type="checkbox" checked={s.receipt.autoPrint.summary} onChange={(e) => up('receipt', { autoPrint: { ...s.receipt.autoPrint, summary: e.target.checked } })} /> พิมพ์ใบที่ 1 (สรุปยอด) อัตโนมัติ</label>
            <Field label="จำนวนสำเนาใบที่ 1"><input className="in" type="number" min={1} value={s.receipt.copies.summary} onChange={(e) => up('receipt', { copies: { ...s.receipt.copies, summary: Number(e.target.value) } })} /></Field></div>
          <div><label className="check"><input type="checkbox" checked={s.receipt.autoPrint.customer} onChange={(e) => up('receipt', { autoPrint: { ...s.receipt.autoPrint, customer: e.target.checked } })} /> พิมพ์ใบที่ 2 (ลูกค้า) อัตโนมัติ</label>
            <Field label="จำนวนสำเนาใบที่ 2"><input className="in" type="number" min={1} value={s.receipt.copies.customer} onChange={(e) => up('receipt', { copies: { ...s.receipt.copies, customer: Number(e.target.value) } })} /></Field></div>
          <p className="xs muted" style={{ gridColumn: '1/-1' }}>ค่านี้เป็นค่าเริ่มต้นของทุกเครื่อง · ตั้งค่าแยกรายเครื่องได้ที่ “สาขาและเครื่อง POS” · ออกแบบรูปแบบใบเสร็จได้ที่เมนู “ออกแบบใบเสร็จ”</p>
          <div><button className="btn primary" onClick={() => save('receipt')}>บันทึก</button></div>
        </div>
      )}
      {tab === 'backup' && <Backup />}
    </div>
  );
}

function Branches() {
  const toast = useToast();
  const { data: branches, reload: rb } = useApi<any[]>('/api/admin/branches');
  const { data: terminals, reload: rt } = useApi<any[]>('/api/admin/terminals');
  const [b, setB] = useState<any>(null);
  const [t, setT] = useState<any>(null);
  const [rx, setRx] = useState<any>(null);
  return (
    <div className="grid g2">
      <div className="card">
        <div className="row between"><h3>สาขา</h3><button className="btn sm primary" onClick={() => setB({ code: '', name: '', address: '', phone: '', taxId: '', isActive: true })}>+ สาขา</button></div>
        <table className="t"><tbody>{(branches ?? []).map((x) => <tr key={x.id}><td><b>{x.code}</b> {x.name}<div className="xs muted">{x.address}</div></td><td><button className="btn sm" onClick={() => setB({ id: x.id, code: x.code, name: x.name, nameEn: x.name_en, address: x.address, phone: x.phone, taxId: x.tax_id, isActive: x.is_active })}>แก้ไข</button></td></tr>)}</tbody></table>
      </div>
      <div className="card">
        <div className="row between"><h3>เครื่อง POS</h3><button className="btn sm primary" onClick={() => setT({ code: '', name: '', branchId: branches?.[0]?.id, isActive: true })}>+ เครื่อง</button></div>
        <table className="t"><tbody>{(terminals ?? []).map((x) => <tr key={x.id}><td><b>{x.code}</b> {x.name}<div className="xs muted">{x.branch_name} · บิลล่าสุด #{x.last_bill_seq}</div></td>
          <td className="right"><button className="btn sm" onClick={() => setRx({ id: x.id, settings: x.settings ?? {}, ro: x.settings?.receiptOptions ?? {} })}>ตั้งค่าการพิมพ์</button><button className="btn sm" onClick={() => setT({ id: x.id, code: x.code, name: x.name, branchId: x.branch_id, isActive: x.is_active })}>แก้ไข</button></td></tr>)}</tbody></table>
      </div>
      {b && <Modal title="สาขา" onClose={() => setB(null)} footer={<button className="btn primary" onClick={async () => { try { await api('/api/admin/branches', { body: b }); setB(null); rb(); } catch (e) { toast(errMsg(e), 'err'); } }}>บันทึก</button>}>
        <div className="grid g2">{[['code', 'รหัส'], ['name', 'ชื่อ'], ['nameEn', 'ชื่อ EN'], ['address', 'ที่อยู่'], ['phone', 'โทร'], ['taxId', 'เลขผู้เสียภาษี/สาขา']].map(([k, l]) => <Field key={k} label={l}><input className="in" value={b[k] ?? ''} onChange={(e) => setB({ ...b, [k]: e.target.value })} /></Field>)}</div></Modal>}
      {t && <Modal title="เครื่อง POS" onClose={() => setT(null)} footer={<button className="btn primary" onClick={async () => { try { await api('/api/admin/terminals', { body: { ...t, branchId: Number(t.branchId) } }); setT(null); rt(); } catch (e) { toast(errMsg(e), 'err'); } }}>บันทึก</button>}>
        <div className="grid g2"><Field label="รหัสเครื่อง"><input className="in" value={t.code} onChange={(e) => setT({ ...t, code: e.target.value.toUpperCase() })} /></Field><Field label="ชื่อ"><input className="in" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
          <Field label="สาขา"><select className="in" value={t.branchId} onChange={(e) => setT({ ...t, branchId: e.target.value })}>{branches?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <label className="check"><input type="checkbox" checked={t.isActive} onChange={(e) => setT({ ...t, isActive: e.target.checked })} /> ใช้งาน</label></div></Modal>}
      {rx && <Modal title="ตั้งค่าการพิมพ์ใบเสร็จเฉพาะเครื่องนี้" onClose={() => setRx(null)} footer={<><button className="btn" onClick={async () => { const { receiptOptions, ...rest } = rx.settings; await api(`/api/admin/terminals/${rx.id}/settings`, { method: 'PUT', body: rest }); setRx(null); rt(); }}>ใช้ค่าเริ่มต้นของร้าน</button><button className="btn primary" onClick={async () => { await api(`/api/admin/terminals/${rx.id}/settings`, { method: 'PUT', body: { ...rx.settings, receiptOptions: rx.ro } }); toast('บันทึกแล้ว', 'ok'); setRx(null); rt(); }}>บันทึก</button></>}>
        <div className="grid g2">
          <Field label="ลำดับการพิมพ์"><select className="in" value={(rx.ro.printOrder ?? ['summary', 'customer']).join(',')} onChange={(e) => setRx({ ...rx, ro: { ...rx.ro, printOrder: e.target.value.split(',') } })}><option value="summary,customer">สรุปยอด → ลูกค้า</option><option value="customer,summary">ลูกค้า → สรุปยอด</option></select></Field>
          <div />
          <label className="check"><input type="checkbox" checked={rx.ro.autoPrint?.summary ?? true} onChange={(e) => setRx({ ...rx, ro: { ...rx.ro, autoPrint: { summary: e.target.checked, customer: rx.ro.autoPrint?.customer ?? true } } })} /> พิมพ์ใบสรุปอัตโนมัติ</label>
          <label className="check"><input type="checkbox" checked={rx.ro.autoPrint?.customer ?? true} onChange={(e) => setRx({ ...rx, ro: { ...rx.ro, autoPrint: { summary: rx.ro.autoPrint?.summary ?? true, customer: e.target.checked } } })} /> พิมพ์ใบลูกค้าอัตโนมัติ</label>
          <Field label="สำเนาใบสรุป"><input className="in" type="number" min={1} value={rx.ro.copies?.summary ?? 1} onChange={(e) => setRx({ ...rx, ro: { ...rx.ro, copies: { summary: Number(e.target.value), customer: rx.ro.copies?.customer ?? 1 } } })} /></Field>
          <Field label="สำเนาใบลูกค้า"><input className="in" type="number" min={1} value={rx.ro.copies?.customer ?? 1} onChange={(e) => setRx({ ...rx, ro: { ...rx.ro, copies: { summary: rx.ro.copies?.summary ?? 1, customer: Number(e.target.value) } } })} /></Field>
        </div>
        <p className="xs muted">การเชื่อมต่อเครื่องพิมพ์ (USB/Bluetooth/LAN) ตั้งค่าที่เครื่อง POS นั้นผ่านเมนู “⚙️ อุปกรณ์”</p>
      </Modal>}
    </div>
  );
}

const AREAS: [string, string][] = [['pos', 'หน้าขาย POS'], ['dashboard', 'Dashboard/หลังร้าน'], ['display', 'Customer Display'], ['member', 'เว็บไซต์สมาชิก'], ['receipt', 'ใบเสร็จ (ค่าเริ่มต้นใน Designer)'], ['report', 'รายงาน']];

function Fonts({ settings, setSettings, onSave }: { settings: any; setSettings: (s: any) => void; onSave: () => void }) {
  const toast = useToast();
  const { data: fonts, reload } = useApi<any[]>('/api/admin/fonts');
  const [gname, setGname] = useState('');
  const families = [...new Set((fonts ?? []).map((f) => f.family))];
  useEffect(() => { families.forEach((f) => loadFont(f)); }, [fonts]); // eslint-disable-line
  const upload = async (file: File) => {
    const ext = file.name.split('.').pop()!.toLowerCase();
    if (!['ttf', 'otf', 'woff', 'woff2'].includes(ext)) { toast('รองรับ TTF, OTF, WOFF, WOFF2', 'err'); return; }
    const family = prompt('ชื่อ Font Family', file.name.replace(/\.[^.]+$/, '').replace(/[-_](Regular|Bold|Medium|Light)$/i, ''));
    if (!family) return;
    const weight = prompt('น้ำหนัก (400 = ปกติ, 700 = หนา)', /bold/i.test(file.name) ? '700' : '400') || '400';
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    try { await api('/api/admin/fonts', { body: { family, source: 'upload', format: ext, weight, dataBase64: btoa(bin) } }); await listFonts(true); toast('อัปโหลดฟอนต์แล้ว', 'ok'); reload(); } catch (e) { toast(errMsg(e), 'err'); }
  };
  return (
    <div className="grid g2">
      <div className="card grid">
        <h3>ฟอนต์ที่ใช้ได้</h3>
        <div className="row"><input className="in" style={{ flex: 1 }} placeholder="ชื่อ Google Font เช่น Mitr, Noto Sans SC" value={gname} onChange={(e) => setGname(e.target.value)} /><button className="btn" disabled={!gname} onClick={async () => { await api('/api/admin/fonts', { body: { family: gname.trim(), source: 'google', weight: '400;700' } }); await listFonts(true); setGname(''); reload(); }}>+ Google Font</button></div>
        <label className="btn">⬆ อัปโหลดไฟล์ฟอนต์ (TTF/OTF/WOFF/WOFF2)<input type="file" hidden accept=".ttf,.otf,.woff,.woff2" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} /></label>
        <table className="t"><tbody>{(fonts ?? []).map((f) => <tr key={f.id}><td style={{ fontFamily: `"${f.family}"`, fontSize: '1.1rem' }}>{f.family} — สวัสดี Hello 你好 0123</td><td className="small">{f.source} {f.format ?? ''} {f.weight}</td><td><button className="btn sm ghost" onClick={async () => { await api(`/api/admin/fonts/${f.id}`, { method: 'DELETE' }); reload(); }}>ลบ</button></td></tr>)}</tbody></table>
      </div>
      <div className="card grid">
        <h3>เลือกฟอนต์แยกตามส่วนของระบบ</h3>
        {AREAS.map(([k, l]) => (
          <Field key={k} label={l}><select className="in" style={{ fontFamily: `"${settings.fonts[k]}"` }} value={settings.fonts[k]} onChange={(e) => setSettings({ ...settings, fonts: { ...settings.fonts, [k]: e.target.value } })}>{[...new Set([settings.fonts[k], ...families])].map((f) => <option key={f} value={f}>{f}</option>)}</select></Field>
        ))}
        <button className="btn primary" onClick={onSave}>บันทึก</button>
      </div>
    </div>
  );
}

function Backup() {
  const toast = useToast();
  const isOwner = getSession()?.staff.role === 'owner';
  const download = async () => {
    const r = await fetch('/api/admin/backup', { headers: { Authorization: `Bearer ${getSession()!.token}` } });
    if (!r.ok) { toast('สำรองข้อมูลไม่สำเร็จ', 'err'); return; }
    const blob = await r.blob();
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `ppmart-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`; a.click();
  };
  const restore = async (f: File) => {
    if (!confirm('กู้คืนจะ “แทนที่ข้อมูลทั้งหมด” ด้วยไฟล์สำรอง และทุกคนต้องเข้าสู่ระบบใหม่ ยืนยัน?')) return;
    try { const body = JSON.parse(await f.text()); await api('/api/admin/restore', { body, timeoutMs: 300000 }); toast('กู้คืนสำเร็จ กรุณาเข้าสู่ระบบใหม่', 'ok'); setTimeout(() => location.assign('/login'), 1500); } catch (e) { toast(errMsg(e), 'err'); }
  };
  return (
    <div className="card grid">
      <p>สำรองข้อมูลทั้งหมด (สินค้า สต็อก ยอดขาย สมาชิก คูปอง การตั้งค่า ฯลฯ) เป็นไฟล์ JSON ที่สอดคล้องกัน (snapshot ภายใน transaction เดียว)</p>
      <div className="row"><button className="btn primary" onClick={download}>⬇ ดาวน์โหลดไฟล์สำรอง</button>
        {isOwner && <label className="btn danger">⬆ กู้คืนจากไฟล์<input type="file" hidden accept=".json" onChange={(e) => { const f = e.target.files?.[0]; if (f) restore(f); }} /></label>}</div>
      <p className="xs muted">สำหรับ production แนะนำให้ใช้ <code>pg_dump</code> ตามรอบเวลาเพิ่มเติม (ดู README) · การกู้คืนทำได้เฉพาะ Owner · บันทึกล่าสุด {fmtDate(new Date())}</p>
    </div>
  );
}

function ShopSettings({ s, up, onSave }: { s: any; up: (k: string, patch: any) => void; onSave: () => void }) {
  const { data: branches } = useApi<any[]>('/api/admin/branches');
  const sh = s.shop;
  const pay = (patch: any) => up('shop', { payments: { ...sh.payments, ...patch } });
  const url = `${location.origin}/shop`;
  return (
    <div className="card grid g3">
      <div style={{ gridColumn: '1/-1' }} className="row between">
        <label className="check"><input type="checkbox" checked={sh.enabled} onChange={(e) => up('shop', { enabled: e.target.checked })} /> <b>เปิดรับคำสั่งซื้อออนไลน์</b></label>
        <span className="small">ลิงก์หน้าร้าน: <a href={url} target="_blank" rel="noreferrer">{url}</a></span>
      </div>
      <Field label="ชื่อหน้าร้าน"><input className="in" value={sh.title ?? ''} onChange={(e) => up('shop', { title: e.target.value })} /></Field>
      <Field label="สาขาที่ตัดสต็อก / ให้รับสินค้า"><select className="in" value={sh.branchId ?? ''} onChange={(e) => up('shop', { branchId: e.target.value ? Number(e.target.value) : null })}><option value="">สาขาแรก (ค่าเริ่มต้น)</option>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      <Field label="ประกาศบนหน้าร้าน"><input className="in" value={sh.announcement ?? ''} onChange={(e) => up('shop', { announcement: e.target.value })} placeholder="เช่น ส่งฟรีเมื่อซื้อครบ 500 บาท" /></Field>
      <div><b className="small">การรับสินค้า</b>
        <label className="check"><input type="checkbox" checked={sh.pickup} onChange={(e) => up('shop', { pickup: e.target.checked })} /> รับที่ร้าน</label>
        <label className="check"><input type="checkbox" checked={sh.delivery} onChange={(e) => up('shop', { delivery: e.target.checked })} /> จัดส่ง</label></div>
      <Field label="ค่าจัดส่ง (บาท)"><input className="in" type="number" min={0} value={(sh.deliveryFee ?? 0) / 100} onChange={(e) => up('shop', { deliveryFee: Math.round(Number(e.target.value) * 100) })} /></Field>
      <Field label="ส่งฟรีเมื่อซื้อครบ (บาท, 0 = ไม่มี)"><input className="in" type="number" min={0} value={(sh.freeDeliveryMin ?? 0) / 100} onChange={(e) => up('shop', { freeDeliveryMin: Math.round(Number(e.target.value) * 100) })} /></Field>
      <Field label="ยอดสั่งซื้อขั้นต่ำ (บาท)"><input className="in" type="number" min={0} value={(sh.minOrder ?? 0) / 100} onChange={(e) => up('shop', { minOrder: Math.round(Number(e.target.value) * 100) })} /></Field>
      <div><b className="small">วิธีชำระเงิน</b>
        <label className="check"><input type="checkbox" checked={sh.payments?.promptpay} onChange={(e) => pay({ promptpay: e.target.checked })} /> พร้อมเพย์ QR</label>
        <label className="check"><input type="checkbox" checked={sh.payments?.payAtStore} onChange={(e) => pay({ payAtStore: e.target.checked })} /> ชำระที่ร้าน (รับที่ร้าน)</label>
        <label className="check"><input type="checkbox" checked={sh.payments?.cod} onChange={(e) => pay({ cod: e.target.checked })} /> เก็บเงินปลายทาง (จัดส่ง)</label></div>
      <Field label="ยกเลิกออเดอร์พร้อมเพย์ที่ไม่ชำระภายใน (นาที)"><input className="in" type="number" min={5} value={sh.paymentTimeoutMinutes} onChange={(e) => up('shop', { paymentTimeoutMinutes: Number(e.target.value) })} /></Field>
      <p className="xs muted" style={{ gridColumn: '1/-1' }}>สินค้าทั้งหมดที่เปิดขายและติ๊ก “แสดงในเว็บไซต์สั่งของ” จะแสดงบนหน้าร้าน · ตั้งค่ารูปหลายรูป ไซส์ และตารางไซส์ได้ที่เมนูสินค้า · สต็อกถูกจองทันทีเมื่อสั่งซื้อ และคืนอัตโนมัติเมื่อยกเลิก/หมดเวลาชำระ · พร้อมเพย์ยืนยันอัตโนมัติเมื่อตั้งค่า Omise มิฉะนั้นพนักงานยืนยันยอดที่เมนูออเดอร์ออนไลน์</p>
      <div><button className="btn primary" onClick={onSave}>บันทึก</button></div>
    </div>
  );
}
