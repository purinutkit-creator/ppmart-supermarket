// Weighing scale over Web Serial (RS-232 / USB-serial). Most retail scales continuously stream lines like
// "ST,GS,+  1.234kg" (ST = stable) or answer a weight request command.
type Listener = (w: { kg: number; stable: boolean; raw: string }) => void;

class Scale {
  port: SerialPort | null = null;
  last: { kg: number; stable: boolean; raw: string; at: number } | null = null;
  private listeners = new Set<Listener>();
  private reading = false;
  requestCmd: string | null = null;

  get connected() { return !!this.port?.readable; }
  on(l: Listener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }

  async connect(baudRate = 9600, request = false) {
    if (!navigator.serial) throw new Error('เบราว์เซอร์นี้ไม่รองรับ Web Serial');
    this.port = request ? await navigator.serial.requestPort() : (await navigator.serial.getPorts())[0] ?? null;
    if (!this.port) return false;
    if (!this.port.readable) await this.port.open({ baudRate });
    this.loop();
    return true;
  }

  private async loop() {
    if (this.reading || !this.port?.readable) return;
    this.reading = true;
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (this.port?.readable) {
        const reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value);
            const lines = buf.split(/[\r\n\x02\x03]+/);
            buf = lines.pop() ?? '';
            for (const raw of lines) this.parse(raw);
          }
        } finally { reader.releaseLock(); }
      }
    } catch (e) { console.warn('scale read error', e); } finally { this.reading = false; }
  }

  private parse(raw: string) {
    const m = raw.match(/([-+]?\s*\d+(?:\.\d+)?)\s*(kg|g|lb)?/i);
    if (!m) return;
    let v = Number(m[1].replace(/\s/g, ''));
    const unit = (m[2] || 'kg').toLowerCase();
    if (unit === 'g') v /= 1000;
    if (unit === 'lb') v *= 0.45359237;
    const stable = !/US|UNST|MOTION/i.test(raw) || /ST/.test(raw.slice(0, 2));
    this.last = { kg: Math.round(v * 1000) / 1000, stable, raw, at: Date.now() };
    this.listeners.forEach((l) => l(this.last!));
  }

  /** Ask the scale for a reading (for scales that only answer on request, e.g. "W\r\n"). */
  async poll() {
    if (!this.port?.writable || !this.requestCmd) return;
    const w = this.port.writable.getWriter();
    try { await w.write(new TextEncoder().encode(this.requestCmd)); } finally { w.releaseLock(); }
  }

  async disconnect() { try { await this.port?.close(); } catch { /* ignore */ } this.port = null; }
}

export const scale = new Scale();
