import { useEffect, useState } from 'react';
import { printer, type PrinterConfig, type TransportKind } from '../lib/printer';
import { scale } from '../lib/scale';
import { scannerStatus, useBarcodeScanner } from '../lib/scanner';
import { api, getSession } from '../lib/api';
import { renderReceipt, sampleReceiptData, renderReport } from '../lib/receipt-render';
import { receiptJob } from '../lib/escpos';
import { printSettings, openDrawer } from '../lib/receipt-print';
import { useToast, errMsg, Field } from './ui';
import { CameraScanner } from './CameraScanner';
import { defaultTemplates } from '../../../shared/receipt';

export const DEFAULT_PRINTER: PrinterConfig = {
  transport: 'usb', paperWidth: 80, dpi: 203,
  bridge: { url: 'http://localhost:9123', target: { type: 'tcp', host: '192.168.1.100', port: 9100 } },
  serial: { baudRate: 9600 }, drawer: { enabled: true, pin: 0, openOnCash: true },
};

export function usePrinterState() {
  const [, force] = useState(0);
  useEffect(() => printer.subscribe(() => force((x) => x + 1)), []);
  return printer;
}

export async function saveTerminalDevices(terminalId: number, patch: any, current: any) {
  const next = { ...(current || {}), ...patch };
  await api(`/api/admin/terminals/${terminalId}/settings`, { method: 'PUT', body: next });
  localStorage.setItem('ppmart.devices', JSON.stringify(next));
  return next;
}

export function DevicesPanel({ terminalSettings, onSaved, displays }: { terminalSettings: any; onSaved?: (s: any) => void; displays?: { online: number; paired: number } }) {
  const toast = useToast();
  const p = usePrinterState();
  const terminalId = getSession()?.terminalId;
  const [cfg, setCfg] = useState<PrinterConfig>(() => ({ ...DEFAULT_PRINTER, ...(terminalSettings?.printer || {}) }));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [scanTest, setScanTest] = useState<string>('');
  const [camera, setCamera] = useState(false);
  const [weight, setWeight] = useState<string>('-');
  const [scaleBaud, setScaleBaud] = useState<number>(terminalSettings?.scale?.baudRate ?? 9600);

  useBarcodeScanner((c) => setScanTest(c));
  useEffect(() => scale.on((w) => setWeight(`${w.kg.toFixed(3)} kg ${w.stable ? '(นิ่ง)' : '(ไม่นิ่ง)'}`)), []);

  const persist = async (c: PrinterConfig) => {
    if (!terminalId) { toast('เข้าสู่ระบบด้วยเครื่อง POS เพื่อบันทึกการตั้งค่าอุปกรณ์', 'warn'); return; }
    const s = await saveTerminalDevices(terminalId, { printer: c }, terminalSettings);
    onSaved?.(s);
  };

  const connect = async () => {
    setBusy(true);
    try {
      const c = await printer.pair(cfg.transport, cfg);
      setCfg(c);
      await persist(c);
      toast('เชื่อมต่อเครื่องพิมพ์สำเร็จ: ' + printer.label, 'ok');
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };

  const testPrint = async () => {
    setBusy(true);
    try {
      const ps = printSettings();
      const tpl = { ...(ps?.receipt.customer ?? defaultTemplates().customer), paperWidth: cfg.paperWidth, dpi: cfg.dpi };
      const canvas = await renderReceipt(tpl, sampleReceiptData(ps?.store));
      setPreview(canvas.toDataURL());
      printer.config = cfg;
      printer.enqueue({ saleId: null, kind: 'test', build: async () => ({ bytes: receiptJob(canvas, { cut: tpl.cut, feedLines: tpl.feedLines }), canvas }) });
    } catch (e) { toast(errMsg(e), 'err'); } finally { setBusy(false); }
  };

  const testFonts = async () => {
    const ps = printSettings();
    const canvas = await renderReport('ทดสอบฟอนต์ / Font test / 字体测试', [
      { l: 'ภาษาไทย: สวัสดีครับ ยินดีต้อนรับ', bold: true }, { l: 'English: The quick brown fox 0123456789' }, { l: '中文：欢迎光临 谢谢惠顾' },
      { l: 'ราคา', r: '฿1,234.50' }, { l: 'Total', r: '850.00', bold: true },
    ], { paperWidth: cfg.paperWidth, dpi: cfg.dpi, fontFamily: ps?.receipt.customer.defaultStyle.fontFamily || 'Sarabun', storeName: ps?.store?.name });
    setPreview(canvas.toDataURL());
    printer.enqueue({ saleId: null, kind: 'test', build: async () => ({ bytes: receiptJob(canvas, { cut: 'partial', feedLines: 3 }), canvas }) });
  };

  const setKind = (k: TransportKind) => setCfg({ ...cfg, transport: k });
  const support = { usb: !!navigator.usb, serial: !!navigator.serial, bluetooth: !!navigator.bluetooth };

  return (
    <div className="grid" style={{ gap: '1rem' }}>
      <section className="card">
        <div className="row between"><h3>🖨️ เครื่องพิมพ์ใบเสร็จ (ESC/POS)</h3><span className={`badge ${p.connected ? 'ok' : 'err'}`}>{p.connected ? 'เชื่อมต่อแล้ว' : 'ไม่ได้เชื่อมต่อ'}</span></div>
        <p className="small muted">อุปกรณ์ปัจจุบัน: {p.label}{p.lastError ? ` — ล่าสุด: ${p.lastError}` : ''}</p>
        <div className="grid g3">
          <Field label="การเชื่อมต่อ">
            <select className="in" value={cfg.transport} onChange={(e) => setKind(e.target.value as TransportKind)}>
              <option value="usb" disabled={!support.usb}>USB (WebUSB){support.usb ? '' : ' — ไม่รองรับ'}</option>
              <option value="serial" disabled={!support.serial}>Serial / USB-Serial / Bluetooth SPP (Web Serial){support.serial ? '' : ' — ไม่รองรับ'}</option>
              <option value="bluetooth" disabled={!support.bluetooth}>Bluetooth LE (Web Bluetooth){support.bluetooth ? '' : ' — ไม่รองรับ'}</option>
              <option value="bridge">LAN / Wi-Fi / Network (Print Bridge)</option>
              <option value="system">System printer (Print dialog)</option>
            </select>
          </Field>
          <Field label="ขนาดกระดาษ">
            <select className="in" value={cfg.paperWidth} onChange={(e) => setCfg({ ...cfg, paperWidth: Number(e.target.value) as 58 | 80 })}><option value={80}>80 มม.</option><option value={58}>58 มม.</option></select>
          </Field>
          <Field label="ความละเอียด (DPI)">
            <select className="in" value={cfg.dpi} onChange={(e) => setCfg({ ...cfg, dpi: Number(e.target.value) })}><option value={203}>203 dpi (มาตรฐาน)</option><option value={180}>180 dpi</option><option value={300}>300 dpi</option></select>
          </Field>
        </div>
        {cfg.transport === 'serial' && (
          <div className="grid g3" style={{ marginTop: 8 }}>
            <Field label="Baud rate"><select className="in" value={cfg.serial?.baudRate ?? 9600} onChange={(e) => setCfg({ ...cfg, serial: { ...cfg.serial, baudRate: Number(e.target.value) } })}>{[9600, 19200, 38400, 57600, 115200].map((b) => <option key={b}>{b}</option>)}</select></Field>
          </div>
        )}
        {cfg.transport === 'bridge' && (
          <div className="grid g3" style={{ marginTop: 8 }}>
            <Field label="Print Bridge URL"><input className="in" value={cfg.bridge?.url ?? ''} onChange={(e) => setCfg({ ...cfg, bridge: { ...cfg.bridge!, url: e.target.value } })} /></Field>
            <Field label="ปลายทาง">
              <select className="in" value={cfg.bridge?.target.type} onChange={(e) => setCfg({ ...cfg, bridge: { ...cfg.bridge!, target: e.target.value === 'tcp' ? { type: 'tcp', host: '192.168.1.100', port: 9100 } : { type: 'device', path: '/dev/usb/lp0' } } })}>
                <option value="tcp">Network printer (TCP 9100)</option><option value="device">Device path (OS)</option>
              </select>
            </Field>
            {cfg.bridge?.target.type === 'tcp' ? (
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <Field label="IP"><input className="in" value={(cfg.bridge.target as any).host} onChange={(e) => setCfg({ ...cfg, bridge: { ...cfg.bridge!, target: { ...(cfg.bridge!.target as any), host: e.target.value } } })} /></Field>
                <Field label="Port"><input className="in" style={{ width: 90 }} value={(cfg.bridge.target as any).port} onChange={(e) => setCfg({ ...cfg, bridge: { ...cfg.bridge!, target: { ...(cfg.bridge!.target as any), port: Number(e.target.value) } } })} /></Field>
              </div>
            ) : (
              <Field label="Device path"><input className="in" value={(cfg.bridge?.target as any)?.path ?? ''} onChange={(e) => setCfg({ ...cfg, bridge: { ...cfg.bridge!, target: { type: 'device', path: e.target.value } } })} /></Field>
            )}
            <p className="xs muted" style={{ gridColumn: '1/-1' }}>เบราว์เซอร์ไม่สามารถเปิด TCP ได้โดยตรง — ให้รัน <code>npm run bridge</code> (bridge/print-bridge.mjs) บนเครื่อง POS</p>
          </div>
        )}
        <div className="grid g3" style={{ marginTop: 8 }}>
          <label className="check"><input type="checkbox" checked={cfg.drawer?.enabled ?? true} onChange={(e) => setCfg({ ...cfg, drawer: { ...cfg.drawer!, enabled: e.target.checked } })} /> ลิ้นชักเงินสดต่อผ่านเครื่องพิมพ์</label>
          <label className="check"><input type="checkbox" checked={cfg.drawer?.openOnCash ?? true} onChange={(e) => setCfg({ ...cfg, drawer: { ...cfg.drawer!, openOnCash: e.target.checked } })} /> เปิดลิ้นชักอัตโนมัติเมื่อรับเงินสด</label>
          <Field label="ขาลิ้นชัก (Drawer pin)"><select className="in" value={cfg.drawer?.pin ?? 0} onChange={(e) => setCfg({ ...cfg, drawer: { ...cfg.drawer!, pin: Number(e.target.value) as 0 | 1 } })}><option value={0}>Pin 2</option><option value={1}>Pin 5</option></select></Field>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn primary" disabled={busy} onClick={connect}>🔌 เชื่อมต่อ / เลือกอุปกรณ์</button>
          <button className="btn" disabled={busy} onClick={async () => { printer.config = cfg; await persist(cfg); toast('บันทึกแล้ว', 'ok'); }}>💾 บันทึก</button>
          <button className="btn" disabled={busy} onClick={testPrint}>🧾 Test Print ใบเสร็จ</button>
          <button className="btn" disabled={busy} onClick={testFonts}>🔤 ทดสอบฟอนต์</button>
          <button className="btn" onClick={async () => { openDrawer(); await api('/api/shifts/drawer-open', { body: { reason: 'ทดสอบลิ้นชัก' } }).catch((e) => toast(errMsg(e), 'err')); }}>💰 ทดสอบเปิดลิ้นชัก</button>
          <button className="btn ghost" onClick={() => printer.disconnect()}>ตัดการเชื่อมต่อ</button>
        </div>
        {preview && <div className="paper-wrap" style={{ marginTop: 12 }}><img className="paper" src={preview} style={{ width: cfg.paperWidth === 58 ? 240 : 340 }} /></div>}
        <PrintQueue />
      </section>

      <section className="card grid g2">
        <div>
          <h3>🔫 Barcode Scanner</h3>
          <p className="small muted">USB/Bluetooth scanner แบบ HID (คีย์บอร์ด) — สแกนบาร์โค้ดใดก็ได้เพื่อทดสอบ</p>
          <div className="banner info mono">{scanTest || scannerStatus.lastCode || 'รอการสแกน…'}</div>
          <p className="xs muted">สแกนทั้งหมด {scannerStatus.count} ครั้ง {scannerStatus.lastScanAt ? `ล่าสุด ${new Date(scannerStatus.lastScanAt).toLocaleTimeString('th-TH')}` : ''}</p>
          <button className="btn" onClick={() => setCamera(true)}>📷 ทดสอบสแกนด้วยกล้อง</button>
        </div>
        <div>
          <h3>⚖️ เครื่องชั่งน้ำหนัก (Web Serial)</h3>
          <div className="row">
            <select className="in" style={{ width: 130 }} value={scaleBaud} onChange={(e) => setScaleBaud(Number(e.target.value))}>{[2400, 4800, 9600, 19200].map((b) => <option key={b}>{b}</option>)}</select>
            <button className="btn" onClick={async () => { try { await scale.connect(scaleBaud, true); if (terminalId) onSaved?.(await saveTerminalDevices(terminalId, { scale: { baudRate: scaleBaud } }, terminalSettings)); toast('เชื่อมต่อเครื่องชั่งแล้ว', 'ok'); } catch (e) { toast(errMsg(e), 'err'); } }}>เชื่อมต่อเครื่องชั่ง</button>
          </div>
          <div className="banner info" style={{ marginTop: 8 }}>น้ำหนัก: <b>{weight}</b> {scale.connected ? <span className="ok">● online</span> : <span className="muted">○ offline</span>}</div>
          <p className="xs muted">รองรับเครื่องชั่งที่ส่งข้อมูลต่อเนื่องผ่าน RS-232/USB-Serial และบาร์โค้ดน้ำหนักจากเครื่องชั่งพิมพ์ฉลาก (EAN-13 ขึ้นต้น 20–29)</p>
        </div>
        <div>
          <h3>🖥️ Customer Display</h3>
          <p className="small">{displays ? <>จับคู่แล้ว {displays.paired} จอ · ออนไลน์ <b className={displays.online ? 'ok' : 'err'}>{displays.online}</b></> : 'จับคู่ได้จากหน้า POS (ปุ่ม “จอลูกค้า”)'}</p>
        </div>
        <div>
          <h3>💰 Cash Drawer</h3>
          <p className="small muted">เปิดผ่านคำสั่ง ESC p ของเครื่องพิมพ์ — ทุกการเปิดลิ้นชักถูกบันทึกในกะและ Activity Log</p>
        </div>
      </section>
      {camera && <CameraScanner onClose={() => setCamera(false)} onScan={(c) => { setScanTest(c); setCamera(false); }} />}
    </div>
  );
}

export function PrintQueue() {
  const p = usePrinterState();
  const jobs = [...p.jobs].reverse().slice(0, 12);
  if (!jobs.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div className="row between"><b>Print Queue</b><button className="btn sm ghost" onClick={() => p.clearDone()}>ล้างรายการที่เสร็จ</button></div>
      <table className="t">
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id}>
              <td className="small">{new Date(j.createdAt).toLocaleTimeString('th-TH')}</td>
              <td>{j.kind}{j.billNo ? ` · ${j.billNo}` : ''}</td>
              <td><span className={`badge ${j.status}`}>{j.status}</span> {j.attempts > 1 && <span className="xs muted">×{j.attempts}</span>}</td>
              <td className="xs err">{j.error}</td>
              <td className="right">{(j.status === 'failed' || j.status === 'cancelled') && <button className="btn sm" onClick={() => p.retry(j.id)}>Retry</button>}{(j.status === 'queued' || j.status === 'failed') && <button className="btn sm ghost" onClick={() => p.cancel(j.id)}>ยกเลิก</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
