import http from 'node:http';
import { createApp } from './app';
import { attachRealtime } from './realtime';
import { migrate } from './migrate';
import { config } from './config';
import { sweepCoupons } from './services/coupons';
import { expirePoints } from './services/points';
import { tx, pool } from './db';
import { seedIfEmpty } from './seed';

async function main() {
  await migrate();
  await seedIfEmpty();
  const app = createApp();
  const server = http.createServer(app);
  attachRealtime(server);

  // Housekeeping jobs
  setInterval(() => sweepCoupons().catch((e) => console.error('[sweep coupons]', e)), 60_000);
  setInterval(() => tx((db) => expirePoints(db)).catch((e) => console.error('[expire points]', e)), 3_600_000);
  setInterval(() => {
    pool.query(`UPDATE payment_intents SET status='expired' WHERE status='pending' AND created_at < now() - interval '30 minutes'`).catch(() => {});
    pool.query(`DELETE FROM display_pairings WHERE expires_at < now() - interval '1 day'`).catch(() => {});
    pool.query(`DELETE FROM staff_sessions WHERE expires_at < now() - interval '7 days'`).catch(() => {});
  }, 300_000);

  server.listen(config.port, () => console.log(`[ppmart] API + WebSocket listening on http://localhost:${config.port}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
