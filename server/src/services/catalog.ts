import { q, type Db, pool } from '../db';
import type { PricingProduct, PromotionDef } from '../../../shared/pricing';

export function rowToPricingProduct(r: any): PricingProduct {
  return {
    id: r.id, name: r.name, price: r.price, memberPrice: r.member_price, wholesalePrice: r.wholesale_price,
    wholesaleMinQty: r.wholesale_min_qty, categoryId: r.category_id, brandId: r.brand_id,
    vatExempt: r.vat_exempt, isWeighted: r.is_weighted,
  };
}

export function rowToPromotion(r: any): PromotionDef {
  return {
    id: r.id, name: r.name, type: r.type, isActive: r.is_active, priority: r.priority, stackable: r.stackable,
    startsAt: r.starts_at ? new Date(r.starts_at).toISOString() : null,
    endsAt: r.ends_at ? new Date(r.ends_at).toISOString() : null,
    daysOfWeek: r.days_of_week, timeStart: r.time_start, timeEnd: r.time_end, branchIds: r.branch_ids,
    tierIds: r.tier_ids, memberOnly: r.member_only, productIds: r.product_ids, categoryIds: r.category_ids,
    brandIds: r.brand_ids, promoCode: r.promo_code, usageLimit: r.usage_limit, usageCount: r.usage_count, params: r.params || {},
  };
}

export async function activePromotions(db: Db = pool): Promise<PromotionDef[]> {
  const rows = await q(`SELECT * FROM promotions WHERE is_active AND (ends_at IS NULL OR ends_at > now() - interval '1 day')`, [], db);
  return rows.map(rowToPromotion);
}

export function productPublic(r: any) {
  return {
    id: r.id, sku: r.sku, name: r.name, nameEn: r.name_en, nameZh: r.name_zh, categoryId: r.category_id, brandId: r.brand_id,
    unitId: r.unit_id, unitName: r.unit_name ?? null, price: r.price, memberPrice: r.member_price, wholesalePrice: r.wholesale_price,
    wholesaleMinQty: r.wholesale_min_qty, isWeighted: r.is_weighted, trackStock: r.track_stock, vatExempt: r.vat_exempt,
    isActive: r.is_active, saleBlocked: r.sale_blocked, blockReason: r.block_reason, minStock: r.min_stock, imageUrl: r.image_url,
    barcodes: r.barcodes ?? [], stock: r.stock ?? null, categoryName: r.category_name ?? null, brandName: r.brand_name ?? null,
  };
}
