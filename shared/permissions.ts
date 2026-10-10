export const PERMISSIONS = {
  'pos.sell': 'ขายสินค้า (POS)',
  'pos.discount': 'ให้ส่วนลดท้ายบิล/รายการ',
  'pos.price_override': 'แก้ไขราคาขายหน้า POS',
  'pos.void_item': 'ลบรายการสินค้าในบิล',
  'pos.void_bill': 'ยกเลิกบิล (Void)',
  'pos.refund': 'คืนเงิน/รับคืนสินค้า',
  'pos.open_drawer': 'เปิดลิ้นชักเงินสด',
  'pos.reprint': 'พิมพ์ใบเสร็จซ้ำ',
  'shifts.manage': 'เปิด/ปิดกะ และเงินเข้า–ออก',
  'shifts.view_all': 'ดูกะของพนักงานทุกคน',
  'payments.verify': 'ตรวจสอบ/ยืนยันการชำระเงิน (สลิป/โอน)',
  'products.manage': 'จัดการสินค้า/หมวดหมู่/บาร์โค้ด',
  'stock.view': 'ดูสต็อก',
  'stock.adjust': 'ปรับสต็อก/ตรวจนับ',
  'stock.transfer': 'โอนสินค้าระหว่างสาขา',
  'purchasing.manage': 'จัดซื้อ/รับสินค้า/ซัพพลายเออร์',
  'members.manage': 'จัดการสมาชิก/คะแนน',
  'promotions.manage': 'จัดการโปรโมชั่น',
  'coupons.manage': 'จัดการคูปอง',
  'reports.view': 'ดูรายงานยอดขาย',
  'reports.cost': 'ดูต้นทุนและกำไร',
  'staff.manage': 'จัดการพนักงานและสิทธิ์',
  'settings.manage': 'ตั้งค่าระบบ/อุปกรณ์/ใบเสร็จ',
  'audit.view': 'ดู Activity Log',
  'backup.manage': 'สำรอง/กู้คืนข้อมูล',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

/** Actions that always require a manager approval token when the actor lacks the permission. */
export const APPROVABLE: Permission[] = [
  'pos.discount', 'pos.price_override', 'pos.void_item', 'pos.void_bill', 'pos.refund', 'pos.open_drawer', 'pos.reprint',
];
