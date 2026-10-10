// Reconnecting WebSocket client with listeners.
type Handler = (payload: any, msg: any) => void;

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private closed = false;
  private retry = 0;
  private queue: string[] = [];
  public connected = false;

  constructor(private query: string) { this.connect(); }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?${this.query}`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true; this.retry = 0;
      this.emit('_status', { connected: true });
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (ev) => {
      try { const m = JSON.parse(ev.data); this.emit(m.type, m.payload, m); } catch { /* ignore */ }
    };
    ws.onclose = (ev) => {
      this.connected = false;
      this.emit('_status', { connected: false, code: ev.code });
      if (this.closed || ev.code === 4401) { if (ev.code === 4401) this.emit('_unauthorized', {}); return; }
      const delay = Math.min(15000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private emit(type: string, payload: any, msg?: any) {
    this.handlers.get(type)?.forEach((h) => h(payload, msg));
    this.handlers.get('*')?.forEach((h) => h(payload, msg ?? { type }));
  }

  on(type: string, h: Handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(h);
    return () => { this.handlers.get(type)!.delete(h); };
  }

  send(type: string, payload: any = {}) {
    const m = JSON.stringify({ type, payload });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(m);
    else if (type !== 'display.state') this.queue.push(m);
  }

  close() { this.closed = true; this.ws?.close(); }
}
