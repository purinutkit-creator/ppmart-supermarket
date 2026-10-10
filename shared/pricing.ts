// Pure pricing / promotion / coupon engine.
// The SAME code runs on the POS (live cart, offline mode) and on the server (authoritative at checkout).

import { allocate, roundQty } from './money';

export interface PricingProduct {
  id: number;
  name: string;
  price: number; // satang
  memberPrice?: number | null;
  wholesalePrice?: number | null;
  wholesaleMinQty?: number | null;
  categoryId?: number | null;
  brandId?: number | null;
  vatExempt?: boolean;
  isWeighted?: boolean;
}

export interface CartLineInput {
  lineId: string;
  productId: number;
  qty: number;
  /** Unit price override (pack barcode price, approved price override, price-embedded barcode) */
  unitPrice?: number | null;
}

export interface PromotionDef {
  id: number;
  name: string;
  type: 'bxgy' | 'qty_percent' | 'bill_threshold' | 'special_price' | 'percent_off' | 'tier_price' | 'birthday' | 'receipt_coupon';
  isActive?: boolean;
  priority: number;
  stackable: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  daysOfWeek?: number[] | null; // 0=Sunday
  timeStart?: string | null; // "HH:MM[:SS]"
  timeEnd?: string | null;
  branchIds?: number[] | null;
  tierIds?: number[] | null;
  memberOnly?: boolean;
  productIds?: number[] | null;
  categoryIds?: number[] | null;
  brandIds?: number[] | null;
  promoCode?: string | null;
  usageLimit?: number | null;
  usageCount?: number;
  params: Record<string, any>;
}

export type CouponRewardType =
  | 'amount' | 'percent' | 'bogo' | 'free_item' | 'special_price'
  | 'product_discount' | 'category_discount' | 'bill_discount';

export interface CouponReward {
  type: CouponRewardType;
  /** amount in satang for amount-like rewards, percent for percent rewards, unit price for special_price */
  value: number;
  /** for product/category discount: 'amount' | 'percent' */
  valueType?: 'amount' | 'percent';
  productIds?: number[];
  categoryIds?: number[];
  maxDiscount?: number;
}

export interface CouponInput {
  id: string;
  code: string;
  title: string;
  reward: CouponReward;
  minSpend: number;
}

export interface MemberCtx {
  id: number;
  tierId?: number | null;
  birthday?: string | null; // YYYY-MM-DD
}

export interface PricingContext {
  now: Date;
  timeZone: string;
  branchId: number;
  member?: MemberCtx | null;
  promoCodes?: string[];
  vat: { mode: 'inclusive' | 'exclusive' | 'none'; rate: number };
  /** Member tier discount percent applied to whole bill (from tier settings) */
  tierDiscountPct?: number;
}

export interface PricingInput {
  lines: CartLineInput[];
  products: Map<number, PricingProduct> | Record<number, PricingProduct>;
  promotions: PromotionDef[];
  coupons?: CouponInput[];
  manualDiscount?: { type: 'amount' | 'percent'; value: number; reason?: string } | null;
  pointsDiscount?: number; // satang value of redeemed points
  ctx: PricingContext;
}

export interface PricedLine {
  lineId: string;
  productId: number;
  name: string;
  qty: number;
  regularUnitPrice: number;
  unitPrice: number;
  gross: number; // unitPrice * qty
  itemDiscount: number; // from item-level promotions
  billDiscountShare: number; // allocated bill-level discounts (promo/coupon/manual/points)
  total: number; // gross - itemDiscount - billDiscountShare
  promotionIds: number[];
  labels: string[];
  vatExempt: boolean;
  isWeighted: boolean;
  categoryId: number | null;
  brandId: number | null;
}

export interface AppliedDiscount {
  source: 'promotion' | 'coupon' | 'manual' | 'points' | 'tier';
  refId: string;
  name: string;
  amount: number;
}

export interface CouponResult {
  couponId: string;
  code: string;
  ok: boolean;
  amount: number;
  reason?: string;
}

export interface PricingResult {
  lines: PricedLine[];
  subtotal: number; // sum of gross
  itemDiscountTotal: number;
  discounts: AppliedDiscount[]; // all discounts (item promotions aggregated per promotion + bill-level)
  discountTotal: number; // all discounts incl. coupons/points/manual
  couponDiscount: number;
  pointsDiscount: number;
  manualDiscount: number;
  total: number; // amount payable
  vatAmount: number;
  vatBase: number;
  itemsCount: number;
  couponResults: CouponResult[];
}

// ---------- time helpers ----------
export function localParts(date: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(date)) p[x.type] = x.value;
  const dows = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    month: Number(p.month),
    day: Number(p.day),
    time: `${p.hour}:${p.minute}:${p.second}`,
    dow: dows.indexOf(p.weekday),
  };
}

const norm = (t: string) => (t.length === 5 ? t + ':00' : t);

function getProduct(products: PricingInput['products'], id: number): PricingProduct | undefined {
  return products instanceof Map ? products.get(id) : (products as Record<number, PricingProduct>)[id];
}

/** Common eligibility checks shared by discount promotions and coupon-issuing rules. */
export function promotionEligible(p: PromotionDef, ctx: PricingContext): boolean {
  if (p.isActive === false) return false;
  const now = ctx.now.getTime();
  if (p.startsAt && new Date(p.startsAt).getTime() > now) return false;
  if (p.endsAt && new Date(p.endsAt).getTime() < now) return false;
  const lp = localParts(ctx.now, ctx.timeZone);
  if (p.daysOfWeek && p.daysOfWeek.length && !p.daysOfWeek.includes(lp.dow)) return false;
  if (p.timeStart && p.timeEnd) {
    const s = norm(p.timeStart), e = norm(p.timeEnd);
    const inRange = s <= e ? lp.time >= s && lp.time <= e : lp.time >= s || lp.time <= e; // overnight
    if (!inRange) return false;
  }
  if (p.branchIds && p.branchIds.length && !p.branchIds.includes(ctx.branchId)) return false;
  if ((p.memberOnly || (p.tierIds && p.tierIds.length) || p.type === 'birthday' || p.type === 'tier_price') && !ctx.member) return false;
  if (p.tierIds && p.tierIds.length && !(ctx.member?.tierId && p.tierIds.includes(ctx.member.tierId))) return false;
  if (p.promoCode && !(ctx.promoCodes || []).some((c) => c.trim().toUpperCase() === p.promoCode!.trim().toUpperCase())) return false;
  if (p.usageLimit != null && (p.usageCount ?? 0) >= p.usageLimit) return false;
  if (p.type === 'birthday') {
    const b = ctx.member?.birthday;
    if (!b) return false;
    if (Number(b.slice(5, 7)) !== lp.month) return false;
  }
  return true;
}

function lineMatches(p: { productIds?: number[] | null; categoryIds?: number[] | null; brandIds?: number[] | null }, l: PricedLine): boolean {
  const hasP = !!p.productIds?.length, hasC = !!p.categoryIds?.length, hasB = !!(p as any).brandIds?.length;
  if (!hasP && !hasC && !hasB) return true;
  if (hasP && p.productIds!.includes(l.productId)) return true;
  if (hasC && l.categoryId != null && p.categoryIds!.includes(l.categoryId)) return true;
  if (hasB && l.brandId != null && (p as any).brandIds.includes(l.brandId)) return true;
  return false;
}

const net = (l: PricedLine) => l.gross - l.itemDiscount - l.billDiscountShare;

/** Spread `amount` over `targets` proportional to their current net and record it as item discount. */
function spreadItemDiscount(targets: PricedLine[], amount: number) {
  const parts = allocate(amount, targets.map((l) => Math.max(0, net(l))));
  targets.forEach((l, i) => (l.itemDiscount += parts[i]));
}

function spreadBillDiscount(targets: PricedLine[], amount: number) {
  const parts = allocate(amount, targets.map((l) => Math.max(0, net(l))));
  targets.forEach((l, i) => (l.billDiscountShare += parts[i]));
}

/** Units-based "cheapest free" helper: returns discount amount per line for `freeUnits` cheapest integer units. */
function cheapestUnitsDiscount(targets: PricedLine[], freeUnits: number): Map<PricedLine, number> {
  const units: { line: PricedLine; price: number }[] = [];
  for (const l of targets) {
    if (l.isWeighted) continue;
    const n = Math.floor(l.qty);
    const unitNet = Math.floor(net(l) / Math.max(1, l.qty));
    for (let i = 0; i < n; i++) units.push({ line: l, price: unitNet });
  }
  units.sort((a, b) => a.price - b.price);
  const out = new Map<PricedLine, number>();
  for (let i = 0; i < Math.min(freeUnits, units.length); i++) {
    out.set(units[i].line, (out.get(units[i].line) || 0) + units[i].price);
  }
  return out;
}

export function priceCart(input: PricingInput): PricingResult {
  const { ctx } = input;
  const isMember = !!ctx.member;
  const lines: PricedLine[] = [];

  for (const li of input.lines) {
    const p = getProduct(input.products, li.productId);
    if (!p) throw new Error(`Unknown product ${li.productId}`);
    const qty = roundQty(li.qty);
    let unit = li.unitPrice ?? p.price;
    const labels: string[] = [];
    if (li.unitPrice == null) {
      if (isMember && p.memberPrice != null && p.memberPrice < unit) {
        unit = p.memberPrice;
        labels.push('ราคาสมาชิก');
      }
      if (p.wholesalePrice != null && p.wholesaleMinQty && qty >= p.wholesaleMinQty && p.wholesalePrice < unit) {
        unit = p.wholesalePrice;
        labels.push('ราคาส่ง');
      }
    }
    lines.push({
      lineId: li.lineId, productId: p.id, name: p.name, qty,
      regularUnitPrice: p.price, unitPrice: unit, gross: Math.round(unit * qty),
      itemDiscount: 0, billDiscountShare: 0, total: 0, promotionIds: [], labels,
      vatExempt: !!p.vatExempt, isWeighted: !!p.isWeighted,
      categoryId: p.categoryId ?? null, brandId: p.brandId ?? null,
    });
  }

  const discounts: AppliedDiscount[] = [];
  const exclusive = new Set<PricedLine>(); // lines locked by a non-stackable promotion
  const promos = input.promotions
    .filter((p) => p.type !== 'receipt_coupon' && promotionEligible(p, ctx))
    .sort((a, b) => a.priority - b.priority || a.id - b.id);

  const record = (p: PromotionDef, amount: number, targets: PricedLine[]) => {
    if (amount <= 0) return;
    discounts.push({ source: 'promotion', refId: String(p.id), name: p.name, amount });
    for (const l of targets) {
      if (!l.promotionIds.includes(p.id)) l.promotionIds.push(p.id);
      if (!p.stackable) exclusive.add(l);
    }
  };

  const eligibleTargets = (p: PromotionDef) =>
    lines.filter((l) => lineMatches(p, l) && !exclusive.has(l) && (p.stackable || l.promotionIds.length === 0) && l.qty > 0);

  // ---- item-level promotions ----
  for (const p of promos) {
    const prm = p.params || {};
    const targets = eligibleTargets(p);
    if (!targets.length) continue;
    switch (p.type) {
      case 'bxgy': {
        const buy = Number(prm.buy || 1), get = Number(prm.get || 1);
        const totalUnits = targets.reduce((a, l) => a + (l.isWeighted ? 0 : Math.floor(l.qty)), 0);
        const sets = Math.floor(totalUnits / (buy + get));
        if (sets <= 0) break;
        const map = cheapestUnitsDiscount(targets, sets * get);
        let sum = 0;
        const touched: PricedLine[] = [];
        for (const [l, amt] of map) { l.itemDiscount += amt; sum += amt; touched.push(l); }
        record(p, sum, targets);
        break;
      }
      case 'qty_percent': {
        const minQty = Number(prm.minQty || 2), pct = Number(prm.percent || 0);
        const q = targets.reduce((a, l) => a + l.qty, 0);
        if (q < minQty || pct <= 0) break;
        const base = targets.reduce((a, l) => a + net(l), 0);
        const amt = Math.round((base * pct) / 100);
        spreadItemDiscount(targets, amt);
        record(p, amt, targets);
        break;
      }
      case 'special_price':
      case 'tier_price':
      case 'percent_off': {
        let sum = 0;
        const hit: PricedLine[] = [];
        for (const l of targets) {
          let d = 0;
          const fixed = prm.prices?.[l.productId] ?? prm.price;
          if ((p.type === 'special_price' || p.type === 'tier_price') && fixed != null) {
            d = Math.max(0, l.gross - Math.round(Number(fixed) * l.qty));
          } else if (prm.percent) {
            d = Math.round((net(l) * Number(prm.percent)) / 100);
          }
          d = Math.min(d, net(l));
          if (d > 0) { l.itemDiscount += d; sum += d; hit.push(l); }
        }
        record(p, sum, hit);
        break;
      }
    }
  }
  const itemDiscountTotal = lines.reduce((a, l) => a + l.itemDiscount, 0);

  // ---- bill-level promotions ----
  for (const p of promos) {
    if (p.type !== 'bill_threshold' && p.type !== 'birthday') continue;
    const prm = p.params || {};
    const targets = lines.filter((l) => lineMatches(p, l) && (p.stackable || !exclusive.has(l)));
    const base = targets.reduce((a, l) => a + net(l), 0);
    if (base <= 0) continue;
    if (prm.minSpend && base < Number(prm.minSpend)) continue;
    let amt = prm.percent ? Math.round((base * Number(prm.percent)) / 100) : Number(prm.amount || 0);
    if (prm.maxDiscount) amt = Math.min(amt, Number(prm.maxDiscount));
    amt = Math.min(amt, base);
    if (amt <= 0) continue;
    spreadBillDiscount(targets, amt);
    discounts.push({ source: 'promotion', refId: String(p.id), name: p.name, amount: amt });
    for (const l of targets) if (!l.promotionIds.includes(p.id)) l.promotionIds.push(p.id);
  }

  // ---- member tier discount ----
  if (ctx.member && ctx.tierDiscountPct && ctx.tierDiscountPct > 0) {
    const base = lines.reduce((a, l) => a + net(l), 0);
    const amt = Math.round((base * ctx.tierDiscountPct) / 100);
    if (amt > 0) {
      spreadBillDiscount(lines, amt);
      discounts.push({ source: 'tier', refId: String(ctx.member.tierId ?? ''), name: `ส่วนลดระดับสมาชิก ${ctx.tierDiscountPct}%`, amount: amt });
    }
  }

  // ---- coupons ----
  const couponResults: CouponResult[] = [];
  let couponDiscount = 0;
  for (const c of input.coupons || []) {
    const r = applyCoupon(c, lines);
    couponResults.push(r);
    if (r.ok) {
      couponDiscount += r.amount;
      discounts.push({ source: 'coupon', refId: c.id, name: `คูปอง ${c.code}`, amount: r.amount });
    }
  }

  // ---- manual discount ----
  let manualDiscount = 0;
  if (input.manualDiscount && input.manualDiscount.value > 0) {
    const base = lines.reduce((a, l) => a + net(l), 0);
    manualDiscount = input.manualDiscount.type === 'percent'
      ? Math.round((base * input.manualDiscount.value) / 100)
      : Math.round(input.manualDiscount.value);
    manualDiscount = Math.min(manualDiscount, base);
    if (manualDiscount > 0) {
      spreadBillDiscount(lines, manualDiscount);
      discounts.push({ source: 'manual', refId: 'manual', name: input.manualDiscount.reason || 'ส่วนลดท้ายบิล', amount: manualDiscount });
    }
  }

  // ---- points ----
  let pointsDiscount = 0;
  if (input.pointsDiscount && input.pointsDiscount > 0) {
    const base = lines.reduce((a, l) => a + net(l), 0);
    pointsDiscount = Math.min(Math.round(input.pointsDiscount), base);
    if (pointsDiscount > 0) {
      spreadBillDiscount(lines, pointsDiscount);
      discounts.push({ source: 'points', refId: 'points', name: 'แลกคะแนนสะสม', amount: pointsDiscount });
    }
  }

  for (const l of lines) l.total = l.gross - l.itemDiscount - l.billDiscountShare;
  const subtotal = lines.reduce((a, l) => a + l.gross, 0);
  let total = lines.reduce((a, l) => a + l.total, 0);
  const vatBase = lines.filter((l) => !l.vatExempt).reduce((a, l) => a + l.total, 0);
  let vatAmount = 0;
  if (ctx.vat.mode === 'inclusive') vatAmount = Math.round((vatBase * ctx.vat.rate) / (100 + ctx.vat.rate));
  else if (ctx.vat.mode === 'exclusive') { vatAmount = Math.round((vatBase * ctx.vat.rate) / 100); total += vatAmount; }

  const discountTotal = subtotal - lines.reduce((a, l) => a + l.total, 0);
  return {
    lines, subtotal, itemDiscountTotal, discounts, discountTotal, couponDiscount, pointsDiscount, manualDiscount,
    total, vatAmount, vatBase,
    itemsCount: roundQty(lines.reduce((a, l) => a + (l.isWeighted ? 1 : l.qty), 0)),
    couponResults,
  };
}

/** Compute and apply a coupon discount. Mutates line billDiscountShare when ok. */
function applyCoupon(c: CouponInput, lines: PricedLine[]): CouponResult {
  const fail = (reason: string): CouponResult => ({ couponId: c.id, code: c.code, ok: false, amount: 0, reason });
  const base = lines.reduce((a, l) => a + net(l), 0);
  if (base <= 0) return fail('ไม่มีสินค้าในบิล');
  if (c.minSpend && base < c.minSpend) return fail(`ยอดซื้อขั้นต่ำ ${(c.minSpend / 100).toFixed(2)} บาท`);
  const r = c.reward;
  const targetLines = lines.filter((l) => lineMatches({ productIds: r.productIds, categoryIds: r.categoryIds }, l) && net(l) > 0);
  let amt = 0;
  let targets = lines;
  switch (r.type) {
    case 'amount':
    case 'bill_discount':
      amt = r.valueType === 'percent' ? Math.round((base * r.value) / 100) : r.value;
      break;
    case 'percent':
      amt = Math.round((base * r.value) / 100);
      break;
    case 'product_discount':
    case 'category_discount': {
      if (!targetLines.length) return fail('ไม่มีสินค้าที่ร่วมรายการในบิล');
      const tBase = targetLines.reduce((a, l) => a + net(l), 0);
      amt = r.valueType === 'percent' ? Math.round((tBase * r.value) / 100) : Math.min(r.value, tBase);
      targets = targetLines;
      break;
    }
    case 'bogo': {
      if (!targetLines.length) return fail('ไม่มีสินค้าที่ร่วมรายการในบิล');
      const units = targetLines.reduce((a, l) => a + (l.isWeighted ? 0 : Math.floor(l.qty)), 0);
      if (units < 2) return fail('ต้องซื้อสินค้าที่ร่วมรายการอย่างน้อย 2 ชิ้น');
      const map = cheapestUnitsDiscount(targetLines, 1); // buy one, get the cheapest one free
      for (const [l, a] of map) { l.billDiscountShare += a; amt += a; }
      return { couponId: c.id, code: c.code, ok: amt > 0, amount: amt, reason: amt > 0 ? undefined : 'ไม่สามารถคำนวณส่วนลดได้' };
    }
    case 'free_item': {
      if (!targetLines.length) return fail('กรุณาเพิ่มสินค้าที่แจกฟรีลงในบิลก่อน');
      const map = cheapestUnitsDiscount(targetLines, 1);
      for (const [l, a] of map) { l.billDiscountShare += a; amt += a; }
      if (!amt) {
        // weighted item: give up to the value of 1 unit price
        const l = targetLines[0];
        amt = Math.min(net(l), l.unitPrice);
        l.billDiscountShare += amt;
      }
      return { couponId: c.id, code: c.code, ok: amt > 0, amount: amt };
    }
    case 'special_price': {
      if (!targetLines.length) return fail('ไม่มีสินค้าที่ร่วมรายการในบิล');
      for (const l of targetLines) {
        const d = Math.max(0, net(l) - Math.round(r.value * l.qty));
        l.billDiscountShare += d;
        amt += d;
      }
      return { couponId: c.id, code: c.code, ok: amt > 0, amount: amt, reason: amt > 0 ? undefined : 'ราคาปัจจุบันต่ำกว่าราคาพิเศษแล้ว' };
    }
  }
  if (r.maxDiscount) amt = Math.min(amt, r.maxDiscount);
  const tBase = targets.reduce((a, l) => a + net(l), 0);
  amt = Math.min(Math.round(amt), tBase);
  if (amt <= 0) return fail('ไม่สามารถคำนวณส่วนลดได้');
  spreadBillDiscount(targets, amt);
  return { couponId: c.id, code: c.code, ok: true, amount: amt };
}

// ---------- Receipt coupon issuance ----------
export interface IssuanceDecision {
  promotionId: number;
  count: number;
  promotion: PromotionDef;
}

/**
 * Decide which receipt_coupon promotions issue coupons for a priced bill.
 * params: { minSpend?, minQty?, paymentMethods?: string[], maxPerBill?: number, perThreshold?: boolean }
 */
export function evaluateCouponIssuance(
  promotions: PromotionDef[], priced: PricingResult, ctx: PricingContext, paymentMethods: string[], maxCouponsPerBill = 99,
): IssuanceDecision[] {
  const out: IssuanceDecision[] = [];
  let remaining = maxCouponsPerBill;
  const rules = promotions.filter((p) => p.type === 'receipt_coupon' && promotionEligible(p, ctx)).sort((a, b) => a.priority - b.priority || a.id - b.id);
  const usedGroups = new Set<string>();
  for (const p of rules) {
    if (remaining <= 0) break;
    const prm = p.params || {};
    // Rules sharing an exclusiveGroup (e.g. 300→20 / 500→50 / 1000→100) issue only the first (highest-priority) match.
    if (prm.exclusiveGroup && usedGroups.has(prm.exclusiveGroup)) continue;
    const targets = priced.lines.filter((l) => lineMatches(p, l));
    if (!targets.length) continue;
    const spend = targets.reduce((a, l) => a + l.total, 0);
    const qty = targets.reduce((a, l) => a + l.qty, 0);
    if (prm.minSpend && spend < Number(prm.minSpend)) continue;
    if (prm.minQty && qty < Number(prm.minQty)) continue;
    if (Array.isArray(prm.paymentMethods) && prm.paymentMethods.length && !paymentMethods.some((m) => prm.paymentMethods.includes(m))) continue;
    let count = 1;
    if (prm.perThreshold && prm.minSpend) count = Math.floor(spend / Number(prm.minSpend));
    else if (prm.perThreshold && prm.minQty) count = Math.floor(qty / Number(prm.minQty));
    count = Math.min(count, Number(prm.maxPerBill || 1), remaining);
    if (p.usageLimit != null) count = Math.min(count, Math.max(0, p.usageLimit - (p.usageCount ?? 0)));
    if (count <= 0) continue;
    out.push({ promotionId: p.id, count, promotion: p });
    if (prm.exclusiveGroup) usedGroups.add(prm.exclusiveGroup);
    remaining -= count;
  }
  return out;
}

export function describeReward(r: CouponReward): string {
  const baht = (s: number) => (s / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  switch (r.type) {
    case 'amount':
    case 'bill_discount':
      return r.valueType === 'percent' ? `ส่วนลด ${r.value}% ทั้งบิล` : `รับส่วนลด ${baht(r.value)} บาท`;
    case 'percent': return `รับส่วนลด ${r.value}%`;
    case 'bogo': return 'ซื้อ 1 แถม 1';
    case 'free_item': return 'รับสินค้าฟรี 1 ชิ้น';
    case 'special_price': return `ราคาพิเศษ ${baht(r.value)} บาท`;
    case 'product_discount': return r.valueType === 'percent' ? `ลด ${r.value}% สินค้าที่ร่วมรายการ` : `ลด ${baht(r.value)} บาท สินค้าที่ร่วมรายการ`;
    case 'category_discount': return r.valueType === 'percent' ? `ลด ${r.value}% หมวดที่ร่วมรายการ` : `ลด ${baht(r.value)} บาท หมวดที่ร่วมรายการ`;
  }
}
