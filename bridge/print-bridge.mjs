#!/usr/bin/env node
// PPMart Local Print Bridge
// Browsers cannot open raw TCP sockets, so LAN/Wi-Fi ESC/POS printers (port 9100) and OS printer
// device files are reached through this small local service. Run it on the POS computer:
//
//   node bridge/print-bridge.mjs            (listens on http://localhost:9123)
//   PORT=9123 ALLOW_ORIGINS=https://pos.example.com node bridge/print-bridge.mjs
//
// Endpoints (JSON):
//   POST /status { target }            -> checks that the printer is reachable
//   POST /print  { target, data }      -> sends base64 ESC/POS bytes
//   target = { type: 'tcp', host, port } | { type: 'device', path }   e.g. /dev/usb/lp0, \\.\COM3
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';

const PORT = Number(process.env.PORT || 9123);
const ALLOW = (process.env.ALLOW_ORIGINS || '*').split(',').map((s) => s.trim());
const TOKEN = process.env.BRIDGE_TOKEN || '';

function cors(req, res) {
  const origin = req.headers.origin || '*';
  const ok = ALLOW.includes('*') || ALLOW.includes(origin);
  res.setHeader('Access-Control-Allow-Origin', ok ? origin : 'null');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Chrome Private Network Access (public HTTPS page -> localhost)
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  return ok;
}

function sendTcp(host, port, buf, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port }, () => {
      if (!buf) { s.end(); return resolve(); }
      s.write(buf, (err) => { if (err) reject(err); else s.end(); });
    });
    s.setTimeout(timeoutMs, () => { s.destroy(new Error(`timeout connecting ${host}:${port}`)); });
    s.on('error', reject);
    s.on('close', (hadErr) => { if (!hadErr) resolve(); });
  });
}

async function handle(body, write) {
  const t = body.target;
  if (!t) throw new Error('missing target');
  const buf = write ? Buffer.from(body.data || '', 'base64') : null;
  if (t.type === 'tcp') {
    if (!t.host) throw new Error('missing host');
    await sendTcp(t.host, Number(t.port || 9100), buf);
  } else if (t.type === 'device') {
    if (!t.path) throw new Error('missing path');
    if (write) await fs.promises.writeFile(t.path, buf, { flag: 'a' });
    else await fs.promises.access(t.path, fs.constants.W_OK);
  } else throw new Error('unknown target type');
  return { ok: true, bytes: buf?.length ?? 0 };
}

http.createServer((req, res) => {
  const allowed = cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (!allowed) { res.writeHead(403); return res.end(); }
  if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, name: 'ppmart-print-bridge' })); }
  if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end(); }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 20e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const body = JSON.parse(raw || '{}');
      const out = req.url === '/print' ? await handle(body, true) : req.url === '/status' ? await handle(body, false) : null;
      if (!out) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      console.log(new Date().toISOString(), req.url, JSON.stringify(body.target), out.bytes ?? '');
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  });
}).listen(PORT, '127.0.0.1', () => console.log(`PPMart Print Bridge on http://localhost:${PORT}`));
