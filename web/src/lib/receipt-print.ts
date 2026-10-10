// Orchestrates the 2-receipt auto print after a successful payment.
import { renderReceipt } from './receipt-render';
import { receiptJob, EscPos } from './escpos';
import { printer, type PrintJob } from './printer';
import { api } from './api';
import { defaultTemplates, type ReceiptData, type ReceiptTemplate } from '../../../shared/receipt';

export interface ReceiptSettings {
  summary: ReceiptTemplate;
  customer: ReceiptTemplate;
  printOrder: ('summary' | 'customer')[];
  copies: { summary: number; customer: number };
  autoPrint: { summary: boolean; customer: boolean };
}

let settingsCache: { receipt: ReceiptSettings; store: any; tax: any } | null = null;
export function setPrintSettings(s: { receipt: ReceiptSettings | null; store: any; tax: any }) {
  const d = defaultTemplates();
  settingsCache = { receipt: s.receipt ?? { summary: d.summary, customer: d.customer, printOrder: ['summary', 'customer'], copies: { summary: 1, customer: 1 }, autoPrint: { summary: true, customer: true } }, store: s.store, tax: s.tax };
}
export const printSettings = () => settingsCache;

/** Map a server receipt payload into renderer data. */
export function toReceiptData(r: any, store: any, tax?: any, reprint = false): ReceiptData {
  return {
    store: { name: store?.name ?? 'SUPERMARKET', logo: store?.logo, address: store?.address, phone: store?.phone, taxId: store?.taxId, timeZone: store?.timeZone },
    branch: r.branch, terminal: r.terminal, staff: r.staff, sale: r.sale, member: r.member, items: r.items, payments: r.payments,
    discounts: r.discounts, coupons: r.coupons ?? [], vatRate: tax?.rate ?? 7, reprint,
  };
}

/** Apply the printer's physical paper width/DPI to the template so the bitmap matches the device. */
function forDevice(t: ReceiptTemplate): ReceiptTemplate {
  const c = printer.config;
  return c ? { ...t, paperWidth: c.paperWidth, dpi: c.dpi || t.dpi } : t;
}

export async function buildReceiptBytes(kind: 'summary' | 'customer', data: ReceiptData, openDrawer = false) {
  const s = settingsCache!;
  const tpl = forDevice(s.receipt[kind]);
  const canvas = await renderReceipt(tpl, data);
  return { bytes: receiptJob(canvas, { cut: tpl.cut, feedLines: tpl.feedLines, openDrawer }), canvas };
}

/** Called after checkout commits. Printing failures never touch the sale/payment. */
export function printSaleReceipts(data: ReceiptData, opts: { openDrawer?: boolean; only?: 'summary' | 'customer'; force?: boolean } = {}) {
  const s = settingsCache;
  if (!s) return [];
  const jobs: PrintJob[] = [];
  let drawerPending = !!opts.openDrawer;
  for (const kind of s.receipt.printOrder) {
    if (opts.only && opts.only !== kind) continue;
    if (!opts.force && !s.receipt.autoPrint[kind]) continue;
    const copies = Math.max(1, Number(s.receipt.copies[kind] || 1));
    for (let i = 0; i < copies; i++) {
      const kick = drawerPending; drawerPending = false;
      jobs.push(printer.enqueue({ saleId: data.sale.id, billNo: data.sale.billNo, kind, build: () => buildReceiptBytes(kind, data, kick), rebuild: data.sale.id > 0 ? { type: 'receipt', kind, saleId: data.sale.id } : undefined }));
    }
  }
  if (drawerPending) openDrawer();
  return jobs;
}

export function openDrawer() {
  const pin = printer.config?.drawer?.pin ?? 0;
  return printer.enqueue({ saleId: null, kind: 'drawer', build: async () => ({ bytes: new EscPos().init().drawer(pin).bytes() }) });
}

// After a page reload, failed jobs can still be retried: rebuild from the server copy of the receipt.
printer.rebuilder = async (job) => {
  if (job.rebuild?.type !== 'receipt' || !settingsCache) throw new Error('ไม่สามารถสร้างงานพิมพ์ใหม่');
  const r = await api(`/api/pos/sales/${job.rebuild.saleId}/receipt`);
  return buildReceiptBytes(job.rebuild.kind as any, toReceiptData(r, settingsCache.store, settingsCache.tax));
};
