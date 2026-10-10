// WebSocket hub: POS <-> Customer Display <-> Dashboard real-time sync.
import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolveToken, type StaffCtx } from './auth';
import { one, pool } from './db';
import { sha256 } from './util';

interface Client {
  ws: WebSocket;
  kind: 'staff' | 'display';
  staff?: StaffCtx;
  displayId?: string;
  terminalId: number | null;
  channels: Set<string>;
  alive: boolean;
}

const clients = new Set<Client>();
const lastDisplayState = new Map<number, any>(); // terminalId -> last cart/display state

function send(c: Client, msg: any) {
  if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

export function publish(channel: string, type: string, payload: any) {
  for (const c of clients) if (c.channels.has(channel)) send(c, { type, channel, payload });
}

/** Broadcast to every staff client (dashboard etc.) */
export function broadcastStaff(type: string, payload: any) {
  for (const c of clients) if (c.kind === 'staff') send(c, { type, payload });
}

export function terminalChannel(id: number) { return `terminal:${id}`; }

export function presence() {
  const terminals: Record<number, { pos: number; displays: { id: string }[] }> = {};
  for (const c of clients) {
    if (c.terminalId == null) continue;
    const t = (terminals[c.terminalId] ||= { pos: 0, displays: [] });
    if (c.kind === 'staff') t.pos++;
    else t.displays.push({ id: c.displayId! });
  }
  return terminals;
}

/** Called after a display has been paired with a terminal through the REST API. */
export function onDisplayPaired(displayId: string, terminalId: number) {
  for (const c of clients) {
    if (c.kind === 'display' && c.displayId === displayId) {
      c.terminalId = terminalId;
      c.channels.add(terminalChannel(terminalId));
      send(c, { type: 'display.paired', payload: { terminalId } });
      const st = lastDisplayState.get(terminalId);
      if (st) send(c, { type: 'display.state', payload: st });
    }
  }
  notifyPresence(terminalId);
}

function notifyPresence(terminalId: number | null) {
  if (terminalId == null) return;
  const p = presence()[terminalId] || { pos: 0, displays: [] };
  publish(terminalChannel(terminalId), 'presence', { terminalId, ...p });
  broadcastStaff('presence.all', presence());
}

export function attachRealtime(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    const url = new URL(req.url || '/ws', 'http://x');
    const token = url.searchParams.get('token');
    const displayToken = url.searchParams.get('display');
    let client: Client | null = null;

    try {
      if (token) {
        const staff = await resolveToken(token);
        if (staff) {
          client = { ws, kind: 'staff', staff, terminalId: staff.terminalId, channels: new Set(['staff']), alive: true };
          if (staff.terminalId) client.channels.add(terminalChannel(staff.terminalId));
          if (staff.branchId) client.channels.add(`branch:${staff.branchId}`);
        }
      } else if (displayToken) {
        const d = await one('SELECT id, terminal_id FROM displays WHERE token_hash=$1', [sha256(displayToken)]);
        if (d) {
          client = { ws, kind: 'display', displayId: d.id, terminalId: d.terminal_id, channels: new Set([`display:${d.id}`]), alive: true };
          if (d.terminal_id) client.channels.add(terminalChannel(d.terminal_id));
          pool.query('UPDATE displays SET last_seen_at=now() WHERE id=$1', [d.id]).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[ws] auth error', e);
    }

    if (!client) {
      ws.close(4401, 'unauthorized');
      return;
    }
    const c = client;
    clients.add(c);
    send(c, { type: 'hello', payload: { kind: c.kind, terminalId: c.terminalId, displayId: c.displayId } });
    if (c.kind === 'display' && c.terminalId) {
      const st = lastDisplayState.get(c.terminalId);
      if (st) send(c, { type: 'display.state', payload: st });
    }
    notifyPresence(c.terminalId);

    ws.on('pong', () => (c.alive = true));
    ws.on('message', (raw) => {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'ping') return send(c, { type: 'pong', payload: { t: msg.t } });
      // POS pushes its cart/payment state; relayed to paired displays of the same terminal.
      if (c.kind === 'staff' && msg.type === 'display.state' && c.terminalId) {
        const state = { ...msg.payload, at: Date.now() };
        lastDisplayState.set(c.terminalId, state);
        for (const o of clients) if (o.kind === 'display' && o.terminalId === c.terminalId) send(o, { type: 'display.state', payload: state });
        return;
      }
      if (c.kind === 'display' && msg.type === 'display.lang' && c.terminalId) {
        pool.query('UPDATE displays SET lang=$2 WHERE id=$1', [c.displayId, String(msg.payload?.lang || 'th')]).catch(() => {});
        publish(terminalChannel(c.terminalId), 'display.lang', { displayId: c.displayId, lang: msg.payload?.lang });
        return;
      }
      if (c.kind === 'staff' && msg.type === 'subscribe' && typeof msg.channel === 'string' && /^(dashboard|branch:\d+)$/.test(msg.channel)) {
        c.channels.add(msg.channel);
      }
    });
    ws.on('close', () => {
      clients.delete(c);
      notifyPresence(c.terminalId);
    });
  });

  const iv = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); clients.delete(c); continue; }
      c.alive = false;
      try { c.ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  wss.on('close', () => clearInterval(iv));
  return wss;
}
