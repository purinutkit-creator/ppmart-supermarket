import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { errorHandler, notFound } from './util';
import { one, pool } from './db';
import { authRouter } from './routes/auth';
import { posRouter, displayPublicRouter } from './routes/pos';
import { paymentsRouter, paymentWebhookRouter } from './routes/payments';
import { shiftsRouter } from './routes/shifts';
import { productsRouter } from './routes/products';
import { stockRouter } from './routes/stock';
import { membersRouter, memberPortalRouter } from './routes/members';
import { marketingRouter } from './routes/marketing';
import { purchasingRouter } from './routes/purchasing';
import { reportsRouter } from './routes/reports';
import { adminRouter } from './routes/admin';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({
    limit: '25mb',
    verify: (req: any, _res, buf) => { if (req.url.startsWith('/api/payments/webhook')) req.rawBody = buf.toString('utf8'); },
  }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/api/health', async (_req, res) => {
    const db = await pool.query('SELECT 1').then(() => true).catch(() => false);
    res.status(db ? 200 : 503).json({ ok: db, db, time: new Date().toISOString() });
  });

  // public: uploaded font files (used by POS canvas renderer, displays and member site)
  app.get('/api/fonts/:id/file', async (req, res) => {
    const f = await one('SELECT family, format, data FROM fonts WHERE id=$1 AND source=$2', [req.params.id, 'upload']);
    if (!f) throw notFound();
    const types: Record<string, string> = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2' };
    res.setHeader('Content-Type', types[f.format] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(f.data);
  });
  app.get('/api/fonts', async (_req, res) => {
    const { q } = await import('./db');
    res.json(await q('SELECT id, family, source, format, weight FROM fonts ORDER BY family'));
  });

  app.use('/api/auth', authRouter);
  app.use('/api/pos', posRouter);
  app.use('/api/display', displayPublicRouter);
  app.use('/api/payments/webhook', paymentWebhookRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/shifts', shiftsRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/stock', stockRouter);
  app.use('/api/members', membersRouter);
  app.use('/api/member', memberPortalRouter);
  app.use('/api/marketing', marketingRouter);
  app.use('/api/purchasing', purchasingRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', (_req, _res, next) => next(notFound('API not found')));

  // Serve the built web app (production)
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
