import { describe, it, expect } from 'vitest';
import { priceCart, evaluateCouponIssuance, type PromotionDef } from '../../shared/pricing';
import { promptPayPayload, crc16ccitt } from '../../shared/promptpay';
import { parseWeightedBarcode, isValidGtin, gtinCheckDigit } from '../../shared/barcode';
import { allocate } from '../../shared/money';

const products = new Map([
  [1, { id: 1, name: 'Water', price: 1000, categoryId: 1 }],
  [2, { id: 2, name: 'Milk', price: 4500, categoryId: 2, memberPrice: 4200 }],
  [3, { id: 3, name: 'Rice', price: 18900, categoryId: 3, vatExempt: true }],
]);
const ctx = { now: new Date('2026-10-10T10:00:00Z'), timeZone: 'Asia/Bangkok', branchId: 1, vat: { mode: 'inclusive' as const, rate: 7 } };
const promo = (o: Partial<PromotionDef>): PromotionDef => ({ id: 1, name: 'p', type: 'bxgy', priority: 1, stackable: false, params: {}, ...o });

describe('pricing engine', () => {
  it('buy 1 get 1 frees the cheapest units', () => {
    const r = priceCart({ lines: [{ lineId: 'a', productId: 1, qty: 3 }], products, promotions: [promo({ productIds: [1], params: { buy: 1, get: 1 } })], ctx });
    expect(r.subtotal).toBe(3000);
    expect(r.total).toBe(2000);
  });
  it('member price applies only with a member', () => {
    const lines = [{ lineId: 'a', productId: 2, qty: 2 }];
    expect(priceCart({ lines, products, promotions: [], ctx }).total).toBe(9000);
    expect(priceCart({ lines, products, promotions: [], ctx: { ...ctx, member: { id: 1 } } }).total).toBe(8400);
  });
  it('bill threshold + coupon + VAT; line totals always sum to total', () => {
    const r = priceCart({
      lines: [{ lineId: 'a', productId: 1, qty: 7 }, { lineId: 'b', productId: 2, qty: 3 }, { lineId: 'c', productId: 3, qty: 1 }],
      products, promotions: [promo({ id: 2, type: 'bill_threshold', params: { minSpend: 30000, amount: 3333 } })],
      coupons: [{ id: 'x', code: 'CPN-X', title: 't', minSpend: 10000, reward: { type: 'amount', value: 5000 } }], ctx,
    });
    expect(r.subtotal).toBe(7000 + 13500 + 18900);
    expect(r.couponResults[0].ok).toBe(true);
    expect(r.total).toBe(r.subtotal - 3333 - 5000);
    expect(r.lines.reduce((a, l) => a + l.total, 0)).toBe(r.total);
    const vatBase = r.lines.filter((l) => !l.vatExempt).reduce((a, l) => a + l.total, 0);
    expect(r.vatAmount).toBe(Math.round((vatBase * 7) / 107));
  });
  it('coupon min spend is enforced', () => {
    const r = priceCart({ lines: [{ lineId: 'a', productId: 1, qty: 1 }], products, promotions: [], coupons: [{ id: 'x', code: 'C', title: 't', minSpend: 50000, reward: { type: 'amount', value: 5000 } }], ctx });
    expect(r.couponResults[0].ok).toBe(false);
    expect(r.total).toBe(1000);
  });
  it('time window and day-of-week restrictions', () => {
    const p = promo({ type: 'percent_off', params: { percent: 50 }, timeStart: '18:00', timeEnd: '20:00' });
    const lines = [{ lineId: 'a', productId: 1, qty: 1 }];
    expect(priceCart({ lines, products, promotions: [p], ctx }).total).toBe(1000); // 17:00 local
    expect(priceCart({ lines, products, promotions: [p], ctx: { ...ctx, now: new Date('2026-10-10T11:30:00Z') } }).total).toBe(500); // 18:30 local
  });
  it('coupon issuance with exclusive groups issues only the best tier', () => {
    const rules = [
      promo({ id: 10, type: 'receipt_coupon', priority: 10, params: { minSpend: 100000, exclusiveGroup: 'g', reward: { type: 'amount', value: 10000 } } }),
      promo({ id: 11, type: 'receipt_coupon', priority: 20, params: { minSpend: 50000, exclusiveGroup: 'g', reward: { type: 'amount', value: 5000 } } }),
      promo({ id: 12, type: 'receipt_coupon', priority: 30, params: { minSpend: 30000, exclusiveGroup: 'g', reward: { type: 'amount', value: 2000 } } }),
    ];
    const priced = priceCart({ lines: [{ lineId: 'a', productId: 1, qty: 65 }], products, promotions: [], ctx });
    const d = evaluateCouponIssuance(rules, priced, ctx, ['cash']);
    expect(d.map((x) => x.promotionId)).toEqual([11]);
  });
  it('allocate keeps exact sums', () => {
    const parts = allocate(1001, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1001);
  });
});

describe('barcodes & promptpay', () => {
  it('validates GTIN and parses weighted EAN-13', () => {
    expect(isValidGtin('885000100001' + gtinCheckDigit('885000100001'))).toBe(true);
    expect(isValidGtin('8850001000010')).toBe(gtinCheckDigit('885000100001') === 0);
    const body = '200010101234';
    let sum = 0; for (let i = 0; i < 12; i++) sum += Number(body[11 - i]) * (i % 2 === 0 ? 3 : 1);
    const code = body + ((10 - (sum % 10)) % 10);
    expect(parseWeightedBarcode(code)).toEqual({ plu: '2000101', weightKg: 1.234, priceSatang: null });
  });
  it('generates a valid PromptPay payload with CRC', () => {
    const p = promptPayPayload('0812345678', 8500);
    expect(p.startsWith('000201010212')).toBe(true);
    expect(p).toContain('5405' + '85.00');
    expect(crc16ccitt(p.slice(0, -4))).toBe(p.slice(-4));
    expect(crc16ccitt('123456789')).toBe('29B1');
  });
});
