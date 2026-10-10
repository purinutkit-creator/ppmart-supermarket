import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup, uuid } from './helpers';

let env: Awaited<ReturnType<typeof setup>>;
let manager: string, owner: string;
let parentId: number;
const sizes: Record<string, number> = {};
// 1x1 transparent PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const order = (items: { productId: number; qty: number }[], extra: any = {}, store = 'main') => env.api('POST', `/api/shop/s/${store}/orders`, {
  idempotencyKey: uuid(), items, customer: { name: 'ลูกค้าออนไลน์', phone: '0899999999' }, fulfillment: 'pickup', paymentMethod: 'pay_at_store', ...extra,
});
const stock = async (id: number) => Number((await env.pool.query('SELECT COALESCE((SELECT qty FROM stock_levels WHERE branch_id=1 AND product_id=$1),0) AS q', [id])).rows[0].q);

beforeAll(async () => {
  env = await setup();
  manager = await env.login('2000', '246802', 'POS01');
  owner = await env.login('1000', '135790');
  const p = await env.api('POST', '/api/products', {
    sku: 'TS-001', name: 'เสื้อยืด', price: 19900, cost: 8000, description: 'ผ้าฝ้าย 100%',
    sizeChart: { columns: ['ไซส์', 'อก (นิ้ว)'], rows: [['S', '34'], ['M', '38']], note: null },
  }, manager);
  expect(p.status).toBe(200);
  parentId = p.body.id;
  const v = await env.api('PUT', `/api/products/${parentId}/variants`, { variants: [
    { label: 'S', sku: 'TS-001-S', price: 19900 }, { label: 'M', sku: 'TS-001-M', price: 21900 },
  ] }, manager);
  expect(v.status).toBe(200);
  [sizes.S, sizes.M] = v.body.ids;
  expect((await env.api('POST', '/api/stock/adjust', { branchId: 1, productId: sizes.S, qty: 3, reason: 'รับเข้า' }, manager)).status).toBe(200);
});
afterAll(async () => env.close());

describe('online shop', () => {
  it('uploads multiple images in order, reorders them and the first becomes the cover', async () => {
    const a = await env.api('POST', `/api/products/${parentId}/images`, { dataBase64: PNG, mime: 'image/png' }, manager);
    const b = await env.api('POST', `/api/products/${parentId}/images`, { dataBase64: PNG, mime: 'image/png' }, manager);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect((await env.api('PUT', `/api/products/${parentId}/images/order`, { ids: [b.body.id, a.body.id] }, manager)).status).toBe(200);
    const d = await env.api('GET', `/api/shop/s/main/products/${parentId}`);
    expect(d.body.imageIds).toEqual([b.body.id, a.body.id]);
    expect(d.body.imageUrl).toBe(`/api/shop/images/${b.body.id}`);
    expect(d.body.sizeChart.rows.length).toBe(2);
    expect(d.body.variants.map((x: any) => [x.label, x.available])).toEqual([['S', true], ['M', false]]);
    const img = await fetch(`http://127.0.0.1:${(env.server.address() as any).port}/api/shop/images/${a.body.id}`);
    expect(img.headers.get('content-type')).toBe('image/png');
    // sized products are listed once (parent), never the individual sizes
    const list = await env.api('GET', '/api/shop/s/main/products?q=เสื้อยืด');
    expect(list.body.items.length).toBe(1);
    expect([list.body.items[0].price, list.body.items[0].maxPrice, list.body.items[0].hasSizes]).toEqual([19900, 21900, true]);
  });

  it('requires a size, takes stock at order time and never oversells', async () => {
    expect((await order([{ productId: parentId, qty: 1 }])).body.code).toBe('SIZE_REQUIRED');
    expect((await order([{ productId: sizes.M, qty: 1 }])).status).toBe(409);
    const r = await order([{ productId: sizes.S, qty: 2 }]);
    expect(r.status).toBe(201);
    expect(await stock(sizes.S)).toBe(1);
    const [x, y] = await Promise.all([order([{ productId: sizes.S, qty: 1 }]), order([{ productId: sizes.S, qty: 1 }])]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(await stock(sizes.S)).toBe(0);
    // tracking link works only with the access token
    expect((await env.api('GET', `/api/shop/orders/${r.body.orderNo}?t=${r.body.accessToken}`)).body.total).toBe(39800);
    expect((await env.api('GET', `/api/shop/orders/${r.body.orderNo}?t=wrong`)).status).toBe(404);
  });

  it('cancelling returns stock; marking paid records a sale', async () => {
    const list = (await env.api('GET', '/api/orders', undefined, manager)).body;
    const [a, b] = list.filter((o: any) => o.status === 'pending_payment');
    const before = await stock(sizes.S);
    expect((await env.api('POST', `/api/orders/${a.id}/status`, { status: 'cancelled', reason: 'ลูกค้ายกเลิก' }, manager)).status).toBe(200);
    expect(await stock(sizes.S)).toBe(before + Number((await env.pool.query('SELECT SUM(qty) s FROM online_order_items WHERE order_id=$1', [a.id])).rows[0].s));
    const paid = await env.api('POST', `/api/orders/${b.id}/mark-paid`, { method: 'cash' }, manager);
    expect(paid.status).toBe(200);
    const sale = (await env.pool.query('SELECT total, bill_no FROM sales WHERE id=$1', [paid.body.saleId])).rows[0];
    expect(sale.bill_no).toBe(b.order_no);
    expect(Number(sale.total)).toBe(Number(b.total));
    // paid order cannot be cancelled here (refund at POS)
    expect((await env.api('POST', `/api/orders/${b.id}/status`, { status: 'cancelled', reason: 'x' }, manager)).body.code).toBe('PAID_REFUND_AT_POS');
    expect((await env.api('POST', `/api/orders/${b.id}/status`, { status: 'completed' }, manager)).status).toBe(200);
  });

  it('PromptPay order is marked paid when the payment is verified', async () => {
    await env.api('POST', '/api/stock/adjust', { branchId: 1, productId: sizes.M, qty: 5, reason: 'รับเข้า' }, manager);
    const r = await order([{ productId: sizes.M, qty: 1 }], { paymentMethod: 'promptpay' });
    expect(r.status).toBe(201);
    const v = (await env.api('GET', `/api/shop/orders/${r.body.orderNo}?t=${r.body.accessToken}`)).body;
    expect(v.payment.qrPayload).toBeTruthy();
    const o = (await env.pool.query('SELECT payment_intent_id FROM online_orders WHERE order_no=$1', [r.body.orderNo])).rows[0];
    expect((await env.api('POST', `/api/payments/intents/${o.payment_intent_id}/verify`, { approve: true, reference: 'REF12345' }, manager)).status).toBe(200);
    const after = (await env.api('GET', `/api/shop/orders/${r.body.orderNo}?t=${r.body.accessToken}`)).body;
    expect(after.status).toBe('paid');
  });

  it('idempotency key prevents duplicate orders', async () => {
    const key = uuid();
    const a = await order([{ productId: sizes.M, qty: 1 }], { idempotencyKey: key });
    const b = await order([{ productId: sizes.M, qty: 1 }], { idempotencyKey: key });
    expect(a.status).toBe(201);
    expect(b.body.code).toBe('DUPLICATE_ORDER');
  });

  it('multiple storefronts: own scope, own branch, can be closed independently', async () => {
    const cat = (await env.api('POST', '/api/products/meta/categories', { name: 'ฟุตบอล' }, manager)).body;
    const catId = cat.id ?? (await env.pool.query("SELECT id FROM categories WHERE name='ฟุตบอล'")).rows[0].id;
    await env.pool.query('UPDATE products SET category_id=$1, compare_price=29900 WHERE id=$2 OR parent_id=$2', [catId, parentId]);
    const c = await env.api('POST', '/api/storefronts', { slug: 'football', name: 'PP Football', config: { scope: { mode: 'categories', categoryIds: [catId], brandIds: [] } } }, owner);
    expect(c.status).toBe(200);
    const list = await env.api('GET', '/api/shop/s/football/products');
    expect(list.body.items.map((x: any) => x.id)).toEqual([parentId]);
    expect(list.body.items[0].comparePrice).toBe(29900);
    expect(list.body.facets.sizes).toContain('M');
    expect((await env.api('GET', '/api/shop/s/football/products?tag=sale')).body.total).toBe(1);
    expect((await env.api('GET', '/api/shop/s/football/products?size=XL')).body.total).toBe(0);
    // a product outside the store's scope cannot be ordered there
    const other = (await env.pool.query("SELECT id FROM products WHERE sku='RC-001'")).rows[0].id;
    expect((await order([{ productId: other, qty: 1 }], {}, 'football')).body.code).toBe('NOT_AVAILABLE');
    const info = await env.api('GET', '/api/shop/s/football/info');
    expect(info.body.categories.map((x: any) => x.name)).toEqual(['ฟุตบอล']);
    const stores = (await env.api('GET', '/api/shop/stores')).body.stores.map((x: any) => x.slug);
    expect(stores).toEqual(['main', 'football']);
    // close only the football store
    await env.api('PUT', `/api/storefronts/${c.body.id}`, { slug: 'football', name: 'PP Football', enabled: false, config: {} }, owner);
    expect((await env.api('GET', '/api/shop/s/football/info')).body.code).toBe('SHOP_CLOSED');
    expect((await order([{ productId: sizes.M, qty: 1 }], {}, 'football')).body.code).toBe('SHOP_CLOSED');
    expect((await env.api('GET', '/api/shop/stores')).body.stores.map((x: any) => x.slug)).toEqual(['main']);
    expect((await env.api('GET', '/api/shop/s/main/info')).status).toBe(200);
  });
});
