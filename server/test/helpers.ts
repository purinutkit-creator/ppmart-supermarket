import type { Server } from 'node:http';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.DATABASE_URL_OVERRIDE = process.env.TEST_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/ppmart_test';

export async function setup() {
  const { pool } = await import('../src/db');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { migrate } = await import('../src/migrate');
  await migrate(false);
  const { clearSettingsCache } = await import('../src/settings');
  clearSettingsCache();
  const { seed } = await import('../src/seed');
  const log = console.log; console.log = () => {};
  await seed();
  console.log = log;
  const { createApp } = await import('../src/app');
  const server: Server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;
  const api = async (method: string, path: string, body?: any, token?: string) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j: any = await r.json().catch(() => null);
    return { status: r.status, body: j };
  };
  const login = async (employeeCode: string, pin: string, terminalCode?: string) => {
    const r = await api('POST', '/api/auth/login', { employeeCode, pin, terminalCode });
    if (r.status !== 200) throw new Error('login failed ' + JSON.stringify(r.body));
    return r.body.token as string;
  };
  return { pool, server, api, login, close: async () => { server.close(); await pool.end(); } };
}

export const uuid = () => crypto.randomUUID();
