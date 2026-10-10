import { Router, type Request } from 'express';
import { z } from 'zod';
import { pool, q, one } from '../db';
import { requireStaff, requirePerm } from '../auth';
import { parse, bad, notFound, conflict, hmac, safeEqual, HttpError } from '../util';
import { config } from '../config';
import { getSetting } from '../settings';
import { promptPayPayload } from '../../../shared/promptpay';
import { publish, terminalChannel, broadcastStaff } from '../realtime';
import { audit } from '../audit';

export const paymentsRouter = Router();

async function notify(intent: any) {
  const payload = { id: intent.id, status: intent.status, method: intent.method, amount: intent.amount, reference: intent.reference };
  if (intent.terminal_id) publish(terminalChannel(intent.terminal_id), 'payment.updated', payload);
  broadcastStaff('payment.review', payload);
}

// ---- Omise (Opn Payments) adapter: real Dynamic PromptPay QR ----
async function omise(path: string, body?: Record<string, string>) {
  const r = await fetch('https://api.omise.co' + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: 'Basic ' + Buffer.from(config.omiseSecret + ':').toString('base64'), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
  const j: any = await r.json();
  if (!r.ok || j.object === 'error') throw new HttpError(502, 'Payment gateway error: ' + (j.message || r.status), 'GATEWAY');
  return j;
}

async function markPaid(intentId: string, raw: any, verifiedBy: number | null, reference?: string | null) {
  const r = await one(
    `UPDATE payment_intents SET status='paid', paid_at=now(), raw=COALESCE($2, raw), verified_by=$3, reference=COALESCE($4, reference)
     WHERE id=$1 AND status IN ('pending','needs_review') RETURNING *`, [intentId, raw ? JSON.stringify(raw) : null, verifiedBy, reference ?? null]);
  if (r) await notify(r);
  return r;
}

paymentsRouter.post('/intents', requireStaff, requirePerm('pos.sell'), async (req, res) => {
  const b = parse(z.object({ method: z.enum(['promptpay', 'transfer', 'ewallet']), amount: z.number().int().positive(), cartId: z.string() }), req.body);
  const store = await getSetting('store');
  let provider = 'manual';
  let qrPayload: string | null = null, qrImage: string | null = null, providerRef: string | null = null, raw: any = null;
  if (b.method === 'promptpay') {
    if (config.omiseSecret) {
      provider = 'omise';
      const charge = await omise('/charges', { amount: String(b.amount), currency: 'thb', 'source[type]': 'promptpay', 'metadata[cart_id]': b.cartId });
      providerRef = charge.id;
      qrImage = charge.source?.scannable_code?.image?.download_uri ?? null;
      raw = { chargeId: charge.id };
    } else {
      if (!store.promptPayId) throw bad('ยังไม่ได้ตั้งค่าหมายเลขพร้อมเพย์ของร้าน (ตั้งค่า → ร้านค้า)', 'NO_PROMPTPAY');
      provider = 'promptpay_local';
      qrPayload = promptPayPayload(store.promptPayId, b.amount);
    }
  }
  const it = await one(
    `INSERT INTO payment_intents (provider, method, amount, qr_payload, qr_image_url, provider_ref, cart_id, terminal_id, created_by, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [provider, b.method, b.amount, qrPayload, qrImage, providerRef, b.cartId, req.staff!.terminalId, req.staff!.id, raw ? JSON.stringify(raw) : null]);
  res.json(it);
});

paymentsRouter.get('/intents/:id', requireStaff, async (req, res) => {
  let it = await one('SELECT * FROM payment_intents WHERE id=$1', [String(req.params.id)]);
  if (!it) throw notFound();
  // Gateway polling fallback (in case webhook is delayed)
  if (it.provider === 'omise' && it.status === 'pending' && it.provider_ref) {
    try {
      const ch = await omise('/charges/' + it.provider_ref);
      if (ch.status === 'successful' && ch.amount === Number(it.amount)) it = (await markPaid(it.id, { charge: ch.id, status: ch.status }, null)) ?? it;
      else if (ch.status === 'failed' || ch.status === 'expired') {
        it = await one(`UPDATE payment_intents SET status=$2 WHERE id=$1 AND status='pending' RETURNING *`, [it.id, ch.status === 'failed' ? 'failed' : 'expired']) ?? it;
      }
    } catch (e) { console.warn('[omise poll]', (e as Error).message); }
  }
  res.json(it);
});

/** Cashier attaches the customer's slip / reference: goes to staff review (never auto-approved from slip image). */
paymentsRouter.post('/intents/:id/slip', requireStaff, async (req, res) => {
  const b = parse(z.object({ image: z.string().max(4_000_000).optional(), reference: z.string().max(100).optional() }), req.body);
  const it = await one(`UPDATE payment_intents SET slip_image=COALESCE($2, slip_image), reference=COALESCE($3, reference), status='needs_review'
    WHERE id=$1 AND status IN ('pending','needs_review') RETURNING *`, [String(req.params.id), b.image ?? null, b.reference ?? null]);
  if (!it) throw conflict('สถานะรายการไม่สามารถแนบสลิปได้');
  await notify(it);
  res.json(it);
});

paymentsRouter.post('/intents/:id/verify', requireStaff, requirePerm('payments.verify'), async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), reference: z.string().min(3, 'กรุณาระบุเลขอ้างอิงจากรายการเดินบัญชี').optional(), note: z.string().optional() }), req.body);
  const it = await one('SELECT * FROM payment_intents WHERE id=$1', [String(req.params.id)]);
  if (!it) throw notFound();
  let r;
  if (b.approve) {
    if (!b.reference) throw bad('ต้องระบุเลขอ้างอิงธุรกรรมที่ตรวจสอบจากบัญชีธนาคาร/แอป', 'REFERENCE_REQUIRED');
    r = await markPaid(it.id, null, req.staff!.id, b.reference);
  } else {
    r = await one(`UPDATE payment_intents SET status='failed', verified_by=$2 WHERE id=$1 AND status IN ('pending','needs_review') RETURNING *`, [it.id, req.staff!.id]);
    if (r) await notify(r);
  }
  if (!r) throw conflict('รายการนี้ถูกดำเนินการไปแล้ว');
  await audit({ staffId: req.staff!.id, staffName: req.staff!.name, action: b.approve ? 'payment.verified' : 'payment.rejected', entity: 'payment_intent', entityId: it.id, reason: b.note, details: { amount: it.amount, method: it.method, reference: b.reference }, ip: req.ip });
  res.json(r);
});

paymentsRouter.post('/intents/:id/cancel', requireStaff, async (req, res) => {
  const r = await one(`UPDATE payment_intents SET status='cancelled' WHERE id=$1 AND status IN ('pending','needs_review') AND sale_id IS NULL RETURNING *`, [String(req.params.id)]);
  if (r) await notify(r);
  res.json(r ?? { ok: false });
});

paymentsRouter.get('/review', requireStaff, requirePerm('payments.verify'), async (_req, res) => {
  res.json(await q(`SELECT pi.*, t.code AS terminal_code, s.name AS created_by_name FROM payment_intents pi LEFT JOIN terminals t ON t.id=pi.terminal_id
    LEFT JOIN staff s ON s.id=pi.created_by WHERE pi.status IN ('pending','needs_review') AND pi.provider <> 'omise' AND pi.created_at > now() - interval '2 days' ORDER BY pi.created_at DESC`));
});

paymentsRouter.get('/history', requireStaff, requirePerm('payments.verify', 'reports.view'), async (_req, res) => {
  res.json(await q(`SELECT pi.id, pi.provider, pi.method, pi.amount, pi.status, pi.reference, pi.provider_ref, pi.created_at, pi.paid_at, pi.sale_id, v.name AS verified_by_name
    FROM payment_intents pi LEFT JOIN staff v ON v.id=pi.verified_by ORDER BY pi.created_at DESC LIMIT 200`));
});

// ---- Webhooks ----
export const paymentWebhookRouter = Router();

/** Omise sends unsigned events: we re-fetch the charge from the API before trusting it. */
paymentWebhookRouter.post('/omise', async (req, res) => {
  const ev = req.body;
  const chargeId = ev?.data?.object === 'charge' ? ev.data.id : null;
  if (!chargeId || !config.omiseSecret) return res.json({ ok: true });
  const ch = await omise('/charges/' + chargeId);
  const it = await one(`SELECT * FROM payment_intents WHERE provider='omise' AND provider_ref=$1`, [chargeId]);
  if (it && ch.status === 'successful' && ch.amount === Number(it.amount)) await markPaid(it.id, { charge: ch.id, status: ch.status }, null);
  res.json({ ok: true });
});

/** Generic gateway: body {intentId, status:'paid'|'failed', amount, providerRef}; header X-Signature = HMAC-SHA256(raw body). */
paymentWebhookRouter.post('/generic', async (req: Request & { rawBody?: string }, res) => {
  if (!config.paymentWebhookSecret) throw bad('Webhook not configured');
  const sig = String(req.headers['x-signature'] || '');
  if (!safeEqual(sig, hmac(req.rawBody || '', config.paymentWebhookSecret))) throw new HttpError(401, 'invalid signature');
  const b = parse(z.object({ intentId: z.string().uuid(), status: z.enum(['paid', 'failed']), amount: z.number().int(), providerRef: z.string() }), req.body);
  const it = await one('SELECT * FROM payment_intents WHERE id=$1', [b.intentId]);
  if (!it) throw notFound();
  if (b.status === 'paid') {
    if (b.amount !== Number(it.amount)) throw bad('amount mismatch');
    await pool.query('UPDATE payment_intents SET provider_ref=$2 WHERE id=$1 AND provider_ref IS NULL', [it.id, b.providerRef]);
    await markPaid(it.id, b, null);
  } else {
    const r = await one(`UPDATE payment_intents SET status='failed' WHERE id=$1 AND status='pending' RETURNING *`, [it.id]);
    if (r) await notify(r);
  }
  res.json({ ok: true });
});
