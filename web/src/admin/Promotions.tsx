import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApi, Modal, Field, MoneyInput, useToast, errMsg } from '../components/ui';
import { fmtDate, fmtMoney } from '../lib/format';
import { describeReward } from '../../../shared/pricing';
import { PAYMENT_LABELS } from '../../../shared/receipt';
import { loadFont } from '../lib/fonts';

const TYPES: Record<string, string> = {
  bxgy: 'ซื้อ X แถม Y', qty_percent: 'ซื้อครบจำนวน ลด %', bill_threshold: 'ส่วนลดตามยอดซื้อ', special_price: 'ราคาพิเศษ / Flash Sale',
  percent_off: 'ลด % สินค้า', tier_price: 'ราคาพิเศษเฉพาะ Tier', birthday: 'โปรวันเกิดสมาชิก', receipt_coupon: 'คูปองท้ายใบเสร็จ (Receipt Coupon)',
};
const REWARDS: Record<string, string> = {
  amount: 'ลดเป็นจำนวนเงิน', percent: 'ลดเป็นเปอร์เซ็นต์ทั้งบิล', bogo: 'ซื้อ 1 แถม 1', free_item: 'ฟรีสินค้า', special_price: 'ราคาพิเศษ',
  product_discount: 'ส่วนลดเฉพาะสินค้า', category_discount: 'ส่วนลดเฉพาะหมวด', bill_discount: 'ส่วนลดทั้งบิล',
};
const DOW = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

const blank = () => ({ name: '', nameEn: '', nameZh: '', type: 'bill_threshold', isActive: true, priority: 100, stackable: false, startsAt: '', endsAt: '', daysOfWeek: [], timeStart: '', timeEnd: '', branchIds: [], tierIds: [], memberOnly: false, productIds: [], categoryIds: [], brandIds: [], promoCode: '', usageLimit: null, params: {}, description: '', imageUrl: '', showOnDisplay: true });

function MultiPick({ label, options, value, onChange }: { label: string; options: { id: number; name: string }[]; value: number[]; onChange: (v: number[]) => void }) {
  const [q, setQ] = useState('');
  const shown = options.filter((o) => !q || o.name.toLowerCase().includes(q.toLowerCase())).slice(0, 60);
  return (
    <div>
      <div className="f" style={{ fontSize: '.85rem', color: 'var(--muted)', fontWeight: 600 }}>{label} {value.length ? `(${value.length})` : '(ทั้งหมด)'}</div>
      {options.length > 12 && <input className="in" placeholder="ค้นหา" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 4 }} />}
      <div style={{ maxHeight: 130, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 6 }}>
        {shown.map((o) => <label key={o.id} className="check" style={{ display: 'flex' }}><input type="checkbox" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} /> {o.name}</label>)}
      </div>
    </div>
  );
}

export default function Promotions() {
  const toast = useToast();
  const { data: list, reload } = useApi<any[]>('/api/marketing/promotions');
  const { data: products } = useApi<any[]>('/api/products');
  const { data: cats } = useApi<any[]>('/api/products/meta/categories');
  const { data: brands } = useApi<any[]>('/api/products/meta/brands');
  const { data: tiers } = useApi<any[]>('/api/members/tiers');
  const { data: branches } = useApi<any[]>('/api/admin/branches');
  const [e, setE] = useState<any>(null);
  const [poster, setPoster] = useState<any>(null);
  const P = (k: string) => e.params?.[k];
  const setP = (k: string, v: any) => setE({ ...e, params: { ...e.params, [k]: v } });
  const R = (k: string) => e.params?.reward?.[k];
  const setR = (k: string, v: any) => setE({ ...e, params: { ...e.params, reward: { ...(e.params.reward || {}), [k]: v } } });

  const toForm = (p: any) => ({
    id: p.id, name: p.name, nameEn: p.name_en ?? '', nameZh: p.name_zh ?? '', type: p.type, isActive: p.is_active, priority: p.priority, stackable: p.stackable,
    startsAt: p.starts_at ? p.starts_at.slice(0, 16) : '', endsAt: p.ends_at ? p.ends_at.slice(0, 16) : '', daysOfWeek: p.days_of_week ?? [], timeStart: p.time_start ?? '', timeEnd: p.time_end ?? '',
    branchIds: p.branch_ids ?? [], tierIds: p.tier_ids ?? [], memberOnly: p.member_only, productIds: p.product_ids ?? [], categoryIds: p.category_ids ?? [], brandIds: p.brand_ids ?? [],
    promoCode: p.promo_code ?? '', usageLimit: p.usage_limit, params: p.params ?? {}, description: p.description ?? '', imageUrl: p.image_url ?? '', showOnDisplay: p.show_on_display,
  });
  const save = async () => {
    try {
      const body = { ...e, startsAt: e.startsAt ? new Date(e.startsAt).toISOString() : null, endsAt: e.endsAt ? new Date(e.endsAt).toISOString() : null, usageLimit: e.usageLimit ? Number(e.usageLimit) : null, priority: Number(e.priority) };
      if (e.id) await api(`/api/marketing/promotions/${e.id}`, { method: 'PUT', body }); else await api('/api/marketing/promotions', { body });
      toast('บันทึกโปรโมชั่นแล้ว', 'ok'); setE(null); reload();
    } catch (err) { toast(errMsg(err), 'err'); }
  };
  const opt = (rows?: any[] | null) => (rows ?? []).map((r) => ({ id: r.id, name: r.sku ? `${r.name} (${r.sku})` : r.name }));
  const isCoupon = e?.type === 'receipt_coupon';

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>โปรโมชั่น</h1><div className="row"><button className="btn primary" onClick={() => setE(blank())}>+ สร้างโปรโมชั่น</button><button className="btn" onClick={() => setE({ ...blank(), type: 'receipt_coupon', params: { minSpend: 50000, maxPerBill: 1, validDays: 30, title: 'SPECIAL COUPON', reward: { type: 'amount', value: 5000 } } })}>+ คูปองท้ายใบเสร็จ</button></div></div>
      <div className="table-wrap"><table className="t">
        <thead><tr><th>ชื่อ</th><th>ประเภท</th><th>ช่วงเวลา</th><th>เงื่อนไข</th><th className="right">ใช้ไป</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>{(list ?? []).map((p) => (
          <tr key={p.id}>
            <td><b>{p.name}</b><div className="xs muted">{p.name_en}</div></td>
            <td className="small">{TYPES[p.type]}{p.stackable && <span className="badge info">ใช้ร่วมได้</span>}</td>
            <td className="small">{p.starts_at ? fmtDate(p.starts_at, false) : '-'} – {p.ends_at ? fmtDate(p.ends_at, false) : '-'}{p.time_start && <div>{p.time_start.slice(0, 5)}–{p.time_end?.slice(0, 5)}</div>}{p.days_of_week?.length ? <div>{p.days_of_week.map((d: number) => DOW[d]).join(' ')}</div> : null}</td>
            <td className="small">{p.type === 'receipt_coupon' ? <>ครบ {fmtMoney(Number(p.params.minSpend || 0))}{p.params.minQty ? ` / ${p.params.minQty} ชิ้น` : ''} → {p.params.reward ? describeReward(p.params.reward) : ''}</> : JSON.stringify(p.params)}{p.member_only && ' · สมาชิก'}{p.promo_code && ` · code ${p.promo_code}`}</td>
            <td className="right">{p.usage_count}{p.usage_limit ? `/${p.usage_limit}` : ''}{p.type === 'receipt_coupon' && <div className="xs muted">ออก {p.coupons_issued} ใบ</div>}</td>
            <td><span className={`badge ${p.is_active ? 'ok' : ''}`}>{p.is_active ? 'เปิด' : 'ปิด'}</span></td>
            <td className="right"><button className="btn sm" onClick={() => setE(toForm(p))}>แก้ไข</button><button className="btn sm" onClick={() => setPoster(p)}>🎨 ภาพโปรโมท</button></td>
          </tr>
        ))}</tbody>
      </table></div>

      {e && (
        <Modal title={e.id ? 'แก้ไขโปรโมชั่น' : 'สร้างโปรโมชั่น'} onClose={() => setE(null)} width={980}
          footer={<>{e.id && <button className="btn danger" onClick={async () => { if (confirm('ลบโปรโมชั่น?')) { await api(`/api/marketing/promotions/${e.id}`, { method: 'DELETE' }); setE(null); reload(); } }}>ลบ</button>}<span className="spacer" /><button className="btn" onClick={() => setE(null)}>ยกเลิก</button><button className="btn primary" onClick={save}>บันทึก</button></>}>
          <div className="grid g3">
            <Field label="ชื่อโปรโมชั่น (ไทย)"><input className="in" value={e.name} onChange={(x) => setE({ ...e, name: x.target.value })} /></Field>
            <Field label="English"><input className="in" value={e.nameEn} onChange={(x) => setE({ ...e, nameEn: x.target.value })} /></Field>
            <Field label="中文"><input className="in" value={e.nameZh} onChange={(x) => setE({ ...e, nameZh: x.target.value })} /></Field>
            <Field label="ประเภท"><select className="in" value={e.type} onChange={(x) => setE({ ...e, type: x.target.value, params: x.target.value === 'receipt_coupon' ? { maxPerBill: 1, validDays: 30, reward: { type: 'amount', value: 5000 } } : {} })}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
            <Field label="ลำดับความสำคัญ (น้อย = ก่อน)"><input className="in" type="number" value={e.priority} onChange={(x) => setE({ ...e, priority: x.target.value })} /></Field>
            <Field label="จำนวนสิทธิ์ทั้งหมด (ว่าง = ไม่จำกัด)"><input className="in" type="number" value={e.usageLimit ?? ''} onChange={(x) => setE({ ...e, usageLimit: x.target.value || null })} /></Field>
          </div>

          <h3 style={{ marginTop: 14 }}>{isCoupon ? 'สิทธิ์ที่ได้รับ (Reward) และเงื่อนไขการออกคูปอง' : 'รายละเอียดส่วนลด'}</h3>
          <div className="grid g4">
            {e.type === 'bxgy' && <><Field label="ซื้อ (ชิ้น)"><input className="in" type="number" value={P('buy') ?? 1} onChange={(x) => setP('buy', Number(x.target.value))} /></Field><Field label="แถม (ชิ้น)"><input className="in" type="number" value={P('get') ?? 1} onChange={(x) => setP('get', Number(x.target.value))} /></Field></>}
            {e.type === 'qty_percent' && <><Field label="ซื้อครบ (ชิ้น)"><input className="in" type="number" value={P('minQty') ?? 2} onChange={(x) => setP('minQty', Number(x.target.value))} /></Field><Field label="ลด (%)"><input className="in" type="number" value={P('percent') ?? 10} onChange={(x) => setP('percent', Number(x.target.value))} /></Field></>}
            {(e.type === 'bill_threshold' || e.type === 'birthday') && <>
              {e.type === 'bill_threshold' && <Field label="ยอดซื้อขั้นต่ำ"><MoneyInput value={P('minSpend')} onChange={(v) => setP('minSpend', v)} /></Field>}
              <Field label="ลดเป็นบาท"><MoneyInput value={P('amount')} onChange={(v) => setP('amount', v)} /></Field>
              <Field label="หรือ ลด (%)"><input className="in" type="number" value={P('percent') ?? ''} onChange={(x) => setP('percent', x.target.value ? Number(x.target.value) : undefined)} /></Field>
              <Field label="ลดสูงสุด"><MoneyInput value={P('maxDiscount')} onChange={(v) => setP('maxDiscount', v)} /></Field>
            </>}
            {(e.type === 'special_price' || e.type === 'tier_price') && <><Field label="ราคาพิเศษต่อหน่วย"><MoneyInput value={P('price')} onChange={(v) => setP('price', v)} /></Field><Field label="หรือ ลด (%)"><input className="in" type="number" value={P('percent') ?? ''} onChange={(x) => setP('percent', x.target.value ? Number(x.target.value) : undefined)} /></Field></>}
            {e.type === 'percent_off' && <Field label="ลด (%)"><input className="in" type="number" value={P('percent') ?? 10} onChange={(x) => setP('percent', Number(x.target.value))} /></Field>}
            {isCoupon && <>
              <Field label="ประเภทสิทธิ์"><select className="in" value={R('type') ?? 'amount'} onChange={(x) => setR('type', x.target.value)}>{Object.entries(REWARDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              {['amount', 'bill_discount', 'product_discount', 'category_discount'].includes(R('type') ?? 'amount') && <Field label="รูปแบบ"><select className="in" value={R('valueType') ?? 'amount'} onChange={(x) => setR('valueType', x.target.value)}><option value="amount">บาท</option><option value="percent">%</option></select></Field>}
              {['bogo', 'free_item'].includes(R('type')) ? null : (R('valueType') === 'percent' || R('type') === 'percent')
                ? <Field label="มูลค่า (%)"><input className="in" type="number" value={R('value') ?? 10} onChange={(x) => setR('value', Number(x.target.value))} /></Field>
                : <Field label={R('type') === 'special_price' ? 'ราคาพิเศษ' : 'มูลค่าส่วนลด'}><MoneyInput value={R('value')} onChange={(v) => setR('value', v ?? 0)} /></Field>}
              <Field label="ส่วนลดสูงสุด"><MoneyInput value={R('maxDiscount')} onChange={(v) => setR('maxDiscount', v ?? undefined)} /></Field>
              <Field label="ยอดซื้อขั้นต่ำตอนใช้คูปอง"><MoneyInput value={P('redeemMinSpend')} onChange={(v) => setP('redeemMinSpend', v)} /></Field>
              <Field label="อายุคูปอง (วัน)"><input className="in" type="number" value={P('validDays') ?? 30} onChange={(x) => setP('validDays', Number(x.target.value))} /></Field>
              <Field label="หรือ ใช้ได้ถึงวันที่"><input className="in" type="date" value={P('expiresOn') ?? ''} onChange={(x) => setP('expiresOn', x.target.value || undefined)} /></Field>
              <Field label="หัวข้อบนคูปอง"><input className="in" value={P('title') ?? ''} onChange={(x) => setP('title', x.target.value)} /></Field>
              {['product_discount', 'bogo', 'free_item', 'special_price'].includes(R('type')) && <div style={{ gridColumn: 'span 2' }}><MultiPick label="สินค้าที่ใช้สิทธิ์ (ตอนแลกใช้)" options={opt(products)} value={R('productIds') ?? []} onChange={(v) => setR('productIds', v)} /></div>}
              {R('type') === 'category_discount' && <div style={{ gridColumn: 'span 2' }}><MultiPick label="หมวดที่ใช้สิทธิ์" options={opt(cats)} value={R('categoryIds') ?? []} onChange={(v) => setR('categoryIds', v)} /></div>}
            </>}
          </div>
          {isCoupon && (
            <>
              <h3 style={{ marginTop: 14 }}>เงื่อนไขการได้รับคูปอง</h3>
              <div className="grid g4">
                <Field label="ยอดซื้อขั้นต่ำ (Minimum Spend)"><MoneyInput value={P('minSpend')} onChange={(v) => setP('minSpend', v)} /></Field>
                <Field label="จำนวนชิ้นขั้นต่ำ (Quantity)"><input className="in" type="number" value={P('minQty') ?? ''} onChange={(x) => setP('minQty', x.target.value ? Number(x.target.value) : undefined)} /></Field>
                <Field label="คูปองสูงสุดต่อบิล"><input className="in" type="number" value={P('maxPerBill') ?? 1} onChange={(x) => setP('maxPerBill', Number(x.target.value))} /></Field>
                <Field label="กลุ่ม (ออกเฉพาะเงื่อนไขสูงสุดในกลุ่ม)"><input className="in" value={P('exclusiveGroup') ?? ''} onChange={(x) => setP('exclusiveGroup', x.target.value || undefined)} placeholder="เช่น spend-coupon" /></Field>
                <label className="check"><input type="checkbox" checked={!!P('perThreshold')} onChange={(x) => setP('perThreshold', x.target.checked)} /> ออกทุกครั้งที่ครบเงื่อนไข (เช่น ทุก 500 บาท)</label>
                <label className="check"><input type="checkbox" checked={!!P('memberBound')} onChange={(x) => setP('memberBound', x.target.checked)} /> ผูกคูปองกับสมาชิกผู้ซื้อ</label>
                <label className="check"><input type="checkbox" checked={!!P('validFromNextDay')} onChange={(x) => setP('validFromNextDay', x.target.checked)} /> เริ่มใช้ได้ตั้งแต่วันถัดไป</label>
              </div>
              <div className="grid g3" style={{ marginTop: 8 }}>
                <div><div className="small muted" style={{ fontWeight: 600 }}>ช่องทางชำระเงินที่ได้สิทธิ์</div>{Object.entries(PAYMENT_LABELS).map(([k, v]) => <label key={k} className="check" style={{ marginRight: 8 }}><input type="checkbox" checked={(P('paymentMethods') ?? []).includes(k)} onChange={(x) => setP('paymentMethods', x.target.checked ? [...(P('paymentMethods') ?? []), k] : (P('paymentMethods') ?? []).filter((m: string) => m !== k))} />{v}</label>)}</div>
                <MultiPick label="สาขาที่ใช้คูปองได้" options={opt(branches)} value={P('redeemBranchIds') ?? []} onChange={(v) => setP('redeemBranchIds', v)} />
                <div>
                  <div className="small muted" style={{ fontWeight: 600 }}>วัน/เวลาที่ใช้คูปองได้</div>
                  <div>{DOW.map((d, i) => <label key={i} className="check" style={{ marginRight: 4 }}><input type="checkbox" checked={(P('redeemDaysOfWeek') ?? []).includes(i)} onChange={(x) => setP('redeemDaysOfWeek', x.target.checked ? [...(P('redeemDaysOfWeek') ?? []), i] : (P('redeemDaysOfWeek') ?? []).filter((v: number) => v !== i))} />{d}</label>)}</div>
                  <div className="row"><input className="in" type="time" style={{ width: 120 }} value={P('redeemTimeStart')?.slice(0, 5) ?? ''} onChange={(x) => setP('redeemTimeStart', x.target.value ? x.target.value + ':00' : undefined)} />–<input className="in" type="time" style={{ width: 120 }} value={P('redeemTimeEnd')?.slice(0, 5) ?? ''} onChange={(x) => setP('redeemTimeEnd', x.target.value ? x.target.value + ':59' : undefined)} /></div>
                </div>
              </div>
            </>
          )}

          <h3 style={{ marginTop: 14 }}>สินค้าเป้าหมาย {isCoupon ? '(สินค้า/หมวด/แบรนด์ที่นับยอดเพื่อออกคูปอง)' : ''}</h3>
          <div className="grid g3">
            <MultiPick label="สินค้า / SKU" options={opt(products)} value={e.productIds} onChange={(v) => setE({ ...e, productIds: v })} />
            <MultiPick label="หมวดหมู่" options={opt(cats)} value={e.categoryIds} onChange={(v) => setE({ ...e, categoryIds: v })} />
            <MultiPick label="แบรนด์" options={opt(brands)} value={e.brandIds} onChange={(v) => setE({ ...e, brandIds: v })} />
          </div>
          <h3 style={{ marginTop: 14 }}>ช่วงเวลาและสิทธิ์</h3>
          <div className="grid g4">
            <Field label="เริ่ม"><input className="in" type="datetime-local" value={e.startsAt} onChange={(x) => setE({ ...e, startsAt: x.target.value })} /></Field>
            <Field label="สิ้นสุด"><input className="in" type="datetime-local" value={e.endsAt} onChange={(x) => setE({ ...e, endsAt: x.target.value })} /></Field>
            <Field label="ช่วงเวลา (Flash sale)"><div className="row"><input className="in" type="time" style={{ width: 110 }} value={e.timeStart?.slice(0, 5)} onChange={(x) => setE({ ...e, timeStart: x.target.value })} />–<input className="in" type="time" style={{ width: 110 }} value={e.timeEnd?.slice(0, 5)} onChange={(x) => setE({ ...e, timeEnd: x.target.value })} /></div></Field>
            <Field label="รหัสโปรโมชั่น (Promotion Code)"><input className="in" value={e.promoCode} onChange={(x) => setE({ ...e, promoCode: x.target.value.toUpperCase() })} /></Field>
            <div><div className="small muted" style={{ fontWeight: 600 }}>วันในสัปดาห์</div>{DOW.map((d, i) => <label key={i} className="check" style={{ marginRight: 4 }}><input type="checkbox" checked={e.daysOfWeek.includes(i)} onChange={(x) => setE({ ...e, daysOfWeek: x.target.checked ? [...e.daysOfWeek, i] : e.daysOfWeek.filter((v: number) => v !== i) })} />{d}</label>)}</div>
            <MultiPick label="สาขา" options={opt(branches)} value={e.branchIds} onChange={(v) => setE({ ...e, branchIds: v })} />
            <MultiPick label="Member Tier" options={opt(tiers)} value={e.tierIds} onChange={(v) => setE({ ...e, tierIds: v })} />
            <div className="grid" style={{ gap: 4 }}>
              <label className="check"><input type="checkbox" checked={e.memberOnly} onChange={(x) => setE({ ...e, memberOnly: x.target.checked })} /> เฉพาะสมาชิก (Member Only)</label>
              <label className="check"><input type="checkbox" checked={e.stackable} onChange={(x) => setE({ ...e, stackable: x.target.checked })} /> ใช้ร่วมกับโปรอื่นได้</label>
              <label className="check"><input type="checkbox" checked={e.isActive} onChange={(x) => setE({ ...e, isActive: x.target.checked })} /> เปิดใช้งาน</label>
              <label className="check"><input type="checkbox" checked={e.showOnDisplay} onChange={(x) => setE({ ...e, showOnDisplay: x.target.checked })} /> แสดงบนจอลูกค้า</label>
            </div>
          </div>
          <div className="grid g2" style={{ marginTop: 8 }}>
            <Field label="คำอธิบาย"><input className="in" value={e.description} onChange={(x) => setE({ ...e, description: x.target.value })} /></Field>
            <Field label="ภาพโปรโมชั่น (URL หรือ data URL จากเครื่องมือสร้างภาพ)"><input className="in" value={e.imageUrl} onChange={(x) => setE({ ...e, imageUrl: x.target.value })} /></Field>
          </div>
        </Modal>
      )}
      {poster && <PosterMaker promo={poster} onClose={() => setPoster(null)} onSaved={reload} />}
    </div>
  );
}

const TEMPLATES = [
  { id: 'bold', bg: ['#dc2626', '#f59e0b'], ink: '#fff', badge: '#fde047' },
  { id: 'fresh', bg: ['#0f766e', '#22c55e'], ink: '#fff', badge: '#fef08a' },
  { id: 'night', bg: ['#0f172a', '#7c3aed'], ink: '#fff', badge: '#f472b6' },
  { id: 'clean', bg: ['#ffffff', '#e0f2fe'], ink: '#0f172a', badge: '#ef4444' },
];

function PosterMaker({ promo, onClose, onSaved }: { promo: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const ref = useRef<HTMLCanvasElement>(null);
  const [tpl, setTpl] = useState(TEMPLATES[0]);
  const [headline, setHeadline] = useState(promo.name);
  const [sub, setSub] = useState(promo.description || (promo.ends_at ? `ถึง ${fmtDate(promo.ends_at, false)}` : ''));
  const [badge, setBadge] = useState(promo.type === 'bxgy' ? '1 แถม 1' : promo.type === 'receipt_coupon' ? 'COUPON' : 'SALE');
  const [font, setFont] = useState('Kanit');
  const [size, setSize] = useState<'1080x1080' | '1920x1080' | '1080x1920'>('1920x1080');
  const [bgImg, setBgImg] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  useEffect(() => {
    (async () => {
      await loadFont(font);
      const [w, h] = size.split('x').map(Number);
      const c = ref.current!; c.width = w; c.height = h;
      const x = c.getContext('2d')!;
      const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, tpl.bg[0]); g.addColorStop(1, tpl.bg[1]);
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      if (bgImg) { const im = new Image(); im.src = bgImg; await im.decode().catch(() => {}); const s = Math.max(w / im.width, h / im.height); x.globalAlpha = .55; x.drawImage(im, (w - im.width * s) / 2, (h - im.height * s) / 2, im.width * s, im.height * s); x.globalAlpha = 1; }
      const u = Math.min(w, h) / 1080;
      x.fillStyle = tpl.badge; x.beginPath(); x.arc(w - 220 * u, 220 * u, 160 * u, 0, Math.PI * 2); x.fill();
      x.fillStyle = tpl.ink === '#fff' ? '#111' : '#fff'; x.font = `800 ${70 * u}px "${font}"`; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(badge, w - 220 * u, 220 * u);
      x.fillStyle = tpl.ink; x.textAlign = 'left'; x.textBaseline = 'alphabetic';
      const wrapText = (t: string, maxW: number) => { const out: string[] = []; let line = ''; for (const ch of Array.from(t)) { if (x.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else line += ch; } out.push(line); return out; };
      x.font = `800 ${120 * u}px "${font}"`;
      let y = h * 0.45;
      for (const ln of wrapText(headline, w - 160 * u)) { x.fillText(ln, 80 * u, y); y += 135 * u; }
      x.font = `500 ${56 * u}px "${font}"`;
      for (const ln of wrapText(sub, w - 160 * u)) { x.fillText(ln, 80 * u, y + 10 * u); y += 70 * u; }
    })();
  }, [tpl, headline, sub, badge, font, size, bgImg]);

  const saveToPromo = async () => {
    const url = ref.current!.toDataURL('image/jpeg', 0.85);
    try {
      const p = promo;
      await api(`/api/marketing/promotions/${p.id}`, { method: 'PUT', body: { name: p.name, nameEn: p.name_en, nameZh: p.name_zh, type: p.type, isActive: p.is_active, priority: p.priority, stackable: p.stackable, startsAt: p.starts_at, endsAt: p.ends_at, daysOfWeek: p.days_of_week, timeStart: p.time_start, timeEnd: p.time_end, branchIds: p.branch_ids, tierIds: p.tier_ids, memberOnly: p.member_only, productIds: p.product_ids, categoryIds: p.category_ids, brandIds: p.brand_ids, promoCode: p.promo_code, usageLimit: p.usage_limit, params: p.params, description: p.description, imageUrl: url, showOnDisplay: true } });
      toast('บันทึกภาพเป็นภาพโปรโมชั่น (แสดงบนจอลูกค้า) แล้ว', 'ok'); onSaved(); onClose();
    } catch (e) { toast(errMsg(e), 'err'); }
  };

  const aiGenerate = async () => {
    setAiBusy(true);
    try { const r = await api('/api/marketing/ai-image', { body: { prompt: aiPrompt || `${headline} supermarket promotion background, vibrant, no text` }, timeoutMs: 120000 }); setBgImg(r.image); }
    catch (e) { toast(errMsg(e), 'err'); } finally { setAiBusy(false); }
  };

  return (
    <Modal title="🎨 สร้างภาพประชาสัมพันธ์" onClose={onClose} width={1000} footer={<><a className="btn" download={`promo-${promo.id}.png`} href="#" onClick={(e) => { (e.currentTarget as HTMLAnchorElement).href = ref.current!.toDataURL('image/png'); }}>⬇ ดาวน์โหลด PNG</a><button className="btn primary" onClick={saveToPromo}>ใช้เป็นภาพโปรโมชั่น</button></>}>
      <div className="grid" style={{ gridTemplateColumns: '280px 1fr' }}>
        <div className="grid">
          <Field label="เทมเพลต"><div className="row">{TEMPLATES.map((t) => <button key={t.id} className="btn sm" style={{ background: `linear-gradient(135deg,${t.bg[0]},${t.bg[1]})`, color: t.ink, outline: tpl.id === t.id ? '3px solid #0f766e' : undefined }} onClick={() => setTpl(t)}>{t.id}</button>)}</div></Field>
          <Field label="ขนาด"><select className="in" value={size} onChange={(e) => setSize(e.target.value as any)}><option value="1920x1080">1920×1080 (จอแนวนอน)</option><option value="1080x1920">1080×1920 (แนวตั้ง)</option><option value="1080x1080">1080×1080 (โซเชียล)</option></select></Field>
          <Field label="หัวข้อ"><input className="in" value={headline} onChange={(e) => setHeadline(e.target.value)} /></Field>
          <Field label="ข้อความรอง"><input className="in" value={sub} onChange={(e) => setSub(e.target.value)} /></Field>
          <Field label="ป้าย"><input className="in" value={badge} onChange={(e) => setBadge(e.target.value)} /></Field>
          <Field label="ฟอนต์ (Google Fonts)"><input className="in" value={font} onChange={(e) => setFont(e.target.value)} /></Field>
          <Field label="ภาพพื้นหลัง"><input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0]; if (f) { const r = new FileReader(); r.onload = () => setBgImg(String(r.result)); r.readAsDataURL(f); } }} /></Field>
          <div className="card" style={{ padding: 8 }}>
            <div className="small" style={{ fontWeight: 600 }}>🤖 สร้างภาพพื้นหลังด้วย AI</div>
            <input className="in" placeholder="คำอธิบายภาพ" value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} />
            <button className="btn sm" disabled={aiBusy} onClick={aiGenerate}>{aiBusy ? 'กำลังสร้าง…' : 'สร้างด้วย AI'}</button>
            <div className="xs muted">ต้องตั้งค่า AI_IMAGE_ENDPOINT / AI_IMAGE_API_KEY ที่เซิร์ฟเวอร์</div>
          </div>
        </div>
        <canvas ref={ref} style={{ width: '100%', borderRadius: 12, boxShadow: 'var(--shadow)' }} />
      </div>
    </Modal>
  );
}
