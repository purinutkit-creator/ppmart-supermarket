import { lazy, Suspense, useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, can, getSession, setSession } from '../lib/api';
import { applyAreaFonts } from '../lib/fonts';
import { RealtimeClient } from '../lib/ws';
import { setPrintSettings } from '../lib/receipt-print';
import { printer } from '../lib/printer';
import { DEFAULT_PRINTER } from '../components/DevicesPanel';
import Dashboard from './Dashboard';

const Reports = lazy(() => import('./Reports'));
const Products = lazy(() => import('./Products'));
const Stock = lazy(() => import('./Stock'));
const Members = lazy(() => import('./Members'));
const Promotions = lazy(() => import('./Promotions'));
const Coupons = lazy(() => import('./Coupons'));
const Purchasing = lazy(() => import('./Purchasing'));
const Payments = lazy(() => import('./Payments'));
const Shifts = lazy(() => import('./Shifts'));
const Staff = lazy(() => import('./Staff'));
const Settings = lazy(() => import('./Settings'));
const ReceiptDesigner = lazy(() => import('./ReceiptDesigner'));
const Devices = lazy(() => import('./Devices'));
const Audit = lazy(() => import('./Audit'));

export const adminBus = { ws: null as RealtimeClient | null };

const NAV: { grp: string; items: [string, string, string | null][] }[] = [
  { grp: 'ภาพรวม', items: [['/admin', '📊 Dashboard', 'reports.view'], ['/admin/reports', '📈 รายงาน', 'reports.view']] },
  { grp: 'ขาย', items: [['/pos', '🛒 หน้าขาย POS', 'pos.sell'], ['/admin/payments', '💳 ตรวจสอบการชำระเงิน', 'payments.verify'], ['/admin/shifts', '⏱ กะแคชเชียร์', 'shifts.view_all']] },
  { grp: 'สินค้า', items: [['/admin/products', '📦 สินค้า', 'products.manage'], ['/admin/stock', '🏬 สต็อก', 'stock.view'], ['/admin/purchasing', '🚚 จัดซื้อ', 'purchasing.manage']] },
  { grp: 'การตลาด', items: [['/admin/members', '👥 สมาชิก', 'members.manage'], ['/admin/promotions', '🏷 โปรโมชั่น', 'promotions.manage'], ['/admin/coupons', '🎟 Receipt Coupon', 'coupons.manage']] },
  { grp: 'ระบบ', items: [['/admin/staff', '🧑‍💼 พนักงานและสิทธิ์', 'staff.manage'], ['/admin/settings', '⚙️ ตั้งค่า', 'settings.manage'], ['/admin/receipt-designer', '🧾 ออกแบบใบเสร็จ', 'settings.manage'], ['/admin/devices', '🔌 อุปกรณ์', null], ['/admin/audit', '📜 Activity Log', 'audit.view']] },
];

export default function AdminApp() {
  const nav = useNavigate();
  const s = getSession()!;
  const [store, setStore] = useState<any>(null);
  useEffect(() => {
    api('/api/admin/settings').then((st) => {
      setStore(st.store);
      applyAreaFonts(st.fonts);
      setPrintSettings({ receipt: st.receipt, store: st.store, tax: st.tax });
    }).catch(() => {});
    if (s.terminalId) api('/api/pos/catalog').then((c) => printer.configure({ ...DEFAULT_PRINTER, ...(c.terminal?.settings?.printer || {}) })).catch(() => {});
    const ws = new RealtimeClient(`token=${encodeURIComponent(s.token)}`);
    adminBus.ws = ws;
    const off = ws.on('_unauthorized', () => { setSession(null); nav('/login'); });
    return () => { off(); ws.close(); };
  }, []); // eslint-disable-line

  return (
    <div className="admin">
      <aside className="side">
        <div className="brand">🛒 {store?.name ?? 'PPMart'}</div>
        {NAV.map((g) => {
          const items = g.items.filter(([, , perm]) => !perm || can(perm));
          if (!items.length) return null;
          return (
            <div key={g.grp}>
              <div className="grp">{g.grp}</div>
              {items.map(([to, label]) => to === '/pos'
                ? <a key={to} href="/pos">{label}</a>
                : <NavLink key={to} to={to} end={to === '/admin'} className={({ isActive }) => (isActive ? 'active' : '')}>{label}</NavLink>)}
            </div>
          );
        })}
        <div className="grp">บัญชี</div>
        <a href="#" onClick={async (e) => { e.preventDefault(); await api('/api/auth/logout', { body: {} }).catch(() => {}); setSession(null); nav('/login'); }}>🚪 ออกจากระบบ ({s.staff.name})</a>
      </aside>
      <main className="content">
        <Suspense fallback={<div className="muted">กำลังโหลด…</div>}>
          <Routes>
            <Route index element={can('reports.view') ? <Dashboard /> : <div className="card">ยินดีต้อนรับ {s.staff.name} ({s.staff.roleName})</div>} />
            <Route path="reports" element={<Reports />} />
            <Route path="products" element={<Products />} />
            <Route path="stock" element={<Stock />} />
            <Route path="members" element={<Members />} />
            <Route path="promotions" element={<Promotions />} />
            <Route path="coupons" element={<Coupons />} />
            <Route path="purchasing" element={<Purchasing />} />
            <Route path="payments" element={<Payments />} />
            <Route path="shifts" element={<Shifts />} />
            <Route path="staff" element={<Staff />} />
            <Route path="settings" element={<Settings />} />
            <Route path="receipt-designer" element={<ReceiptDesigner />} />
            <Route path="devices" element={<Devices />} />
            <Route path="audit" element={<Audit />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
