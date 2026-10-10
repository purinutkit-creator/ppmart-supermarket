// Printer transports (real device APIs) + persistent print queue with retry.
//  - WebUSB         : USB thermal printers (Chrome/Edge, HTTPS or localhost)
//  - Web Serial     : USB-serial / RS-232 / Bluetooth SPP printers (Chrome/Edge desktop)
//  - Web Bluetooth  : BLE thermal printers (GATT write characteristic)
//  - Print Bridge   : LAN / Wi-Fi network printers (TCP 9100) and OS printer devices via the local bridge app
//  - System dialog  : any OS-installed printer through the browser print dialog (fallback)
import { api } from './api';
import { uuid } from './format';

export type TransportKind = 'usb' | 'serial' | 'bluetooth' | 'bridge' | 'system';

export interface PrinterConfig {
  transport: TransportKind;
  paperWidth: 58 | 80;
  dpi: number;
  usb?: { vendorId: number; productId: number; serialNumber?: string | null };
  serial?: { baudRate: number; usbVendorId?: number; usbProductId?: number };
  bluetooth?: { name?: string; id?: string };
  bridge?: { url: string; target: { type: 'tcp'; host: string; port: number } | { type: 'device'; path: string } };
  drawer?: { enabled: boolean; pin: 0 | 1; openOnCash: boolean };
}

export interface Transport {
  kind: TransportKind;
  label: string;
  isConnected(): boolean;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

// ---------------- WebUSB ----------------
class UsbTransport implements Transport {
  kind: TransportKind = 'usb';
  constructor(private dev: USBDevice, private ifaceNum: number, private ep: number) {}
  get label() { return `USB ${this.dev.manufacturerName ?? ''} ${this.dev.productName ?? ''}`.trim(); }
  isConnected() { return this.dev.opened; }
  async write(data: Uint8Array) {
    if (!this.dev.opened) await UsbTransport.prepare(this.dev);
    for (let i = 0; i < data.length; i += 8192) {
      const r = await this.dev.transferOut(this.ep, data.slice(i, i + 8192));
      if (r.status !== 'ok') throw new Error('USB transfer ' + r.status);
    }
  }
  async close() { try { await this.dev.releaseInterface(this.ifaceNum); await this.dev.close(); } catch { /* ignore */ } }

  static async prepare(dev: USBDevice) {
    if (!dev.opened) await dev.open();
    if (!dev.configuration) await dev.selectConfiguration(1);
    for (const iface of dev.configuration!.interfaces) {
      for (const alt of iface.alternates) {
        const out = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
        if (out) {
          if (!iface.claimed) await dev.claimInterface(iface.interfaceNumber);
          return { iface: iface.interfaceNumber, ep: out.endpointNumber };
        }
      }
    }
    throw new Error('ไม่พบ Bulk OUT endpoint ของเครื่องพิมพ์');
  }
  static async request(): Promise<{ t: UsbTransport; cfg: PrinterConfig['usb'] }> {
    if (!navigator.usb) throw new Error('เบราว์เซอร์นี้ไม่รองรับ WebUSB (ใช้ Chrome/Edge ผ่าน HTTPS หรือ localhost)');
    const dev = await navigator.usb.requestDevice({ filters: [] });
    const { iface, ep } = await UsbTransport.prepare(dev);
    return { t: new UsbTransport(dev, iface, ep), cfg: { vendorId: dev.vendorId, productId: dev.productId, serialNumber: dev.serialNumber } };
  }
  static async restore(cfg: NonNullable<PrinterConfig['usb']>) {
    if (!navigator.usb) return null;
    const devs = await navigator.usb.getDevices();
    const dev = devs.find((d) => d.vendorId === cfg.vendorId && d.productId === cfg.productId && (!cfg.serialNumber || d.serialNumber === cfg.serialNumber));
    if (!dev) return null;
    const { iface, ep } = await UsbTransport.prepare(dev);
    return new UsbTransport(dev, iface, ep);
  }
}

// ---------------- Web Serial ----------------
class SerialTransport implements Transport {
  kind: TransportKind = 'serial';
  label = 'Serial printer';
  constructor(private port: SerialPort) {
    const i = port.getInfo();
    if (i.usbVendorId) this.label = `Serial ${i.usbVendorId.toString(16)}:${(i.usbProductId ?? 0).toString(16)}`;
  }
  isConnected() { return !!this.port.writable; }
  async write(data: Uint8Array) {
    const w = this.port.writable!.getWriter();
    try { await w.write(data); } finally { w.releaseLock(); }
  }
  async close() { try { await this.port.close(); } catch { /* ignore */ } }
  static async request(baudRate: number) {
    if (!navigator.serial) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Serial');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate });
    const i = port.getInfo();
    return { t: new SerialTransport(port), cfg: { baudRate, usbVendorId: i.usbVendorId, usbProductId: i.usbProductId } };
  }
  static async restore(cfg: NonNullable<PrinterConfig['serial']>) {
    if (!navigator.serial) return null;
    const ports = await navigator.serial.getPorts();
    const port = ports.find((p) => { const i = p.getInfo(); return !cfg.usbVendorId || (i.usbVendorId === cfg.usbVendorId && i.usbProductId === cfg.usbProductId); });
    if (!port) return null;
    if (!port.writable) await port.open({ baudRate: cfg.baudRate });
    return new SerialTransport(port);
  }
}

// ---------------- Web Bluetooth (BLE) ----------------
const BLE_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // common Chinese ESC/POS BLE printers
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC / Microchip transparent UART
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
];
class BluetoothTransport implements Transport {
  kind: TransportKind = 'bluetooth';
  constructor(private dev: BluetoothDevice, private ch: BluetoothRemoteGATTCharacteristic) {}
  get label() { return `Bluetooth ${this.dev.name ?? ''}`; }
  isConnected() { return !!this.dev.gatt?.connected; }
  async write(data: Uint8Array) {
    if (!this.dev.gatt!.connected) {
      const t = await BluetoothTransport.connect(this.dev);
      this.ch = t.ch;
    }
    const chunk = 180;
    for (let i = 0; i < data.length; i += chunk) {
      const part = data.slice(i, i + chunk);
      if (this.ch.properties.writeWithoutResponse) await this.ch.writeValueWithoutResponse(part);
      else await this.ch.writeValueWithResponse(part);
    }
  }
  async close() { this.dev.gatt?.disconnect(); }
  static async connect(dev: BluetoothDevice) {
    const server = await dev.gatt!.connect();
    for (const svc of await server.getPrimaryServices()) {
      for (const ch of await svc.getCharacteristics()) {
        if (ch.properties.write || ch.properties.writeWithoutResponse) return new BluetoothTransport(dev, ch);
      }
    }
    throw new Error('ไม่พบ characteristic สำหรับเขียนข้อมูลบนเครื่องพิมพ์ Bluetooth');
  }
  static async request() {
    if (!navigator.bluetooth) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Bluetooth');
    const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    const t = await BluetoothTransport.connect(dev);
    return { t, cfg: { name: dev.name, id: dev.id } };
  }
  static async restore(cfg: NonNullable<PrinterConfig['bluetooth']>) {
    const b: any = navigator.bluetooth;
    if (!b?.getDevices) return null; // requires user gesture to reconnect on browsers without getDevices()
    const devs: BluetoothDevice[] = await b.getDevices();
    const dev = devs.find((d) => d.id === cfg.id);
    return dev ? BluetoothTransport.connect(dev) : null;
  }
}

// ---------------- Local Print Bridge (LAN / Wi-Fi / OS device) ----------------
class BridgeTransport implements Transport {
  kind: TransportKind = 'bridge';
  private ok = false;
  constructor(private cfg: NonNullable<PrinterConfig['bridge']>) {}
  get label() { const t = this.cfg.target; return t.type === 'tcp' ? `Network ${t.host}:${t.port}` : `Device ${t.path}`; }
  isConnected() { return this.ok; }
  async ping() {
    const r = await fetch(this.cfg.url.replace(/\/$/, '') + '/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: this.cfg.target }) });
    const j = await r.json();
    this.ok = r.ok && j.ok;
    if (!this.ok) throw new Error(j.error || 'เครื่องพิมพ์ไม่ตอบสนอง');
    return j;
  }
  async write(data: Uint8Array) {
    let bin = '';
    for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
    const r = await fetch(this.cfg.url.replace(/\/$/, '') + '/print', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: this.cfg.target, data: btoa(bin) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { this.ok = false; throw new Error(j.error || `Bridge HTTP ${r.status}`); }
    this.ok = true;
  }
  async close() { this.ok = false; }
}

// ---------------- System print dialog (fallback) ----------------
class SystemTransport implements Transport {
  kind: TransportKind = 'system';
  label = 'System printer (browser dialog)';
  pendingCanvas: HTMLCanvasElement | null = null;
  constructor(private paperWidth: 58 | 80) {}
  isConnected() { return true; }
  async write(_data: Uint8Array) {
    if (!this.pendingCanvas) return; // non-image commands (drawer/cut) cannot be sent via the OS dialog
    const url = this.pendingCanvas.toDataURL('image/png');
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(f);
    f.contentDocument!.write(`<html><head><style>@page{size:${this.paperWidth}mm auto;margin:0}body{margin:0}img{width:${this.paperWidth === 58 ? 48 : 72}mm;display:block;margin:0 auto}</style></head><body><img src="${url}"></body></html>`);
    f.contentDocument!.close();
    await new Promise((r) => setTimeout(r, 300));
    f.contentWindow!.print();
    setTimeout(() => f.remove(), 2000);
  }
  async close() {}
}

// ---------------- Manager + Queue ----------------
export type JobStatus = 'queued' | 'printing' | 'printed' | 'failed' | 'cancelled';
export interface PrintJob {
  id: string;
  saleId: number | null;
  billNo?: string;
  kind: string; // summary | customer | shift | test | label | drawer
  status: JobStatus;
  attempts: number;
  error?: string;
  createdAt: number;
  /** function to (re)build bytes; not persisted */
  build?: () => Promise<{ bytes: Uint8Array; canvas?: HTMLCanvasElement }>;
  /** serialisable info to rebuild after reload */
  rebuild?: { type: 'receipt'; kind: string; saleId: number };
}

type Listener = () => void;
const STORE_KEY = 'ppmart.printJobs';

class PrinterManager {
  config: PrinterConfig | null = null;
  transport: Transport | null = null;
  jobs: PrintJob[] = [];
  lastError: string | null = null;
  private listeners = new Set<Listener>();
  private running = false;
  rebuilder: ((job: PrintJob) => Promise<{ bytes: Uint8Array; canvas?: HTMLCanvasElement }>) | null = null;

  constructor() {
    try { this.jobs = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { this.jobs = []; }
    for (const j of this.jobs) if (j.status === 'printing') j.status = 'failed';
  }
  subscribe(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  private changed() {
    localStorage.setItem(STORE_KEY, JSON.stringify(this.jobs.slice(-50).map(({ build, ...j }) => j)));
    this.listeners.forEach((l) => l());
  }

  get connected() { return !!this.transport?.isConnected(); }
  get label() { return this.transport?.label ?? 'ยังไม่ได้เชื่อมต่อ'; }

  async configure(cfg: PrinterConfig | null, tryRestore = true) {
    this.config = cfg;
    if (this.transport && this.transport.kind !== cfg?.transport) { await this.transport.close(); this.transport = null; }
    if (cfg && tryRestore) await this.restore().catch((e) => { this.lastError = e.message; });
    this.changed();
  }

  async restore() {
    const c = this.config;
    if (!c) return;
    if (c.transport === 'usb' && c.usb) this.transport = await UsbTransport.restore(c.usb);
    else if (c.transport === 'serial' && c.serial) this.transport = await SerialTransport.restore(c.serial);
    else if (c.transport === 'bluetooth' && c.bluetooth) this.transport = await BluetoothTransport.restore(c.bluetooth);
    else if (c.transport === 'bridge' && c.bridge) { const t = new BridgeTransport(c.bridge); this.transport = t; await t.ping().catch((e) => { this.lastError = e.message; }); }
    else if (c.transport === 'system') this.transport = new SystemTransport(c.paperWidth);
    this.changed();
  }

  /** Must be called from a user gesture (button click) for USB/Serial/Bluetooth pickers. */
  async pair(kind: TransportKind, base: PrinterConfig): Promise<PrinterConfig> {
    if (this.transport) await this.transport.close();
    let cfg: PrinterConfig = { ...base, transport: kind };
    if (kind === 'usb') { const r = await UsbTransport.request(); this.transport = r.t; cfg.usb = r.cfg; }
    else if (kind === 'serial') { const r = await SerialTransport.request(base.serial?.baudRate ?? 9600); this.transport = r.t; cfg.serial = r.cfg; }
    else if (kind === 'bluetooth') { const r = await BluetoothTransport.request(); this.transport = r.t; cfg.bluetooth = r.cfg; }
    else if (kind === 'bridge') { if (!base.bridge) throw new Error('กรุณาระบุ Bridge URL และปลายทาง'); const t = new BridgeTransport(base.bridge); await t.ping(); this.transport = t; }
    else this.transport = new SystemTransport(base.paperWidth);
    this.config = cfg;
    this.lastError = null;
    this.changed();
    return cfg;
  }

  async disconnect() { await this.transport?.close(); this.transport = null; this.changed(); }

  async sendRaw(bytes: Uint8Array, canvas?: HTMLCanvasElement) {
    if (!this.transport) await this.restore();
    if (!this.transport) throw new Error('ยังไม่ได้เชื่อมต่อเครื่องพิมพ์');
    if (this.transport instanceof SystemTransport) this.transport.pendingCanvas = canvas ?? null;
    await this.transport.write(bytes);
  }

  enqueue(job: Omit<PrintJob, 'id' | 'status' | 'attempts' | 'createdAt'>) {
    const j: PrintJob = { ...job, id: uuid(), status: 'queued', attempts: 0, createdAt: Date.now() };
    this.jobs.push(j);
    this.log(j);
    this.changed();
    this.run();
    return j;
  }

  retry(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (j && (j.status === 'failed' || j.status === 'cancelled')) { j.status = 'queued'; j.error = undefined; this.changed(); this.run(); }
  }
  cancel(id: string) { const j = this.jobs.find((x) => x.id === id); if (j && j.status !== 'printed') { j.status = 'cancelled'; this.log(j); this.changed(); } }
  clearDone() { this.jobs = this.jobs.filter((j) => j.status !== 'printed' && j.status !== 'cancelled'); this.changed(); }

  /** Sequential processing keeps Receipt 1 → cut → Receipt 2 → cut order. Failures never affect the (already committed) sale. */
  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const j = this.jobs.find((x) => x.status === 'queued');
        if (!j) break;
        j.status = 'printing'; j.attempts++; this.changed();
        try {
          const built = j.build ? await j.build() : this.rebuilder ? await this.rebuilder(j) : null;
          if (!built) throw new Error('ไม่สามารถสร้างข้อมูลพิมพ์ใหม่ได้ (โปรดพิมพ์ซ้ำจากประวัติบิล)');
          await this.sendRaw(built.bytes, built.canvas);
          j.status = 'printed'; j.error = undefined; this.lastError = null;
        } catch (e: any) {
          j.error = e?.message || String(e);
          this.lastError = j.error!;
          if (j.attempts < 3 && this.transport) { j.status = 'queued'; await new Promise((r) => setTimeout(r, 1000 * j.attempts)); }
          else j.status = 'failed';
        }
        this.log(j);
        this.changed();
      }
    } finally { this.running = false; }
  }

  private log(j: PrintJob) {
    api('/api/pos/print-jobs', { body: { id: j.id, saleId: j.saleId, kind: j.kind, status: j.status, attempts: j.attempts, transport: this.config?.transport, error: j.error ?? null } }).catch(() => {});
  }
}

export const printer = new PrinterManager();
