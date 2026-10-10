// Receipt template model shared by the Receipt Designer, the bitmap renderer and the server seed.

export type ReceiptElementType =
  | 'logo' | 'store_name' | 'branch_name' | 'address' | 'phone' | 'tax_id' | 'title' | 'receipt_no' | 'datetime'
  | 'cashier' | 'terminal' | 'member' | 'items' | 'item_count' | 'subtotal' | 'discount' | 'vat' | 'grand_total'
  | 'payment_method' | 'cash_received' | 'change' | 'points' | 'qr' | 'barcode' | 'promotion' | 'coupon'
  | 'custom_text' | 'thank_you' | 'divider' | 'spacer';

export interface TextStyle {
  fontFamily: string;
  fontSize: number; // points (converted to dots using printer DPI)
  fontWeight: number; // 100–900
  lineHeight: number; // multiplier
  letterSpacing: number; // px at printer resolution
  align: 'left' | 'center' | 'right';
  italic?: boolean;
  invert?: boolean; // white text on black band
}

export interface ReceiptElement {
  id: string;
  type: ReceiptElementType;
  hidden?: boolean;
  style?: Partial<TextStyle>;
  /** secondary styles: items => priceStyle; coupon => titleStyle/codeStyle; grand_total => labelStyle */
  styles?: Record<string, Partial<TextStyle>>;
  label?: string;
  text?: string; // custom text / thank you / promotion text; supports {placeholders}
  options?: Record<string, any>;
  marginTop?: number; // dots
  marginBottom?: number; // dots
}

export interface ReceiptTemplate {
  id: 'summary' | 'customer' | string;
  name: string;
  paperWidth: 58 | 80;
  dpi: number; // 203 typical, 180 some Epson, 300 hi-res
  marginX: number; // mm
  defaultStyle: TextStyle;
  elements: ReceiptElement[];
  feedLines: number; // lines fed before cut
  cut: 'full' | 'partial' | 'none';
  threshold?: number; // 0–255 bitmap threshold
}

export const ELEMENT_LABELS: Record<ReceiptElementType, string> = {
  logo: 'โลโก้', store_name: 'ชื่อร้าน', branch_name: 'ชื่อสาขา', address: 'ที่อยู่', phone: 'เบอร์โทร', tax_id: 'เลขประจำตัวผู้เสียภาษี',
  title: 'หัวใบเสร็จ', receipt_no: 'เลขที่ใบเสร็จ', datetime: 'วันที่และเวลา', cashier: 'แคชเชียร์', terminal: 'เครื่อง POS', member: 'สมาชิก',
  items: 'รายการสินค้า', item_count: 'จำนวนสินค้า', subtotal: 'ยอดรวม (Subtotal)', discount: 'ส่วนลด', vat: 'VAT', grand_total: 'ยอดสุทธิ',
  payment_method: 'วิธีชำระเงิน', cash_received: 'เงินรับ', change: 'เงินทอน', points: 'คะแนนสมาชิก', qr: 'QR Code', barcode: 'Barcode',
  promotion: 'ข้อความโปรโมชั่น', coupon: 'คูปองท้ายใบเสร็จ', custom_text: 'ข้อความกำหนดเอง', thank_you: 'ข้อความขอบคุณ', divider: 'เส้นคั่น', spacer: 'เว้นบรรทัด',
};

export interface ReceiptData {
  store: { name: string; logo?: string | null; address?: string; phone?: string; taxId?: string; currencySymbol?: string; timeZone?: string };
  branch: { name: string; address?: string | null; phone?: string | null; taxId?: string | null };
  terminal: { code: string; name: string };
  staff: { name: string; code?: string };
  sale: {
    id: number; billNo: string; createdAt: string; subtotal: number; discountTotal: number; couponDiscount: number; pointsDiscount: number;
    vatAmount: number; total: number; paidTotal: number; change: number; itemsCount: number; linesCount: number; pointsEarned: number; pointsRedeemed: number; offline?: boolean;
  };
  member: { memberNo: string; name: string; tier?: string | null; pointsBalance?: number } | null;
  items: { name: string; qty: number; unitPrice: number; discount: number; total: number; isWeighted?: boolean }[];
  payments: { method: string; amount: number; received?: number | null; change?: number; reference?: string | null }[];
  discounts: { source: string; name: string; amount: number }[];
  coupons: { code: string; barcodeValue: string; title: string; rewardText: string; expiresAt: string; minSpend: number }[];
  vatRate?: number;
  reprint?: boolean;
}

export const PAYMENT_LABELS: Record<string, string> = {
  cash: 'เงินสด', promptpay: 'พร้อมเพย์', transfer: 'โอนเงิน', credit_card: 'บัตรเครดิต', debit_card: 'บัตรเดบิต', ewallet: 'E-Wallet', gift_card: 'บัตรของขวัญ',
};

const base = (font: string): TextStyle => ({ fontFamily: font, fontSize: 9, fontWeight: 400, lineHeight: 1.25, letterSpacing: 0, align: 'left' });

export function defaultTemplates(font = 'Sarabun'): { summary: ReceiptTemplate; customer: ReceiptTemplate } {
  const id = (() => { let n = 0; return (t: string) => `${t}-${++n}`; })();
  const summary: ReceiptTemplate = {
    id: 'summary', name: 'Receipt 1 — Short Summary', paperWidth: 80, dpi: 203, marginX: 3, defaultStyle: base(font), feedLines: 3, cut: 'partial', threshold: 160,
    elements: [
      { id: id('s'), type: 'store_name', style: { fontSize: 14, fontWeight: 700, align: 'center' } },
      { id: id('s'), type: 'receipt_no', label: 'บิล #', style: { fontSize: 12, fontWeight: 700, align: 'center' } },
      { id: id('s'), type: 'terminal', label: 'เครื่อง ', style: { align: 'center' } },
      { id: id('s'), type: 'datetime', style: { align: 'center' } },
      { id: id('s'), type: 'divider' },
      { id: id('s'), type: 'item_count', label: 'สินค้า' },
      { id: id('s'), type: 'grand_total', label: 'ยอดสุทธิ', style: { fontSize: 12, fontWeight: 700 } },
      { id: id('s'), type: 'payment_method' },
      { id: id('s'), type: 'change', label: 'เงินทอน', style: { fontSize: 11, fontWeight: 700 } },
      { id: id('s'), type: 'divider' },
      { id: id('s'), type: 'custom_text', text: 'สำหรับพนักงาน', style: { align: 'center', fontWeight: 700 } },
    ],
  };
  const customer: ReceiptTemplate = {
    id: 'customer', name: 'Receipt 2 — Customer Receipt', paperWidth: 80, dpi: 203, marginX: 3, defaultStyle: base(font), feedLines: 3, cut: 'partial', threshold: 160,
    elements: [
      { id: id('c'), type: 'logo', options: { widthPct: 45 } },
      { id: id('c'), type: 'store_name', style: { fontSize: 15, fontWeight: 700, align: 'center' } },
      { id: id('c'), type: 'branch_name', style: { align: 'center' } },
      { id: id('c'), type: 'address', style: { align: 'center', fontSize: 8 } },
      { id: id('c'), type: 'phone', label: 'โทร ', style: { align: 'center', fontSize: 8 } },
      { id: id('c'), type: 'tax_id', label: 'เลขประจำตัวผู้เสียภาษี ', style: { align: 'center', fontSize: 8 } },
      { id: id('c'), type: 'title', text: 'ใบเสร็จรับเงิน / ใบกำกับภาษีอย่างย่อ', style: { align: 'center', fontWeight: 700, fontSize: 10 } },
      { id: id('c'), type: 'receipt_no', label: 'บิล #' },
      { id: id('c'), type: 'datetime', label: 'วันที่ ' },
      { id: id('c'), type: 'cashier', label: 'แคชเชียร์ ' },
      { id: id('c'), type: 'terminal', label: 'เครื่อง ' },
      { id: id('c'), type: 'member', label: 'สมาชิก ' },
      { id: id('c'), type: 'divider' },
      { id: id('c'), type: 'items', options: { showUnitPrice: true, showDiscount: true, maxItems: 0 }, styles: { price: { fontWeight: 600 } } },
      { id: id('c'), type: 'divider' },
      { id: id('c'), type: 'item_count', label: 'จำนวนสินค้า' },
      { id: id('c'), type: 'subtotal', label: 'รวมเป็นเงิน' },
      { id: id('c'), type: 'discount', label: 'ส่วนลด', options: { breakdown: true } },
      { id: id('c'), type: 'grand_total', label: 'ยอดสุทธิ', style: { fontSize: 13, fontWeight: 800 } },
      { id: id('c'), type: 'vat', label: 'VAT' },
      { id: id('c'), type: 'payment_method' },
      { id: id('c'), type: 'cash_received', label: 'รับเงิน' },
      { id: id('c'), type: 'change', label: 'เงินทอน', style: { fontWeight: 700 } },
      { id: id('c'), type: 'points', label: 'คะแนนที่ได้รับ' },
      { id: id('c'), type: 'divider' },
      { id: id('c'), type: 'barcode', options: { data: '{billNo}', height: 60, showText: false } },
      { id: id('c'), type: 'thank_you', text: 'ขอบคุณที่ใช้บริการ', style: { align: 'center', fontSize: 11, fontWeight: 700 } },
      { id: id('c'), type: 'coupon', options: { header: '🎁 SPECIAL COUPON', barcodeHeight: 70, singleUseText: 'ใช้ได้ 1 ครั้งเท่านั้น' },
        styles: { title: { fontSize: 12, fontWeight: 800, align: 'center' }, reward: { fontSize: 11, fontWeight: 700, align: 'center' }, code: { fontSize: 10, fontWeight: 600, align: 'center', letterSpacing: 2 } } },
    ],
  };
  return { summary, customer };
}
