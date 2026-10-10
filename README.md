# PPMart — Supermarket POS & Management System

ระบบบริหารจัดการซูเปอร์มาร์เก็ตแบบครบวงจร: POS แคชเชียร์, พิมพ์ใบเสร็จอัตโนมัติ 2 ใบ (ESC/POS bitmap), Customer Display,
สมาชิก/คะแนน, Receipt Coupon แบบ Unique Barcode ใช้ครั้งเดียว, สินค้า/สต็อก/ล็อต, โปรโมชั่น, ชำระเงินหลายช่องทาง, กะแคชเชียร์,
จัดซื้อ, รายงาน และ Receipt Designer — Frontend + Backend + PostgreSQL + WebSocket ที่ทำงานจริง

```
Browser (POS / Admin / Customer Display / Member site)  ── React + Vite
      │  REST (JSON)            │  WebSocket /ws (POS ⇄ Display ⇄ Dashboard)
      ▼                         ▼
Node.js API (Express 5, zod, ws)  ── shared/ pricing engine (ใช้ร่วมกันทั้ง POS และ Server)
      │  transactions, row locks, idempotency keys
      ▼
PostgreSQL 16
Local Print Bridge (bridge/print-bridge.mjs) ── เครื่องพิมพ์ LAN/Wi-Fi (TCP 9100) / device file
```

## เริ่มต้นใช้งาน (Development)

ต้องมี Node.js 20+ และ PostgreSQL 14+

```bash
npm install
cp .env.example .env          # แก้ DATABASE_URL / APP_SECRET
npm run dev                   # API :4000 + Web :5173 (migrate + seed อัตโนมัติเมื่อฐานข้อมูลว่าง)
npm run bridge                # (ถ้าใช้เครื่องพิมพ์ LAN/Wi-Fi) Print Bridge :9123
npm test                      # ทดสอบ (ต้องมีฐานข้อมูล ppmart_test)
```

Production: `npm run build && npm start` (เสิร์ฟเว็บจาก `dist/`) หรือ `APP_SECRET=... docker compose up -d`
— **ต้องให้บริการผ่าน HTTPS** (WebUSB, Web Serial, Web Bluetooth และกล้องทำงานเฉพาะ secure context หรือ `localhost`)

### บัญชีตัวอย่าง (seed) — เปลี่ยน PIN ทันทีเมื่อใช้งานจริง

| รหัส | บทบาท | PIN |
|---|---|---|
| 1000 | Owner | 135790 |
| 2000 | Manager | 246802 |
| 3000 | Supervisor | 112233 |
| 4001 / 4002 | Cashier | 1357 / 2468 |
| 5001 | Stock Staff | 9753 |

เครื่อง POS: `POS01`, `POS02` (สาขาสำนักงานใหญ่), `BN-POS01` (สาขาบางนา)

| URL | หน้าจอ |
|---|---|
| `/login` → `/pos` | หน้าขาย (เลือกรหัสเครื่อง POS) |
| `/admin` | หลังร้าน / Dashboard |
| `/display` | Customer Display (จับคู่ด้วยรหัส 6 หลัก) |
| `/member` | เว็บไซต์สมาชิก (OTP) |

## ฟีเจอร์และการทำงานจริง

### POS
- สแกนด้วย USB/Bluetooth HID scanner (ตรวจจับ keystroke burst), กล้อง (ZXing: EAN-13/8, UPC, Code128, QR) หรือพิมพ์ SKU/ชื่อ
- หลายบาร์โค้ดต่อสินค้า, บาร์โค้ดแพ็ก (pack qty / pack price), บาร์โค้ดเครื่องชั่ง EAN-13 ฝังน้ำหนัก/ราคา (prefix 20–29)
- สินค้าชั่งน้ำหนัก: เครื่องชั่ง Web Serial (อ่านค่าแบบ stream) หรือกรอกเอง
- สแกนซ้ำเพิ่มจำนวน, `3*รหัส`, พักบิล/เรียกบิลหลายใบ (เก็บในเครื่อง), ตรวจสต็อก/สินค้าห้ามจำหน่าย
- ราคา/โปรโมชั่น/คูปอง/VAT คำนวณ Real-Time ด้วย `shared/pricing.ts` — ฝั่งเซิร์ฟเวอร์คำนวณซ้ำเป็นค่าที่ถือเป็นทางการ (ถ้าไม่ตรงจะตอบ `PRICE_CHANGED`)
- คีย์ลัด F1–F12, ล็อกหน้าจออัตโนมัติ, ลด/แก้ราคา/ลบรายการ/คืนเงิน/เปิดลิ้นชัก ต้องมีสิทธิ์หรือผู้จัดการอนุมัติ (Code + PIN, ใช้ครั้งเดียว 5 นาที)
- **Offline**: แคชแคตตาล็อกใน IndexedDB, ขายเงินสดต่อได้, ใบเสร็จพิมพ์จากเครื่อง, Outbox ซิงก์อัตโนมัติด้วย Idempotency Key (ไม่เกิดบิลซ้ำ)

### Checkout (ธุรกรรมเดียว — `server/src/services/checkout.ts`)
บันทึกการขาย → ชำระเงิน (ตรวจ payment intent / บัตรของขวัญแบบ row lock) → ตัดสต็อก `SELECT … FOR UPDATE` ตามล็อตแบบ FEFO
→ เพิ่มคะแนน/เลื่อน Tier → คูปองที่ใช้ `RESERVED→USED` → **Generate Unique Coupon และบันทึกลงฐานข้อมูลก่อนพิมพ์** → COMMIT
→ ส่ง WebSocket ไป Dashboard / Customer Display → POS สั่งพิมพ์ใบที่ 1 → ตัดกระดาษ → ใบที่ 2 (+ คูปอง) → ตัดกระดาษ
การพิมพ์ล้มเหลวไม่กระทบการชำระเงิน (มี Print Queue, Retry, Reprint พร้อมบันทึก)

### Receipt Coupon
- รหัส `CPN-XXXXXXXX` สุ่มจาก CSPRNG (31^8 ≈ 8.5×10¹¹ แบบ) unique constraint, Code128 barcode
- สถานะ ACTIVE / RESERVED / USED / EXPIRED / CANCELLED / VOID (+ PENDING_REVIEW) พร้อม `coupon_events` ทุกการเปลี่ยนสถานะ
- ตรวจสอบกับฐานข้อมูลกลางเสมอ: มีอยู่จริง, สถานะ, วันหมดอายุ, ยังไม่ใช้, สาขา, สมาชิก, ยอดขั้นต่ำ/สินค้า, วัน/เวลาที่ใช้ได้
- Reservation ผูกกับบิล (หมดเวลาแล้วกลับเป็น ACTIVE อัตโนมัติ), กันสองเครื่องจองพร้อมกันด้วย row lock
- เงื่อนไขการออก: ยอดซื้อ, สินค้า/SKU, หมวด, แบรนด์, จำนวน, Tier, สมาชิก, สาขา, วันที่, วันในสัปดาห์, ช่วงเวลา, ช่องทางชำระ, Promotion Code, จำนวนต่อบิล, กลุ่มเงื่อนไข (ออกเฉพาะขั้นสูงสุด)
- สิทธิ์: ลดเงิน, ลด %, 1 แถม 1, ฟรีสินค้า, ราคาพิเศษ, เฉพาะสินค้า, เฉพาะหมวด, ทั้งบิล + ยอดขั้นต่ำตอนใช้
- นโยบายคืนเงินตั้งค่าได้ (ไม่คืน / คืนเป็น ACTIVE / ออกใบใหม่ และ ยกเลิก / ไม่ยกเลิก / ส่ง Manager ตรวจ)
- ทดสอบอัตโนมัติ: สองเครื่องใช้คูปองเดียวกันพร้อมกัน → สำเร็จเพียงหนึ่ง (`server/test/flow.test.ts`)

### การพิมพ์ใบเสร็จ & Receipt Designer
- Template แยก Receipt 1 (Short Summary) / Receipt 2 (Customer), Drag & Drop องค์ประกอบ 30 ชนิด
- ฟอนต์ต่อองค์ประกอบ (Google Fonts หรืออัปโหลด TTF/OTF/WOFF/WOFF2), ขนาด, น้ำหนัก, Line height, Letter spacing, จัดซ้าย/กลาง/ขวา, กลับสี
- **Preview คือ bitmap เดียวกับที่ส่งเข้าเครื่องพิมพ์**: เรนเดอร์บน canvas ที่ DPI ของเครื่อง (58 มม. = 384 dots, 80 มม. = 576 dots @203dpi), โลโก้ใช้ Floyd–Steinberg dithering, แปลงเป็น `GS v 0` raster + `GS V` cut — ฟอนต์ไทย/จีน/ฟอนต์ที่อัปโหลดจึงออกจากกระดาษตรงกับ Preview
- การเชื่อมต่อ: **WebUSB**, **Web Serial** (USB-serial/RS-232/Bluetooth SPP), **Web Bluetooth (BLE)**, **Print Bridge** (LAN/Wi-Fi TCP 9100 หรือ device file), System print dialog
- ตั้งค่าแยกตามเครื่อง POS: เครื่องพิมพ์, ขนาดกระดาษ, DPI, ลิ้นชัก (ESC p), ลำดับ/สำเนา/เปิด-ปิด auto print ของแต่ละใบ

### Customer Display
จับคู่ด้วยรหัส 6 หลัก → เลือกภาษา ไทย/EN/中文 → แสดงสินค้าที่สแกนทันที (WebSocket), ส่วนลด, ยอดรวม, คะแนนที่จะได้รับ,
QR พร้อมเพย์, เงินรับ/เงินทอน, ข้อความขอบคุณ + คูปองที่ได้รับ, สไลด์โปรโมชั่นตอนว่าง, รองรับแนวตั้ง/แนวนอนและเต็มจอ, ตั้งค่าโลโก้/พื้นหลัง/สี/ฟอนต์/รูปโปรโมชั่น

### ชำระเงิน
เงินสด, พร้อมเพย์ QR, โอนเงิน, บัตรเครดิต/เดบิต (บันทึก approval code จาก EDC), E-Wallet, บัตรของขวัญ, แยกชำระหลายช่องทางในบิลเดียว
- Dynamic PromptPay QR: ผ่าน Omise/Opn (`OMISE_SECRET_KEY`, ยืนยันจาก webhook + ดึงสถานะจาก API ซ้ำ) หรือสร้าง QR EMVCo ระบุยอดเองจากหมายเลขพร้อมเพย์ร้าน
- โอนเงิน/สลิป → หน้า “ตรวจสอบการชำระเงิน”: ต้องกรอกเลขอ้างอิงธุรกรรมที่ตรวจจากบัญชี **ไม่ยืนยันจากภาพสลิปเพียงอย่างเดียว**
- Generic webhook ลงลายเซ็น HMAC-SHA256 (`PAYMENT_WEBHOOK_SECRET`), payment intent ใช้ได้กับบิลเดียวเท่านั้น

### อื่น ๆ
- สมาชิก: Tier ปรับแต่งได้ (ยอดซื้อ/คะแนน/จำนวนครั้ง), ตัวคูณคะแนน, ส่วนลด Tier, คะแนนหมดอายุแบบ FIFO, โปรวันเกิด, คูปองสมาชิก, เว็บไซต์สมาชิกพร้อมบัตรดิจิทัล — เข้าสู่ระบบด้วย OTP (hash, หมดอายุ 5 นาที, จำกัด 5 ครั้ง, rate limit, ไม่เปิดเผยว่ามีบัญชีหรือไม่)
- สินค้า/สต็อก: นำเข้า Excel/CSV, ล็อต+วันหมดอายุ, แจ้งเตือนใกล้หมดอายุ/ต่ำกว่าขั้นต่ำ, โอนระหว่างสาขา (ล็อตติดไปด้วย), ตรวจนับและปรับยอดพร้อมเหตุผล, Stock Movement ทุกครั้ง, พิมพ์ป้ายราคา/ฉลากบาร์โค้ด
- จัดซื้อ: Supplier, PO, รับสินค้าบางส่วน (ล็อต/วันหมดอายุ/ต้นทุนเฉลี่ย), Supplier Invoice, Purchase Return, แนะนำปริมาณสั่งซื้อจากยอดขายย้อนหลัง
- กะ: เปิดกะ/เงินเข้า-ออก/สรุปตามช่องทาง/เงินที่ควรมี/ขาด-เกิน/รายงาน X-Z/ส่งมอบกะ/ประวัติเปิดลิ้นชัก
- รายงาน: Real-Time Dashboard, ตัวกรองวัน/พนักงาน/เครื่อง/สาขา/หมวด/ช่องทาง, Export CSV/Excel/PDF, สิทธิ์ดูต้นทุน-กำไรแยก (`reports.cost`)
- ระบบ: บทบาทสร้างเองได้ + 25 สิทธิ์, PIN lockout, Activity Log, Backup/Restore (JSON snapshot), หน้า “อุปกรณ์” ทดสอบเครื่องพิมพ์/สแกนเนอร์/ลิ้นชัก/เครื่องชั่ง/สถานะจอลูกค้า

## ข้อจำกัดที่ควรทราบ
- WebUSB/Web Serial/Web Bluetooth รองรับใน Chrome/Edge (Desktop/Android) เท่านั้น — Safari/Firefox ให้ใช้ Print Bridge หรือ System print dialog; บน Windows เครื่องพิมพ์ USB ที่ติดตั้งไดรเวอร์ระบบแล้วอาจต้องใช้ WinUSB (Zadig) หรือ Print Bridge แบบ device/share
- ไม่มีการเชื่อมต่อเครื่อง EDC บัตรโดยตรง (บันทึก approval code); การคืนเงินผ่าน Payment Gateway ต้องทำในหน้าจอของผู้ให้บริการ
- OTP ต้องตั้งค่า SMTP หรือ SMS gateway ใน production (โหมด dev จะพิมพ์รหัสใน log)
- PDF export ใช้ระบบพิมพ์ของเบราว์เซอร์ (Save as PDF) เพื่อรองรับฟอนต์ไทย
- การสร้างภาพด้วย AI ทำงานเมื่อกำหนด `AI_IMAGE_ENDPOINT` / `AI_IMAGE_API_KEY` (OpenAI-compatible) — เครื่องมือสร้างภาพจากเทมเพลตใช้ได้เสมอ
- ขายออฟไลน์รองรับเฉพาะเงินสด และไม่รับคูปอง (คูปองต้องตรวจสอบกับเซิร์ฟเวอร์)
- Backup ในแอปเป็น JSON snapshot; ระบบจริงควรตั้ง `pg_dump`/WAL archiving ตามรอบเพิ่มเติม

## โครงสร้างโค้ด
```
server/migrations/001_init.sql   schema (เงินเป็นสตางค์ BIGINT, จำนวน NUMERIC(14,3))
server/src/services/             checkout, coupons, stock, points, refund, otp
server/src/routes/               auth, pos, payments, shifts, products, stock, members, marketing, purchasing, reports, admin
server/src/realtime.ts           WebSocket hub (POS ⇄ Display ⇄ Dashboard, presence, pairing)
shared/                          pricing engine, barcode, PromptPay, receipt template model, permissions
web/src/pages/                   Pos, CustomerDisplay, MemberPortal, Login
web/src/admin/                   back-office pages + ReceiptDesigner
web/src/lib/                     receipt-render (canvas), escpos, printer transports + queue, scanner, scale, offline, fonts
bridge/print-bridge.mjs          Local Print Bridge
server/test/                     unit + integration tests (concurrency, idempotency, coupons, refunds)
```
