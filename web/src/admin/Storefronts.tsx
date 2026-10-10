// Back office: which online stores exist, which are open, and each store's website settings.
import { useState } from 'react';
import { api } from '../lib/api';
import { useApi, Modal, Field, useToast, errMsg, MoneyInput } from '../components/ui';
import { fmtMoney } from '../lib/format';
import { prepareImage } from './ProductOnline';

const TABS: [string, string][] = [['general', 'ทั่วไป'], ['home', 'หน้าแรก & แบนเนอร์'], ['scope', 'สินค้าที่ขาย'], ['sell', 'จัดส่ง & ชำระเงิน'], ['contact', 'ติดต่อ & ส่วนท้าย']];

export default function Storefronts() {
  const toast = useToast();
  const { data: list, reload } = useApi<any[]>('/api/storefronts');
  const [edit, setEdit] = useState<any>(null);
  const [create, setCreate] = useState<{ name: string; slug: string } | null>(null);
  const body = (s: any) => ({ slug: s.slug, name: s.name, enabled: s.enabled, branchId: s.branchIdRaw ?? null, sortOrder: s.sortOrder ?? 0, config: configOf(s) });
  const toggle = async (s: any) => {
    try { await api(`/api/storefronts/${s.id}`, { method: 'PUT', body: { ...body(s), enabled: !s.enabled } }); toast(`${!s.enabled ? 'เปิด' : 'ปิด'}ร้าน ${s.name} แล้ว`, 'ok'); reload(); }
    catch (e) { toast(errMsg(e), 'err'); }
  };
  const doCreate = async () => {
    try {
      const r = await api('/api/storefronts', { body: { name: create!.name, slug: create!.slug, enabled: false } });
      setCreate(null); await reload();
      const fresh = (await api<any[]>('/api/storefronts')).find((x) => x.id === r.id);
      setEdit(structuredClone(fresh)); toast('สร้างร้านแล้ว (ยังปิดอยู่) — ตั้งค่าแล้วกดเปิดร้าน', 'ok');
    } catch (e) { toast(errMsg(e), 'err'); }
  };
  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>ร้านค้าออนไลน์</h1><div className="row"><a className="btn" href="/shop" target="_blank" rel="noreferrer">🌐 หน้ารวมร้านค้า</a><button className="btn primary" onClick={() => setCreate({ name: '', slug: '' })}>+ เพิ่มร้านค้า</button></div></div>
      <p className="small muted" style={{ margin: 0 }}>แต่ละร้านมีเว็บไซต์สั่งของของตัวเอง (ลิงก์ /shop/ชื่อร้าน) เปิด/ปิดแยกกันได้ เลือกสาขาที่ตัดสต็อก กลุ่มสินค้าที่ขาย แบนเนอร์ สีธีม ค่าส่งและวิธีชำระเงินแยกกัน · ถ้าเปิดไว้ร้านเดียว ลิงก์ /shop จะเข้าร้านนั้นทันที</p>
      <div className="sf-list">
        {(list ?? []).map((s) => (
          <div key={s.id} className={`card sf-card ${s.enabled ? '' : 'off'}`}>
            <div className="sf-banner" style={{ background: s.theme.primary, backgroundImage: s.banners[0] ? `url(/api/shop/media/${s.banners[0].mediaId})` : undefined }}>
              {s.logoMediaId && <img src={`/api/shop/media/${s.logoMediaId}`} alt="" />}
            </div>
            <div className="row between"><b style={{ fontSize: '1.1rem' }}>{s.name}</b>
              <label className="switch" title={s.enabled ? 'เปิดอยู่' : 'ปิดอยู่'}><input type="checkbox" checked={s.enabled} onChange={() => toggle(s)} /><span /></label></div>
            <a className="small mono" href={`/shop/${s.slug}`} target="_blank" rel="noreferrer">/shop/{s.slug} ↗</a>
            <div className="small muted">สต็อก/รับสินค้า: {s.branchName} · {s.scope.mode === 'all' ? 'สินค้าทุกหมวด' : s.scope.mode === 'categories' ? `${s.scope.categoryIds.length} หมวดหมู่` : `${s.scope.brandIds.length} แบรนด์`}</div>
            <div className="small">{s.enabled ? <span className="badge ok">เปิดรับคำสั่งซื้อ</span> : <span className="badge">ปิด</span>} <span className="muted">ออเดอร์ทั้งหมด {s.orders} · ค้างดำเนินการ {s.openOrders}</span></div>
            <div className="row"><button className="btn sm primary" onClick={() => setEdit(structuredClone(s))}>⚙️ ตั้งค่าร้าน</button>
              {s.orders === 0 && <button className="btn sm ghost" onClick={async () => { if (!confirm(`ลบร้าน ${s.name}?`)) return; try { await api(`/api/storefronts/${s.id}`, { method: 'DELETE' }); reload(); } catch (e) { toast(errMsg(e), 'err'); } }}>ลบ</button>}</div>
          </div>
        ))}
      </div>
      {create && (
        <Modal title="เพิ่มร้านค้าออนไลน์" onClose={() => setCreate(null)} footer={<><button className="btn" onClick={() => setCreate(null)}>ยกเลิก</button><button className="btn primary" disabled={!create.name || !create.slug} onClick={doCreate}>สร้างร้าน</button></>}>
          <Field label="ชื่อร้าน"><input className="in" value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value, slug: create.slug || slugify(e.target.value) })} placeholder="เช่น PP Football" /></Field>
          <Field label="ชื่อในลิงก์ (a-z 0-9 -)"><input className="in mono" value={create.slug} onChange={(e) => setCreate({ ...create, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="football" /></Field>
          <p className="small muted">ลิงก์ร้าน: {location.origin}/shop/{create.slug || '…'}</p>
        </Modal>
      )}
      {edit && <Editor s={edit} setS={setEdit} onClose={() => setEdit(null)} onSaved={() => { reload(); }} body={body} />}
    </div>
  );
}

const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
function configOf(s: any) {
  const { tagline, logoMediaId, theme, announcements, banners, scope, home, pickup, delivery, deliveryFee, freeDeliveryMin, minOrder, payments, paymentTimeoutMinutes, contact, locationBranchIds, shippingInfo, returnInfo, footerText } = s;
  return { tagline, logoMediaId, theme, announcements: announcements.filter((a: string) => a.trim()), banners, scope, home, pickup, delivery, deliveryFee, freeDeliveryMin, minOrder, payments, paymentTimeoutMinutes, contact, locationBranchIds, shippingInfo, returnInfo, footerText };
}

function Editor({ s, setS, onClose, onSaved, body }: { s: any; setS: (v: any) => void; onClose: () => void; onSaved: () => void; body: (s: any) => any }) {
  const toast = useToast();
  const [tab, setTab] = useState('general');
  const [busy, setBusy] = useState<string | null>(null);
  const { data: branches } = useApi<any[]>('/api/admin/branches');
  const { data: cats } = useApi<any[]>('/api/products/meta/categories');
  const { data: brands } = useApi<any[]>('/api/products/meta/brands');
  const up = (patch: any) => setS({ ...s, ...patch });
  const sub = (k: string, patch: any) => setS({ ...s, [k]: { ...s[k], ...patch } });
  const upload = async (file: File, maxSide: number) => {
    const r = await api(`/api/storefronts/${s.id}/media`, { body: await prepareImage(file, maxSide), timeoutMs: 60000 });
    return r.id as number;
  };
  const save = async () => {
    try { await api(`/api/storefronts/${s.id}`, { method: 'PUT', body: body(s) }); toast('บันทึกการตั้งค่าร้านแล้ว', 'ok'); onSaved(); onClose(); }
    catch (e) { toast(errMsg(e), 'err'); }
  };
  const setBanner = (i: number, patch: any) => up({ banners: s.banners.map((b: any, k: number) => (k === i ? { ...b, ...patch } : b)) });
  const moveBanner = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= s.banners.length) return; const b = [...s.banners]; [b[i], b[j]] = [b[j], b[i]]; up({ banners: b }); };
  const toggleId = (k: 'categoryIds' | 'brandIds', id: number) => { const cur: number[] = s.scope[k]; sub('scope', { [k]: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] }); };
  return (
    <Modal title={`ตั้งค่าร้าน: ${s.name}`} onClose={onClose} width={980}
      footer={<><a className="btn" href={`/shop/${s.slug}`} target="_blank" rel="noreferrer">ดูหน้าร้าน ↗</a><span className="spacer" /><button className="btn" onClick={onClose}>ยกเลิก</button><button className="btn primary" disabled={!!busy} onClick={save}>บันทึก</button></>}>
      <div className="tabs" style={{ marginTop: 0 }}>{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
      {busy && <div className="banner">{busy}</div>}

      {tab === 'general' && (
        <div className="grid g3" style={{ marginTop: 12 }}>
          <Field label="ชื่อร้าน"><input className="in" value={s.name} onChange={(e) => up({ name: e.target.value })} /></Field>
          <Field label="ชื่อในลิงก์ (/shop/…)"><input className="in mono" value={s.slug} onChange={(e) => up({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} /></Field>
          <Field label="สถานะ"><label className="check"><input type="checkbox" checked={s.enabled} onChange={(e) => up({ enabled: e.target.checked })} /> เปิดเว็บไซต์สั่งของของร้านนี้</label></Field>
          <Field label="สาขาที่ตัดสต็อก / ให้รับสินค้า"><select className="in" value={s.branchIdRaw ?? ''} onChange={(e) => up({ branchIdRaw: e.target.value ? Number(e.target.value) : null })}><option value="">สาขาแรก (ค่าเริ่มต้น)</option>{branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label="คำโปรย (แสดงใต้ชื่อร้าน)"><input className="in" value={s.tagline} onChange={(e) => up({ tagline: e.target.value })} placeholder="เช่น ศูนย์รวมอุปกรณ์ฟุตบอลของแท้" /></Field>
          <Field label="ลำดับในหน้ารวมร้าน"><input className="in" type="number" value={s.sortOrder} onChange={(e) => up({ sortOrder: Number(e.target.value) })} /></Field>
          <Field label="สีหลัก (แถบประกาศ ปุ่ม)"><input className="in" type="color" value={s.theme.primary} onChange={(e) => sub('theme', { primary: e.target.value })} /></Field>
          <Field label="สีเน้น (SALE / ส่วนลด)"><input className="in" type="color" value={s.theme.accent} onChange={(e) => sub('theme', { accent: e.target.value })} /></Field>
          <Field label="โลโก้ร้าน">
            <div className="row">
              {s.logoMediaId && <img src={`/api/shop/media/${s.logoMediaId}`} style={{ height: 48, background: '#f1f5f9', padding: 4 }} alt="" />}
              <label className="btn sm">อัปโหลด<input type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setBusy('กำลังอัปโหลดโลโก้…'); try { up({ logoMediaId: await upload(f, 800) }); } catch (er) { toast(errMsg(er), 'err'); } finally { setBusy(null); } }} /></label>
              {s.logoMediaId && <button className="btn sm ghost" onClick={() => up({ logoMediaId: null })}>ลบ</button>}
            </div>
          </Field>
        </div>
      )}

      {tab === 'home' && (
        <div className="grid" style={{ gap: 16, marginTop: 12 }}>
          <div>
            <b>แถบประกาศด้านบน</b> <span className="xs muted">(หมุนเวียนทีละข้อความ)</span>
            {s.announcements.map((a: string, i: number) => (
              <div key={i} className="row" style={{ marginTop: 6, flexWrap: 'nowrap' }}><input className="in" value={a} onChange={(e) => up({ announcements: s.announcements.map((x: string, k: number) => (k === i ? e.target.value : x)) })} /><button className="btn sm ghost" onClick={() => up({ announcements: s.announcements.filter((_: any, k: number) => k !== i) })}>✕</button></div>
            ))}
            <button className="btn sm" style={{ marginTop: 6 }} disabled={s.announcements.length >= 10} onClick={() => up({ announcements: [...s.announcements, ''] })}>+ เพิ่มข้อความ</button>
          </div>
          <div>
            <b>แบนเนอร์สไลด์หน้าแรก</b> <span className="xs muted">(แนะนำ 2100×800 px · รูปมือถือแนวตั้ง 1080×1350 px ไม่บังคับ)</span>
            <div className="grid" style={{ gap: 10, marginTop: 8 }}>
              {s.banners.map((b: any, i: number) => (
                <div key={i} className="sf-bn">
                  <div className="imgs">
                    <img src={`/api/shop/media/${b.mediaId}`} alt="" />
                    {b.mobileMediaId ? <img className="m" src={`/api/shop/media/${b.mobileMediaId}`} alt="" /> : null}
                  </div>
                  <div className="grid g2" style={{ gap: 6 }}>
                    <input className="in" placeholder="หัวข้อ (ไม่บังคับ)" value={b.title ?? ''} onChange={(e) => setBanner(i, { title: e.target.value })} />
                    <input className="in" placeholder="ข้อความรอง" value={b.subtitle ?? ''} onChange={(e) => setBanner(i, { subtitle: e.target.value })} />
                    <input className="in" placeholder="ข้อความปุ่ม เช่น ช้อปเลย" value={b.buttonText ?? ''} onChange={(e) => setBanner(i, { buttonText: e.target.value })} />
                    <select className="in" value={b.link ?? ''} onChange={(e) => setBanner(i, { link: e.target.value })}>
                      <option value="">ลิงก์: สินค้าทั้งหมด</option><option value="c?tag=new">สินค้าใหม่</option><option value="c?tag=sale">SALE</option><option value="c?tag=best">ขายดี</option>
                      {cats?.map((c) => <option key={c.id} value={`c?category=${c.id}`}>หมวด: {c.name}</option>)}
                      {brands?.map((c) => <option key={'b' + c.id} value={`c?brand=${c.id}`}>แบรนด์: {c.name}</option>)}
                    </select>
                  </div>
                  <div className="row" style={{ flexDirection: 'column', gap: 4 }}>
                    <button className="btn sm" disabled={i === 0} onClick={() => moveBanner(i, -1)}>▲</button>
                    <button className="btn sm" disabled={i === s.banners.length - 1} onClick={() => moveBanner(i, 1)}>▼</button>
                    <label className="btn sm" title="รูปสำหรับมือถือ">📱<input type="file" accept="image/*" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setBusy('กำลังอัปโหลด…'); try { setBanner(i, { mobileMediaId: await upload(f, 1400) }); } catch (er) { toast(errMsg(er), 'err'); } finally { setBusy(null); } }} /></label>
                    <button className="btn sm danger" onClick={() => up({ banners: s.banners.filter((_: any, k: number) => k !== i) })}>✕</button>
                  </div>
                </div>
              ))}
              <label className="btn" style={{ justifySelf: 'start' }}>⬆ อัปโหลดแบนเนอร์ (เลือกได้หลายรูป)<input type="file" accept="image/*" multiple hidden onChange={async (e) => {
                const fs = [...(e.target.files ?? [])]; e.target.value = '';
                const added: any[] = [];
                for (let i = 0; i < fs.length; i++) { setBusy(`กำลังอัปโหลด ${i + 1}/${fs.length}…`); try { added.push({ mediaId: await upload(fs[i], 2400) }); } catch (er) { toast(errMsg(er), 'err'); } }
                setBusy(null); up({ banners: [...s.banners, ...added] });
              }} /></label>
            </div>
          </div>
          <div>
            <b>ส่วนต่างๆ ในหน้าแรก</b>
            <div className="row" style={{ marginTop: 6 }}>
              {([['showCategories', 'หมวดหมู่'], ['showNew', 'สินค้าใหม่'], ['showSale', 'ลดราคา (SALE)'], ['showBest', 'ขายดี'], ['showBrands', 'แบรนด์']] as [string, string][]).map(([k, l]) => (
                <label key={k} className="check"><input type="checkbox" checked={s.home[k]} onChange={(e) => sub('home', { [k]: e.target.checked })} /> {l}</label>
              ))}
              <label className="check">ป้าย NEW สำหรับสินค้าที่เพิ่มภายใน <input className="in" type="number" style={{ width: 70 }} min={1} value={s.home.newDays} onChange={(e) => sub('home', { newDays: Number(e.target.value) || 30 })} /> วัน</label>
            </div>
            <p className="xs muted">ป้าย SALE และราคาขีดฆ่ามาจากช่อง “ราคาก่อนลด” ของสินค้า · ขายดีคำนวณจากยอดขาย 90 วันล่าสุด (หน้าร้าน + ออนไลน์)</p>
          </div>
        </div>
      )}

      {tab === 'scope' && (
        <div className="grid" style={{ gap: 12, marginTop: 12 }}>
          <div className="row">
            {([['all', 'ขายสินค้าทุกหมวด'], ['categories', 'เฉพาะหมวดหมู่ที่เลือก'], ['brands', 'เฉพาะแบรนด์ที่เลือก']] as [string, string][]).map(([k, l]) => (
              <label key={k} className={`btn ${s.scope.mode === k ? 'primary' : ''}`}><input type="radio" hidden checked={s.scope.mode === k} onChange={() => sub('scope', { mode: k })} />{l}</label>
            ))}
          </div>
          {s.scope.mode === 'categories' && <div className="sf-pick">{cats?.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={s.scope.categoryIds.includes(c.id)} onChange={() => toggleId('categoryIds', c.id)} /> {c.name}</label>)}</div>}
          {s.scope.mode === 'brands' && <div className="sf-pick">{brands?.map((c) => <label key={c.id} className="check"><input type="checkbox" checked={s.scope.brandIds.includes(c.id)} onChange={() => toggleId('brandIds', c.id)} /> {c.name}</label>)}</div>}
          <p className="xs muted">แสดงเฉพาะสินค้าที่เปิดขายและติ๊ก “แสดงในเว็บไซต์สั่งของ” · เลือกหมวดหลักจะรวมหมวดย่อยทั้งหมด · สินค้านอกขอบเขตจะสั่งผ่านร้านนี้ไม่ได้</p>
        </div>
      )}

      {tab === 'sell' && (
        <div className="grid g3" style={{ marginTop: 12 }}>
          <div><b className="small">การรับสินค้า</b>
            <label className="check"><input type="checkbox" checked={s.pickup} onChange={(e) => up({ pickup: e.target.checked })} /> รับที่สาขา</label>
            <label className="check"><input type="checkbox" checked={s.delivery} onChange={(e) => up({ delivery: e.target.checked })} /> จัดส่ง</label></div>
          <Field label="ค่าจัดส่ง"><MoneyInput value={s.deliveryFee} onChange={(v) => up({ deliveryFee: v ?? 0 })} /></Field>
          <Field label="ส่งฟรีเมื่อซื้อครบ (0 = ไม่มี)"><MoneyInput value={s.freeDeliveryMin} onChange={(v) => up({ freeDeliveryMin: v ?? 0 })} /></Field>
          <Field label="ยอดสั่งซื้อขั้นต่ำ"><MoneyInput value={s.minOrder} onChange={(v) => up({ minOrder: v ?? 0 })} /></Field>
          <div><b className="small">วิธีชำระเงิน</b>
            <label className="check"><input type="checkbox" checked={s.payments.promptpay} onChange={(e) => sub('payments', { promptpay: e.target.checked })} /> พร้อมเพย์ QR</label>
            <label className="check"><input type="checkbox" checked={s.payments.payAtStore} onChange={(e) => sub('payments', { payAtStore: e.target.checked })} /> ชำระที่ร้าน (รับที่สาขา)</label>
            <label className="check"><input type="checkbox" checked={s.payments.cod} onChange={(e) => sub('payments', { cod: e.target.checked })} /> เก็บเงินปลายทาง (จัดส่ง)</label></div>
          <Field label="ยกเลิกออเดอร์พร้อมเพย์ที่ไม่ชำระภายใน (นาที)"><input className="in" type="number" min={5} value={s.paymentTimeoutMinutes} onChange={(e) => up({ paymentTimeoutMinutes: Number(e.target.value) })} /></Field>
          <Field label="ข้อมูลการจัดส่ง (แสดงในหน้าสินค้า)"><textarea className="in" rows={4} value={s.shippingInfo} onChange={(e) => up({ shippingInfo: e.target.value })} placeholder={`จัดส่งภายใน 1–3 วันทำการ\nค่าส่ง ${fmtMoney(s.deliveryFee)}`} /></Field>
          <Field label="นโยบายการคืนสินค้า"><textarea className="in" rows={4} value={s.returnInfo} onChange={(e) => up({ returnInfo: e.target.value })} placeholder="เปลี่ยนไซส์ได้ภายใน 7 วัน สินค้าต้องอยู่ในสภาพเดิม" /></Field>
        </div>
      )}

      {tab === 'contact' && (
        <div className="grid g3" style={{ marginTop: 12 }}>
          {([['phone', 'โทรศัพท์'], ['line', 'LINE (@id หรือลิงก์)'], ['email', 'อีเมล'], ['facebook', 'Facebook (ลิงก์)'], ['instagram', 'Instagram (ลิงก์)'], ['tiktok', 'TikTok (ลิงก์)']] as [string, string][]).map(([k, l]) => (
            <Field key={k} label={l}><input className="in" value={s.contact[k] ?? ''} onChange={(e) => sub('contact', { [k]: e.target.value })} /></Field>
          ))}
          <Field label="ที่อยู่ (ส่วนท้ายเว็บ)"><input className="in" value={s.contact.address ?? ''} onChange={(e) => sub('contact', { address: e.target.value })} placeholder="ว่างไว้ = ใช้ที่อยู่ร้านหลัก" /></Field>
          <Field label="ข้อความส่วนท้าย"><textarea className="in" rows={3} value={s.footerText} onChange={(e) => up({ footerText: e.target.value })} /></Field>
          <div><b className="small">สาขาที่แสดงในหน้า “สาขาของเรา”</b>
            {branches?.map((b) => <label key={b.id} className="check"><input type="checkbox" checked={s.locationBranchIds.includes(b.id)} onChange={() => up({ locationBranchIds: s.locationBranchIds.includes(b.id) ? s.locationBranchIds.filter((x: number) => x !== b.id) : [...s.locationBranchIds, b.id] })} /> {b.name}</label>)}
            <p className="xs muted">ไม่เลือก = แสดงเฉพาะสาขาที่ตัดสต็อก</p></div>
        </div>
      )}
    </Modal>
  );
}
