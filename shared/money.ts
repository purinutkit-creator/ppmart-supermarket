// Money helpers. All amounts are integer satang (1 THB = 100 satang).

export const toSatang = (baht: number | string): number => Math.round(Number(baht) * 100);
export const toBaht = (satang: number): number => satang / 100;

export function fmtMoney(satang: number, symbol = '฿'): string {
  const neg = satang < 0;
  const v = Math.abs(satang) / 100;
  const s = v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? '-' : ''}${symbol}${s}`;
}

/** Plain number without symbol: 1,234.50 */
export const fmtNum = (satang: number) => fmtMoney(satang, '');

export function fmtQty(qty: number, weighted = false): string {
  if (weighted) return qty.toFixed(3);
  return Number.isInteger(qty) ? String(qty) : qty.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export const roundQty = (q: number) => Math.round(q * 1000) / 1000;

/** Split `amount` across `weights` proportionally using the largest-remainder method (exact sum). */
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || amount === 0) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const floored = raw.map((r) => Math.floor(r));
  let rest = amount - floored.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) floored[order[k][1]]++;
  return floored;
}
