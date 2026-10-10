import { useEffect, useState } from 'react';
import { api, getSession } from '../lib/api';
import { useApi } from '../components/ui';
import { DevicesPanel } from '../components/DevicesPanel';
import { fmtDate } from '../lib/format';
import { adminBus } from './AdminApp';

export default function Devices() {
  const { data: terminals, reload } = useApi<any[]>('/api/admin/terminals');
  const { data: status, reload: rs } = useApi<any>('/api/admin/devices/status');
  const s = getSession();
  const [termSettings, setTermSettings] = useState<any>(null);
  useEffect(() => { if (s?.terminalId) api('/api/pos/catalog').then((c) => setTermSettings(c.terminal?.settings ?? {})).catch(() => setTermSettings({})); }, []); // eslint-disable-line
  useEffect(() => adminBus.ws?.on('presence.all', () => { reload(); rs(); }), [reload, rs]);
  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <div className="page-head"><h1>อุปกรณ์และสถานะการเชื่อมต่อ</h1></div>
      <div className="card">
        <h3>เครื่อง POS ทั้งหมด (Real-Time)</h3>
        <table className="t"><thead><tr><th>เครื่อง</th><th>สาขา</th><th>POS</th><th>Customer Display</th><th>เครื่องพิมพ์ที่ตั้งค่า</th><th>ใช้งานล่าสุด</th></tr></thead>
          <tbody>{(terminals ?? []).map((t) => <tr key={t.id}><td><b>{t.code}</b> {t.name}</td><td>{t.branch_name}</td><td><span className={`dot ${t.online.pos ? 'on' : 'off'}`} /> {t.online.pos ? 'ออนไลน์' : 'ออฟไลน์'}</td><td><span className={`dot ${t.online.displays.length ? 'on' : 'off'}`} /> {t.online.displays.length} จอ</td><td className="small">{t.settings?.printer ? `${t.settings.printer.transport} · ${t.settings.printer.paperWidth}mm` : '-'}</td><td className="small">{fmtDate(t.last_seen_at)}</td></tr>)}</tbody></table>
        <p className="small muted">งานพิมพ์ 24 ชม.: {(status?.printJobs ?? []).map((p: any) => `${p.status} ${p.n}`).join(' · ') || '-'}</p>
      </div>
      {s?.terminalId ? (termSettings && <DevicesPanel terminalSettings={termSettings} onSaved={setTermSettings} />) : (
        <div className="banner info">การทดสอบอุปกรณ์จริง (เครื่องพิมพ์ USB/Bluetooth/Serial, Scanner, เครื่องชั่ง, ลิ้นชัก) ต้องทำบนเครื่อง POS นั้น ๆ — เข้าสู่ระบบโดยระบุรหัสเครื่อง POS หรือเปิดเมนู “⚙️ อุปกรณ์” ในหน้าขาย</div>
      )}
    </div>
  );
}
