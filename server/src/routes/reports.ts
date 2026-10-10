import { Router } from 'express';
import { q, one } from '../db';
import { requireStaff, requirePerm, can } from '../auth';
import { getSetting } from '../settings';
import { config } from '../config';

export const reportsRouter = Router();
reportsRouter.use(requireStaff, requirePerm('reports.view'));

function filters(qs: any, tz: string) {
  const params: any[] = [];
  const add = (v: any) => { params.push(v); return '$' + params.length; };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const from = qs.from || today;
  const to = qs.to || today;
  const w = [`s.status <> 'voided'`, `(s.created_at AT TIME ZONE ${add(tz)})::date BETWEEN ${add(from)}::date AND ${add(to)}::date`];
  if (qs.branchId) w.push(`s.branch_id = ${add(Number(qs.branchId))}`);
  if (qs.staffId) w.push(`s.staff_id = ${add(Number(qs.staffId))}`);
  if (qs.terminalId) w.push(`s.terminal_id = ${add(Number(qs.terminalId))}`);
  if (qs.method) w.push(`EXISTS (SELECT 1 FROM sale_payments spx WHERE spx.sale_id=s.id AND spx.method=${add(String(qs.method))})`);
  let itemW = '';
  if (qs.categoryId) itemW = ` AND p.category_id = ${add(Number(qs.categoryId))}`;
  return { where: w.join(' AND '), itemW, params, from, to, tzParam: '$1' };
}

reportsRouter.get('/summary', async (req, res) => {
  const tz = (await getSetting('store')).timeZone || config.timeZone;
  const f = filters(req.query, tz);
  const showCost = can(req.staff, 'reports.cost');
  const W = f.where, P = f.params, TZ = f.tzParam;
  const itemsFrom = `FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id WHERE ${W}${f.itemW}`;
  const netQty = `(si.qty - si.refunded_qty)`;
  const netAmt = `(si.line_total - ROUND(si.line_total * si.refunded_qty / NULLIF(si.qty,0)))`;

  const [totals, items, byDay, byHour, byBranch, byMethod, byStaff, byTerminal, byCategory, top, slow, refunds] = await Promise.all([
    one(`SELECT COUNT(*)::int AS bills, COALESCE(SUM(s.total),0)::bigint AS gross_sales, COALESCE(SUM(s.discount_total),0)::bigint AS discounts,
      COALESCE(SUM(s.vat_amount),0)::bigint AS vat, COALESCE(SUM(s.coupon_discount),0)::bigint AS coupon_discount, COUNT(DISTINCT s.member_id)::int AS members
      FROM sales s WHERE ${W}`, P),
    one(`SELECT COALESCE(SUM(${netAmt}),0)::bigint AS net_sales, COALESCE(SUM(si.unit_cost * ${netQty}),0)::bigint AS cost, COALESCE(SUM(${netQty}),0) AS qty ${itemsFrom}`, P),
    q(`SELECT (s.created_at AT TIME ZONE ${TZ})::date::text AS day, COUNT(*)::int AS bills, SUM(s.total)::bigint AS total FROM sales s WHERE ${W} GROUP BY 1 ORDER BY 1`, P),
    q(`SELECT EXTRACT(HOUR FROM s.created_at AT TIME ZONE ${TZ})::int AS hour, COUNT(*)::int AS bills, SUM(s.total)::bigint AS total FROM sales s WHERE ${W} GROUP BY 1 ORDER BY 1`, P),
    q(`SELECT b.id, b.name, COUNT(*)::int AS bills, SUM(s.total)::bigint AS total FROM sales s JOIN branches b ON b.id=s.branch_id WHERE ${W} GROUP BY b.id ORDER BY total DESC`, P),
    q(`SELECT sp.method, COUNT(DISTINCT sp.sale_id)::int AS bills, SUM(sp.amount)::bigint AS total FROM sale_payments sp JOIN sales s ON s.id=sp.sale_id WHERE ${W} GROUP BY 1 ORDER BY total DESC`, P),
    q(`SELECT st.id, st.name, COUNT(*)::int AS bills, SUM(s.total)::bigint AS total FROM sales s JOIN staff st ON st.id=s.staff_id WHERE ${W} GROUP BY st.id ORDER BY total DESC`, P),
    q(`SELECT t.id, t.code, t.name, COUNT(*)::int AS bills, SUM(s.total)::bigint AS total FROM sales s JOIN terminals t ON t.id=s.terminal_id WHERE ${W} GROUP BY t.id ORDER BY total DESC`, P),
    q(`SELECT c.id, COALESCE(c.name,'ไม่ระบุหมวด') AS name, SUM(${netQty}) AS qty, SUM(${netAmt})::bigint AS total ${showCost ? `, SUM(si.unit_cost * ${netQty})::bigint AS cost` : ''}
      FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id LEFT JOIN categories c ON c.id=p.category_id WHERE ${W}${f.itemW} GROUP BY c.id, c.name ORDER BY total DESC`, P),
    q(`SELECT p.id, p.sku, p.name, SUM(${netQty}) AS qty, SUM(${netAmt})::bigint AS total ${showCost ? `, SUM(si.unit_cost * ${netQty})::bigint AS cost` : ''} ${itemsFrom} GROUP BY p.id ORDER BY total DESC LIMIT 20`, P),
    q(`SELECT p.id, p.sku, p.name, COALESCE(SUM(sl.qty),0) AS on_hand,
        COALESCE((SELECT SUM(si.qty - si.refunded_qty) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.product_id=p.id AND ${W}),0) AS sold
      FROM products p LEFT JOIN stock_levels sl ON sl.product_id=p.id WHERE p.is_active AND p.track_stock GROUP BY p.id HAVING COALESCE(SUM(sl.qty),0) > 0 ORDER BY sold ASC, on_hand DESC LIMIT 20`, P),
    one(`SELECT COUNT(*)::int AS n, COALESCE(SUM(r.total),0)::bigint AS total FROM refunds r JOIN sales s ON s.id=r.sale_id WHERE ${W.replace(`s.status <> 'voided'`, 'true')}`, P),
  ]);

  const tzToday = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const kpi = await one(`SELECT
      COALESCE(SUM(total) FILTER (WHERE (created_at AT TIME ZONE $1)::date = $2::date),0)::bigint AS today_total,
      COUNT(*) FILTER (WHERE (created_at AT TIME ZONE $1)::date = $2::date)::int AS today_bills,
      COALESCE(SUM(total) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE $1) = date_trunc('month', $2::date)),0)::bigint AS month_total,
      COUNT(*) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE $1) = date_trunc('month', $2::date))::int AS month_bills
    FROM sales WHERE status <> 'voided' AND created_at > now() - interval '40 days' AND ($3::int IS NULL OR branch_id=$3)`, [tz, tzToday, req.query.branchId ? Number(req.query.branchId) : null]);
  const alerts = await one(`SELECT
      (SELECT COUNT(*) FROM stock_lots WHERE qty > 0 AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + 30)::int AS expiring,
      (SELECT COUNT(*) FROM products p JOIN stock_levels sl ON sl.product_id=p.id WHERE p.is_active AND p.min_stock > 0 AND sl.qty <= p.min_stock)::int AS low_stock,
      (SELECT COUNT(*) FROM payment_intents WHERE status='needs_review')::int AS payments_review,
      (SELECT COUNT(*) FROM coupons WHERE status='PENDING_REVIEW')::int AS coupons_review`);

  const net = Number(items.net_sales);
  const cost = Number(items.cost);
  res.json({
    range: { from: f.from, to: f.to },
    kpi,
    totals: { ...totals, net_sales: net, avg_bill: totals.bills ? Math.round(Number(totals.gross_sales) / totals.bills) : 0, qty: items.qty,
      ...(showCost ? { cost, gross_profit: net - cost, margin: net ? (net - cost) / net : 0 } : {}) },
    refunds, byDay, byHour, byBranch, byMethod, byStaff, byTerminal, byCategory, top, slow, alerts, showCost,
  });
});

reportsRouter.get('/sales', async (req, res) => {
  const tz = (await getSetting('store')).timeZone || config.timeZone;
  const f = filters(req.query, tz);
  res.json(await q(`SELECT s.id, s.bill_no, s.created_at, s.status, s.subtotal, s.discount_total, s.coupon_discount, s.vat_amount, s.total, s.items_count,
      b.name AS branch, t.code AS terminal, st.name AS staff, m.member_no,
      (SELECT string_agg(sp.method || ':' || (sp.amount/100.0)::text, ', ') FROM sale_payments sp WHERE sp.sale_id=s.id) AS payments
    FROM sales s JOIN branches b ON b.id=s.branch_id JOIN terminals t ON t.id=s.terminal_id JOIN staff st ON st.id=s.staff_id LEFT JOIN members m ON m.id=s.member_id
    WHERE ${f.where.replace(`s.status <> 'voided'`, 'true')} ORDER BY s.created_at DESC LIMIT 5000`, f.params));
});

reportsRouter.get('/products', async (req, res) => {
  const tz = (await getSetting('store')).timeZone || config.timeZone;
  const f = filters(req.query, tz);
  const showCost = can(req.staff, 'reports.cost');
  res.json(await q(`SELECT p.sku, p.name, c.name AS category, SUM(si.qty - si.refunded_qty) AS qty, SUM(si.line_total - ROUND(si.line_total * si.refunded_qty / NULLIF(si.qty,0)))::bigint AS total,
      SUM(si.discount)::bigint AS discount ${showCost ? ', SUM(si.unit_cost * (si.qty - si.refunded_qty))::bigint AS cost' : ''}
    FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id LEFT JOIN categories c ON c.id=p.category_id
    WHERE ${f.where}${f.itemW} GROUP BY p.id, c.name ORDER BY total DESC`, f.params));
});
