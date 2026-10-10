// Barcode utilities: GTIN check digits and in-store variable-measure (weighted) EAN-13 parsing.

export function gtinCheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const d = Number(body[body.length - 1 - i]);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return (10 - (sum % 10)) % 10;
}

/** Validate EAN-8, UPC-A (12), EAN-13, GTIN-14 check digit. */
export function isValidGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false;
  return gtinCheckDigit(code.slice(0, -1)) === Number(code[code.length - 1]);
}

export type BarcodeKind = 'EAN-13' | 'EAN-8' | 'UPC-A' | 'GTIN-14' | 'COUPON' | 'MEMBER' | 'GIFT' | 'CODE128';

export function classifyBarcode(code: string): BarcodeKind {
  if (/^CPN-[A-Z0-9]{8,}$/i.test(code)) return 'COUPON';
  if (/^M\d{6,}$/i.test(code)) return 'MEMBER';
  if (/^GC-[A-Z0-9]+$/i.test(code)) return 'GIFT';
  if (/^\d{13}$/.test(code) && isValidGtin(code)) return 'EAN-13';
  if (/^\d{8}$/.test(code) && isValidGtin(code)) return 'EAN-8';
  if (/^\d{12}$/.test(code) && isValidGtin(code)) return 'UPC-A';
  if (/^\d{14}$/.test(code) && isValidGtin(code)) return 'GTIN-14';
  return 'CODE128';
}

export interface WeightedBarcodeConfig {
  /** Leading digits that indicate an in-store weighed item, e.g. ["20","21","22","23","24","25","26","27","28","29"] */
  prefixes: string[];
  /** Number of digits for the item (PLU) code after the prefix. */
  itemDigits: number;
  /** 'weight' => value is grams; 'price' => value is satang */
  mode: 'weight' | 'price';
}

export const DEFAULT_WEIGHTED: WeightedBarcodeConfig = { prefixes: ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'], itemDigits: 5, mode: 'weight' };

/**
 * Parse a variable-measure EAN-13 printed by a label scale:  PP IIIII VVVVV C
 * Returns the item code (used to look up the PLU barcode "PP"+"IIIII") and weight(kg) or price(satang).
 */
export function parseWeightedBarcode(code: string, cfg: WeightedBarcodeConfig = DEFAULT_WEIGHTED) {
  if (!/^\d{13}$/.test(code) || !isValidGtin(code)) return null;
  const prefix = cfg.prefixes.find((p) => code.startsWith(p));
  if (!prefix) return null;
  const itemEnd = prefix.length + cfg.itemDigits;
  const plu = code.slice(0, itemEnd);
  const value = Number(code.slice(itemEnd, 12));
  if (cfg.mode === 'weight') return { plu, weightKg: value / 1000, priceSatang: null as number | null };
  return { plu, weightKg: null as number | null, priceSatang: value };
}
