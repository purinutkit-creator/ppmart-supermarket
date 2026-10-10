// Demo data. Runs automatically on first start (empty database) or via `npm run seed`.
import { pool, tx, one } from './db';
import { hashPin } from './auth';
import { setSetting, DEFAULT_SETTINGS } from './settings';
import { moveStock } from './services/stock';
import { gtinCheckDigit } from '../../shared/barcode';
import { defaultTemplates } from '../../shared/receipt';
import { ALL_PERMISSIONS } from '../../shared/permissions';

const ean = (body12: string) => body12 + gtinCheckDigit(body12);
const B = (baht: number) => Math.round(baht * 100);

export async function seedIfEmpty() {
  const r = await one('SELECT COUNT(*)::int n FROM branches');
  if (r.n > 0) return false;
  await seed();
  return true;
}

export async function seed() {
  await tx(async (db) => {
    const br1 = (await db.query(`INSERT INTO branches (code, name, name_en, address, phone, tax_id) VALUES ('HQ','สาขาสำนักงานใหญ่','Head Office','99 ถนนสุขุมวิท แขวงคลองเตย เขตคลองเตย กรุงเทพฯ 10110','02-000-0000','0105566000001') RETURNING id`)).rows[0].id;
    const br2 = (await db.query(`INSERT INTO branches (code, name, name_en, address, phone, tax_id) VALUES ('BN','สาขาบางนา','Bangna','188 ถนนบางนา-ตราด เขตบางนา กรุงเทพฯ 10260','02-111-1111','0105566000001') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO terminals (branch_id, code, name) VALUES ($1,'POS01','เครื่อง POS 01'), ($1,'POS02','เครื่อง POS 02'), ($2,'BN-POS01','บางนา POS 01')`, [br1, br2]);

    const P = (...p: string[]) => p;
    const roles: [string, string, string[], number][] = [
      ['owner', 'Owner', [...ALL_PERMISSIONS], 100],
      ['admin', 'Admin', ALL_PERMISSIONS.filter((p) => p !== 'backup.manage'), 100],
      ['manager', 'Manager', P('pos.sell', 'pos.discount', 'pos.price_override', 'pos.void_item', 'pos.void_bill', 'pos.refund', 'pos.open_drawer', 'pos.reprint', 'shifts.manage', 'shifts.view_all', 'payments.verify', 'products.manage', 'stock.view', 'stock.adjust', 'stock.transfer', 'purchasing.manage', 'members.manage', 'promotions.manage', 'coupons.manage', 'orders.manage', 'reports.view', 'reports.cost', 'audit.view'), 30],
      ['supervisor', 'Supervisor', P('pos.sell', 'pos.discount', 'pos.void_item', 'pos.void_bill', 'pos.refund', 'pos.open_drawer', 'pos.reprint', 'shifts.manage', 'shifts.view_all', 'payments.verify', 'stock.view', 'members.manage', 'orders.manage', 'reports.view'), 15],
      ['cashier', 'Cashier', P('pos.sell', 'pos.void_item', 'shifts.manage'), 0],
      ['stock_staff', 'Stock Staff', P('stock.view', 'stock.adjust', 'stock.transfer', 'purchasing.manage', 'products.manage'), 0],
    ];
    const roleIds: Record<string, number> = {};
    for (const [key, name, perms, max] of roles) {
      roleIds[key] = (await db.query('INSERT INTO roles (key, name, permissions, max_discount_pct, is_system) VALUES ($1,$2,$3,$4,true) RETURNING id', [key, name, perms, max])).rows[0].id;
    }
    const staff: [string, string, string, string, number | null][] = [
      ['1000', 'เจ้าของร้าน (Owner)', 'owner', '135790', null],
      ['2000', 'ผู้จัดการ สมหญิง', 'manager', '246802', null],
      ['3000', 'หัวหน้าแคชเชียร์ สมชาย', 'supervisor', '112233', br1],
      ['4001', 'แคชเชียร์ มานี', 'cashier', '1357', br1],
      ['4002', 'แคชเชียร์ ปิติ', 'cashier', '2468', br1],
      ['5001', 'พนักงานสต็อก วีระ', 'stock_staff', '9753', null],
    ];
    for (const [code, name, role, pin, branch] of staff) {
      await db.query('INSERT INTO staff (employee_code, name, role_id, branch_id, pin_hash) VALUES ($1,$2,$3,$4,$5)', [code, name, roleIds[role], branch, await hashPin(pin)]);
    }

    const cat = async (name: string, en: string, zh: string) => (await db.query('INSERT INTO categories (name, name_en, name_zh) VALUES ($1,$2,$3) RETURNING id', [name, en, zh])).rows[0].id;
    const cDrink = await cat('เครื่องดื่ม', 'Beverages', '饮料');
    const cDairy = await cat('นมและผลิตภัณฑ์นม', 'Dairy', '乳制品');
    const cSnack = await cat('ขนมขบเคี้ยว', 'Snacks', '零食');
    const cProduce = await cat('ผักและผลไม้', 'Produce', '蔬果');
    const cMeat = await cat('เนื้อสัตว์', 'Meat', '肉类');
    const cHome = await cat('ของใช้ในบ้าน', 'Household', '家居用品');
    const cRice = await cat('ข้าวและอาหารแห้ง', 'Rice & Dry Food', '米和干货');
    const brand = async (n: string) => (await db.query('INSERT INTO brands (name) VALUES ($1) RETURNING id', [n])).rows[0].id;
    const bA = await brand('Brand A'), bCrystal = await brand('คริสตัล'), bMeiji = await brand('เมจิ'), bLays = await brand('เลย์'), bFarm = await brand('ฟาร์มสด');
    const unit = async (n: string, en: string) => (await db.query('INSERT INTO units (name, name_en) VALUES ($1,$2) RETURNING id', [n, en])).rows[0].id;
    const uPc = await unit('ชิ้น', 'pc'), uBottle = await unit('ขวด', 'bottle'), uKg = await unit('กก.', 'kg'), uPack = await unit('แพ็ก', 'pack'), uBag = await unit('ถุง', 'bag');

    type Prod = { sku: string; name: string; en: string; zh: string; cat: number; brand?: number; unit: number; price: number; cost: number; member?: number; weighted?: boolean; barcode?: string; pack?: [string, number, number]; min?: number; stock?: number; expiryDays?: number };
    const products: Prod[] = [
      { sku: 'DR-001', name: 'น้ำดื่มคริสตัล 600 มล.', en: 'Crystal Water 600ml', zh: '水晶饮用水 600毫升', cat: cDrink, brand: bCrystal, unit: uBottle, price: 10, cost: 6, barcode: ean('885000100001'), pack: [ean('885000100002'), 6, 55], min: 48, stock: 240, expiryDays: 365 },
      { sku: 'DR-002', name: 'น้ำอัดลม โคล่า 325 มล.', en: 'Cola 325ml', zh: '可乐 325毫升', cat: cDrink, brand: bA, unit: uBottle, price: 17, cost: 12, barcode: ean('885000100011'), min: 24, stock: 120, expiryDays: 180 },
      { sku: 'DR-003', name: 'ชาเขียว Brand A 500 มล.', en: 'Brand A Green Tea 500ml', zh: 'A牌绿茶 500毫升', cat: cDrink, brand: bA, unit: uBottle, price: 20, cost: 13, member: 18, barcode: ean('885000100021'), min: 24, stock: 96, expiryDays: 200 },
      { sku: 'DR-004', name: 'กาแฟกระป๋อง Brand A', en: 'Brand A Canned Coffee', zh: 'A牌罐装咖啡', cat: cDrink, brand: bA, unit: uPc, price: 15, cost: 9, barcode: ean('885000100031'), min: 24, stock: 72, expiryDays: 300 },
      { sku: 'DA-001', name: 'นมสดเมจิ 830 มล.', en: 'Meiji Fresh Milk 830ml', zh: '明治鲜奶 830毫升', cat: cDairy, brand: bMeiji, unit: uBottle, price: 45, cost: 36, member: 42, barcode: ean('885000200001'), min: 12, stock: 40, expiryDays: 10 },
      { sku: 'DA-002', name: 'โยเกิร์ตรสสตรอว์เบอร์รี', en: 'Strawberry Yogurt', zh: '草莓酸奶', cat: cDairy, brand: bMeiji, unit: uPc, price: 14, cost: 10, barcode: ean('885000200011'), min: 12, stock: 36, expiryDays: 6 },
      { sku: 'DA-003', name: 'ไข่ไก่ เบอร์ 2 (10 ฟอง)', en: 'Eggs Size 2 (10 pcs)', zh: '鸡蛋2号(10个)', cat: cDairy, brand: bFarm, unit: uPack, price: 52, cost: 42, barcode: ean('885000200021'), min: 10, stock: 30, expiryDays: 14 },
      { sku: 'SN-001', name: 'มันฝรั่งทอดเลย์ รสออริจินัล', en: "Lay's Classic", zh: '乐事原味薯片', cat: cSnack, brand: bLays, unit: uBag, price: 30, cost: 21, barcode: ean('885000300001'), min: 20, stock: 80, expiryDays: 120 },
      { sku: 'SN-002', name: 'มันฝรั่งทอดเลย์ รสโนริสาหร่าย', en: "Lay's Nori Seaweed", zh: '乐事海苔味薯片', cat: cSnack, brand: bLays, unit: uBag, price: 30, cost: 21, barcode: ean('885000300011'), min: 20, stock: 80, expiryDays: 120 },
      { sku: 'SN-003', name: 'บิสกิตช็อกโกแลต Brand A', en: 'Brand A Choco Biscuit', zh: 'A牌巧克力饼干', cat: cSnack, brand: bA, unit: uPack, price: 25, cost: 16, barcode: ean('885000300021'), min: 20, stock: 60, expiryDays: 240 },
      { sku: 'RC-001', name: 'ข้าวหอมมะลิ 5 กก.', en: 'Jasmine Rice 5kg', zh: '茉莉香米 5公斤', cat: cRice, unit: uBag, price: 189, cost: 150, member: 179, barcode: ean('885000400001'), min: 10, stock: 40, expiryDays: 365 },
      { sku: 'RC-002', name: 'บะหมี่กึ่งสำเร็จรูป รสต้มยำ', en: 'Instant Noodles Tom Yum', zh: '冬阴功方便面', cat: cRice, brand: bA, unit: uPc, price: 7, cost: 5, barcode: ean('885000400011'), pack: [ean('885000400012'), 30, 190], min: 60, stock: 300, expiryDays: 200 },
      { sku: 'HM-001', name: 'น้ำยาล้างจาน 500 มล.', en: 'Dishwashing Liquid 500ml', zh: '洗洁精 500毫升', cat: cHome, unit: uBottle, price: 35, cost: 24, barcode: ean('885000500001'), min: 10, stock: 30 },
      { sku: 'HM-002', name: 'กระดาษทิชชู่ 6 ม้วน', en: 'Toilet Tissue 6 rolls', zh: '卫生纸6卷', cat: cHome, unit: uPack, price: 89, cost: 65, barcode: ean('885000500011'), min: 10, stock: 25 },
      { sku: 'PR-001', name: 'กล้วยหอม', en: 'Banana', zh: '香蕉', cat: cProduce, unit: uKg, price: 45, cost: 28, weighted: true, barcode: '2000101', min: 5, stock: 25, expiryDays: 4 },
      { sku: 'PR-002', name: 'มะเขือเทศ', en: 'Tomato', zh: '番茄', cat: cProduce, unit: uKg, price: 60, cost: 38, weighted: true, barcode: '2000102', min: 5, stock: 20, expiryDays: 5 },
      { sku: 'PR-003', name: 'แอปเปิ้ลแดง', en: 'Red Apple', zh: '红苹果', cat: cProduce, unit: uKg, price: 120, cost: 80, weighted: true, barcode: '2000103', min: 5, stock: 18, expiryDays: 12 },
      { sku: 'MT-001', name: 'อกไก่สด', en: 'Chicken Breast', zh: '鸡胸肉', cat: cMeat, unit: uKg, price: 95, cost: 70, weighted: true, barcode: '2000201', min: 5, stock: 15, expiryDays: 3 },
      { sku: 'MT-002', name: 'หมูสับ', en: 'Minced Pork', zh: '猪肉末', cat: cMeat, unit: uKg, price: 150, cost: 115, weighted: true, barcode: '2000202', min: 5, stock: 12, expiryDays: 3 },
    ];
    const pid: Record<string, number> = {};
    for (const p of products) {
      const id = (await db.query(
        `INSERT INTO products (sku, name, name_en, name_zh, category_id, brand_id, unit_id, price, cost, member_price, is_weighted, min_stock) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [p.sku, p.name, p.en, p.zh, p.cat, p.brand ?? null, p.unit, B(p.price), B(p.cost), p.member ? B(p.member) : null, !!p.weighted, p.min ?? 0])).rows[0].id;
      pid[p.sku] = id;
      if (p.barcode) await db.query('INSERT INTO product_barcodes (barcode, product_id) VALUES ($1,$2)', [p.barcode, id]);
      if (p.pack) await db.query('INSERT INTO product_barcodes (barcode, product_id, pack_qty, pack_price) VALUES ($1,$2,$3,$4)', [p.pack[0], id, p.pack[1], B(p.pack[2])]);
      for (const br of [br1, br2]) {
        if (!p.stock) continue;
        const exp = p.expiryDays ? new Date(Date.now() + p.expiryDays * 86400000).toISOString().slice(0, 10) : null;
        await moveStock(db, { branchId: br, productId: id, qty: br === br1 ? p.stock : Math.round(p.stock / 2), type: 'receive', reason: 'ยอดยกมา (ข้อมูลตัวอย่าง)', lot: { lotNo: 'OPEN-' + p.sku, expiryDate: exp, cost: B(p.cost) } });
      }
    }

    const tiers: [string, number, number, number, number, number, string, string][] = [
      ['Bronze', 1, 0, 0, 1, 0, '#b0703c', 'สะสมคะแนนทุก 25 บาท = 1 คะแนน'],
      ['Silver', 2, B(5000), 0, 1.2, 0, '#9ca3af', 'คะแนน x1.2'],
      ['Gold', 3, B(20000), 0, 1.5, 2, '#d4a017', 'คะแนน x1.5 และส่วนลด 2% ทุกบิล'],
      ['Platinum', 4, B(50000), 0, 2, 3, '#6b7280', 'คะแนน x2 และส่วนลด 3% ทุกบิล'],
      ['Diamond', 5, B(100000), 0, 3, 5, '#38bdf8', 'คะแนน x3 และส่วนลด 5% ทุกบิล'],
    ];
    const tierIds: number[] = [];
    for (const t of tiers) tierIds.push((await db.query('INSERT INTO tiers (name, rank, min_spend, min_points, point_multiplier, discount_pct, color, benefits, min_visits) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0) RETURNING id', [t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7]])).rows[0].id);
    await db.query(`INSERT INTO members (member_no, first_name, last_name, phone, email, birthday, tier_id, points) VALUES
      ('M100000001','สมศรี','ใจดี','0812345678','somsri@example.com','1990-${String(new Date().getMonth() + 1).padStart(2, '0')}-15',$1,0),
      ('M100000002','John','Smith','0898765432','john@example.com','1985-01-20',$2,0)`, [tierIds[0], tierIds[1]]);

    const promo = async (o: any) => db.query(
      `INSERT INTO promotions (name, name_en, name_zh, type, priority, stackable, product_ids, category_ids, brand_ids, member_only, params, description, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() - interval '1 day', now() + interval '365 days')`,
      [o.name, o.en, o.zh, o.type, o.priority ?? 100, o.stackable ?? false, o.products ?? null, o.categories ?? null, o.brands ?? null, o.memberOnly ?? false, JSON.stringify(o.params), o.desc ?? null]);
    await promo({ name: 'น้ำดื่มคริสตัล ซื้อ 1 แถม 1', en: 'Crystal Water Buy 1 Get 1', zh: '水晶饮用水买一送一', type: 'bxgy', products: [pid['DR-001']], params: { buy: 1, get: 1 }, desc: 'ซื้อน้ำดื่มคริสตัล 600 มล. 1 ขวด แถมฟรี 1 ขวด' });
    await promo({ name: 'ขนมเลย์ ซื้อ 2 ลด 10%', en: "Lay's Buy 2 Save 10%", zh: '乐事买2件9折', type: 'qty_percent', brands: [bLays], params: { minQty: 2, percent: 10 } });
    await promo({ name: 'ช้อปครบ 1,000 ลด 50 บาท', en: 'Spend 1,000 get 50 off', zh: '满1000减50', type: 'bill_threshold', stackable: true, priority: 200, params: { minSpend: B(1000), amount: B(50) } });
    await promo({ name: 'สมาชิกวันเกิด ลด 10%', en: 'Birthday 10% off', zh: '生日会员9折', type: 'birthday', stackable: true, priority: 300, params: { percent: 10, maxDiscount: B(200) } });
    // Receipt coupons (exclusive group → only the highest threshold is issued per bill)
    const rc = (name: string, en: string, min: number, value: number, prio: number) => promo({
      name, en, zh: en, type: 'receipt_coupon', priority: prio,
      params: { minSpend: B(min), maxPerBill: 1, exclusiveGroup: 'spend-coupon', validDays: 30, title: 'SPECIAL COUPON', reward: { type: 'amount', value: B(value) }, redeemMinSpend: B(value * 5) },
    });
    await rc('ซื้อครบ 1,000 รับคูปอง 100 บาท', 'Spend 1,000 get 100 coupon', 1000, 100, 10);
    await rc('ซื้อครบ 500 รับคูปอง 50 บาท', 'Spend 500 get 50 coupon', 500, 50, 20);
    await rc('ซื้อครบ 300 รับคูปอง 20 บาท', 'Spend 300 get 20 coupon', 300, 20, 30);
    await promo({ name: 'ซื้อเครื่องดื่มครบ 300 รับคูปองลด 10%', en: 'Beverages 300 → 10% coupon', zh: '饮料满300送9折券', type: 'receipt_coupon', priority: 40, categories: [cDrink],
      params: { minSpend: B(300), maxPerBill: 1, validDays: 30, title: 'DRINK COUPON', reward: { type: 'category_discount', valueType: 'percent', value: 10, categoryIds: [cDrink], maxDiscount: B(100) } } });
    await promo({ name: 'ซื้อสินค้า Brand A 3 ชิ้น รับคูปอง 50 บาท', en: 'Buy 3 Brand A get 50 coupon', zh: '买3件A牌送50元券', type: 'receipt_coupon', priority: 50, brands: [bA],
      params: { minQty: 3, maxPerBill: 1, validDays: 30, title: 'BRAND A COUPON', reward: { type: 'amount', value: B(50) }, redeemMinSpend: B(200) } });

    await db.query(`INSERT INTO suppliers (code, name, contact_name, phone, lead_time_days) VALUES ('SUP-01','บริษัท เครื่องดื่มไทย จำกัด','คุณเอ','02-222-2222',3), ('SUP-02','บริษัท ฟาร์มสด จำกัด','คุณบี','02-333-3333',1)`);

    const tpl = defaultTemplates('Sarabun');
    await setSetting('store', { ...DEFAULT_SETTINGS.store, name: 'PPMart Supermarket', address: '99 ถนนสุขุมวิท กรุงเทพฯ 10110', phone: '02-000-0000', taxId: '0105566000001', promptPayId: '0812345678' }, null, db);
    await setSetting('receipt', {
      summary: tpl.summary, customer: tpl.customer,
      printOrder: ['summary', 'customer'],
      copies: { summary: 1, customer: 1 },
      autoPrint: { summary: true, customer: true },
    }, null, db);
    await db.query(`INSERT INTO fonts (family, source, weight) VALUES ('Sarabun','google','400;700'), ('Kanit','google','400;600'), ('Noto Sans Thai','google','400;700'), ('Noto Sans SC','google','400;700'), ('Prompt','google','400;700')`);
  });
  console.log('[seed] demo data created');
}

if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  (async () => {
    const { migrate } = await import('./migrate');
    await migrate();
    const created = await seedIfEmpty();
    if (!created) console.log('[seed] database already has data — skipped');
    await pool.end();
  })().catch((e) => { console.error(e); process.exit(1); });
}
