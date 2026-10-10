-- PPMart Supermarket — initial schema
-- Money is stored as BIGINT satang (1 THB = 100). Quantities are NUMERIC(14,3) (supports weight in kg).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE branches (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_en TEXT,
  address TEXT,
  phone TEXT,
  tax_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE terminals (
  id SERIAL PRIMARY KEY,
  branch_id INT NOT NULL REFERENCES branches(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  last_bill_seq INT NOT NULL DEFAULT 0,
  settings JSONB NOT NULL DEFAULT '{}',
  last_seen_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  max_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  is_system BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE staff (
  id SERIAL PRIMARY KEY,
  employee_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  role_id INT NOT NULL REFERENCES roles(id),
  branch_id INT REFERENCES branches(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff_sessions (
  token_hash TEXT PRIMARY KEY,
  staff_id INT NOT NULL REFERENCES staff(id),
  terminal_id INT REFERENCES terminals(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approver_id INT NOT NULL REFERENCES staff(id),
  requested_by INT REFERENCES staff(id),
  permission TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

CREATE TABLE audit_logs (
  id BIGSERIAL PRIMARY KEY,
  staff_id INT REFERENCES staff(id),
  staff_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  bill_no TEXT,
  reason TEXT,
  approved_by INT REFERENCES staff(id),
  terminal_id INT,
  branch_id INT,
  details JSONB NOT NULL DEFAULT '{}',
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs(created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INT REFERENCES staff(id)
);

CREATE TABLE fonts (
  id SERIAL PRIMARY KEY,
  family TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('google','upload')),
  format TEXT,
  weight TEXT NOT NULL DEFAULT '400',
  data BYTEA,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Catalog =====
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  name_en TEXT,
  name_zh TEXT,
  parent_id INT REFERENCES categories(id)
);
CREATE TABLE brands (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE units (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, name_en TEXT);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  name_en TEXT,
  name_zh TEXT,
  category_id INT REFERENCES categories(id),
  brand_id INT REFERENCES brands(id),
  unit_id INT REFERENCES units(id),
  price BIGINT NOT NULL CHECK (price >= 0),
  cost BIGINT NOT NULL DEFAULT 0,
  member_price BIGINT,
  wholesale_price BIGINT,
  wholesale_min_qty NUMERIC(14,3),
  is_weighted BOOLEAN NOT NULL DEFAULT FALSE,
  track_stock BOOLEAN NOT NULL DEFAULT TRUE,
  vat_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sale_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  block_reason TEXT,
  min_stock NUMERIC(14,3) NOT NULL DEFAULT 0,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX products_name_idx ON products (lower(name));

-- Multiple barcodes per product. pack_qty lets a pack barcode (e.g. 6-pack) sell 6 base units.
CREATE TABLE product_barcodes (
  barcode TEXT PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  pack_qty NUMERIC(14,3) NOT NULL DEFAULT 1,
  pack_price BIGINT
);
CREATE INDEX product_barcodes_product_idx ON product_barcodes(product_id);

-- ===== Stock =====
CREATE TABLE stock_levels (
  branch_id INT NOT NULL REFERENCES branches(id),
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, product_id)
);

CREATE TABLE stock_lots (
  id SERIAL PRIMARY KEY,
  branch_id INT NOT NULL REFERENCES branches(id),
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  lot_no TEXT,
  expiry_date DATE,
  qty NUMERIC(14,3) NOT NULL DEFAULT 0,
  cost BIGINT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_lots_lookup ON stock_lots(branch_id, product_id, expiry_date);

CREATE TABLE stock_movements (
  id BIGSERIAL PRIMARY KEY,
  branch_id INT NOT NULL REFERENCES branches(id),
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  lot_id INT REFERENCES stock_lots(id),
  type TEXT NOT NULL,
  qty NUMERIC(14,3) NOT NULL,
  balance_after NUMERIC(14,3) NOT NULL,
  ref_type TEXT,
  ref_id TEXT,
  reason TEXT,
  staff_id INT REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product_idx ON stock_movements(product_id, created_at DESC);

CREATE TABLE stock_transfers (
  id SERIAL PRIMARY KEY,
  transfer_no TEXT NOT NULL UNIQUE,
  from_branch_id INT NOT NULL REFERENCES branches(id),
  to_branch_id INT NOT NULL REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit','received','cancelled')),
  note TEXT,
  created_by INT REFERENCES staff(id),
  received_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ
);
CREATE TABLE stock_transfer_items (
  id SERIAL PRIMARY KEY,
  transfer_id INT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  received_qty NUMERIC(14,3),
  lots JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE stock_counts (
  id SERIAL PRIMARY KEY,
  branch_id INT NOT NULL REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','cancelled')),
  note TEXT,
  created_by INT REFERENCES staff(id),
  applied_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);
CREATE TABLE stock_count_items (
  id SERIAL PRIMARY KEY,
  count_id INT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  counted_qty NUMERIC(14,3) NOT NULL,
  system_qty NUMERIC(14,3),
  reason TEXT,
  UNIQUE (count_id, product_id)
);

-- ===== Members =====
CREATE TABLE tiers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  rank INT NOT NULL,
  min_spend BIGINT NOT NULL DEFAULT 0,
  min_points INT NOT NULL DEFAULT 0,
  min_visits INT NOT NULL DEFAULT 0,
  point_multiplier NUMERIC(6,2) NOT NULL DEFAULT 1,
  discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#888888',
  benefits TEXT
);

CREATE TABLE members (
  id SERIAL PRIMARY KEY,
  member_no TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT,
  phone TEXT NOT NULL UNIQUE,
  email TEXT,
  birthday DATE,
  tier_id INT REFERENCES tiers(id),
  points INT NOT NULL DEFAULT 0,
  total_spend BIGINT NOT NULL DEFAULT 0,
  visit_count INT NOT NULL DEFAULT 0,
  branch_id INT REFERENCES branches(id),
  lang TEXT NOT NULL DEFAULT 'th',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE points_ledger (
  id BIGSERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES members(id),
  type TEXT NOT NULL CHECK (type IN ('earn','redeem','expire','adjust','refund')),
  points INT NOT NULL,
  remaining INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  sale_id BIGINT,
  note TEXT,
  staff_id INT REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX points_ledger_member_idx ON points_ledger(member_id, created_at);

CREATE TABLE member_otps (
  id BIGSERIAL PRIMARY KEY,
  target TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  payload JSONB,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX member_otps_target_idx ON member_otps(target, created_at DESC);

CREATE TABLE member_sessions (
  token_hash TEXT PRIMARY KEY,
  member_id INT NOT NULL REFERENCES members(id),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Promotions =====
CREATE TABLE promotions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  name_en TEXT,
  name_zh TEXT,
  type TEXT NOT NULL CHECK (type IN ('bxgy','qty_percent','bill_threshold','special_price','percent_off','tier_price','birthday','receipt_coupon')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  priority INT NOT NULL DEFAULT 100,
  stackable BOOLEAN NOT NULL DEFAULT FALSE,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  days_of_week INT[],
  time_start TIME,
  time_end TIME,
  branch_ids INT[],
  tier_ids INT[],
  member_only BOOLEAN NOT NULL DEFAULT FALSE,
  product_ids INT[],
  category_ids INT[],
  brand_ids INT[],
  promo_code TEXT,
  usage_limit INT,
  usage_count INT NOT NULL DEFAULT 0,
  params JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  image_url TEXT,
  show_on_display BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Gift cards =====
CREATE TABLE gift_cards (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  initial_balance BIGINT NOT NULL,
  balance BIGINT NOT NULL CHECK (balance >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Shifts =====
CREATE TABLE shifts (
  id SERIAL PRIMARY KEY,
  terminal_id INT NOT NULL REFERENCES terminals(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  staff_id INT NOT NULL REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opening_float BIGINT NOT NULL DEFAULT 0,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  closed_by INT REFERENCES staff(id),
  expected_cash BIGINT,
  counted_cash BIGINT,
  difference BIGINT,
  note TEXT,
  handover_from_shift_id INT REFERENCES shifts(id),
  handover_to_staff_id INT REFERENCES staff(id)
);
-- only one open shift per terminal
CREATE UNIQUE INDEX shifts_one_open_per_terminal ON shifts(terminal_id) WHERE status = 'open';

CREATE TABLE cash_movements (
  id SERIAL PRIMARY KEY,
  shift_id INT NOT NULL REFERENCES shifts(id),
  type TEXT NOT NULL CHECK (type IN ('pay_in','pay_out','drawer_open','refund_cash')),
  amount BIGINT NOT NULL DEFAULT 0,
  reason TEXT,
  ref TEXT,
  staff_id INT REFERENCES staff(id),
  approved_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Payments =====
CREATE TABLE payment_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  method TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','needs_review','paid','failed','expired','cancelled')),
  provider_ref TEXT,
  qr_payload TEXT,
  qr_image_url TEXT,
  slip_image TEXT,
  reference TEXT,
  cart_id TEXT,
  terminal_id INT REFERENCES terminals(id),
  created_by INT REFERENCES staff(id),
  verified_by INT REFERENCES staff(id),
  sale_id BIGINT,
  raw JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX payment_intents_provider_ref ON payment_intents(provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- ===== Sales =====
CREATE TABLE sales (
  id BIGSERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  bill_no TEXT NOT NULL,
  cart_id TEXT,
  terminal_id INT NOT NULL REFERENCES terminals(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  shift_id INT REFERENCES shifts(id),
  staff_id INT NOT NULL REFERENCES staff(id),
  member_id INT REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','partially_refunded','refunded','voided')),
  subtotal BIGINT NOT NULL,
  discount_total BIGINT NOT NULL DEFAULT 0,
  coupon_discount BIGINT NOT NULL DEFAULT 0,
  points_discount BIGINT NOT NULL DEFAULT 0,
  vat_amount BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL,
  paid_total BIGINT NOT NULL,
  change_amount BIGINT NOT NULL DEFAULT 0,
  items_count NUMERIC(14,3) NOT NULL DEFAULT 0,
  lines_count INT NOT NULL DEFAULT 0,
  points_earned INT NOT NULL DEFAULT 0,
  points_redeemed INT NOT NULL DEFAULT 0,
  offline BOOLEAN NOT NULL DEFAULT FALSE,
  client_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (terminal_id, bill_no)
);
CREATE INDEX sales_created_idx ON sales(created_at DESC);
CREATE INDEX sales_branch_idx ON sales(branch_id, created_at DESC);

CREATE TABLE sale_items (
  id BIGSERIAL PRIMARY KEY,
  sale_id BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  barcode TEXT,
  name TEXT NOT NULL,
  qty NUMERIC(14,3) NOT NULL,
  pack_qty NUMERIC(14,3) NOT NULL DEFAULT 1,
  unit_price BIGINT NOT NULL,
  unit_cost BIGINT NOT NULL DEFAULT 0,
  discount BIGINT NOT NULL DEFAULT 0,
  line_total BIGINT NOT NULL,
  is_weighted BOOLEAN NOT NULL DEFAULT FALSE,
  vat_exempt BOOLEAN NOT NULL DEFAULT FALSE,
  promotion_ids INT[] NOT NULL DEFAULT '{}',
  refunded_qty NUMERIC(14,3) NOT NULL DEFAULT 0
);
CREATE INDEX sale_items_sale_idx ON sale_items(sale_id);
CREATE INDEX sale_items_product_idx ON sale_items(product_id);

CREATE TABLE sale_payments (
  id BIGSERIAL PRIMARY KEY,
  sale_id BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  amount BIGINT NOT NULL,
  received BIGINT,
  change_amount BIGINT NOT NULL DEFAULT 0,
  reference TEXT,
  payment_intent_id UUID REFERENCES payment_intents(id),
  gift_card_id INT REFERENCES gift_cards(id)
);

CREATE TABLE sale_discounts (
  id BIGSERIAL PRIMARY KEY,
  sale_id BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('promotion','coupon','manual','points','tier')),
  ref_id TEXT,
  name TEXT NOT NULL,
  amount BIGINT NOT NULL,
  approved_by INT REFERENCES staff(id)
);

CREATE TABLE gift_card_txns (
  id SERIAL PRIMARY KEY,
  gift_card_id INT NOT NULL REFERENCES gift_cards(id),
  amount BIGINT NOT NULL,
  sale_id BIGINT REFERENCES sales(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refunds (
  id SERIAL PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  sale_id BIGINT NOT NULL REFERENCES sales(id),
  type TEXT NOT NULL CHECK (type IN ('refund','void')),
  total BIGINT NOT NULL,
  method TEXT NOT NULL DEFAULT 'cash',
  reason TEXT NOT NULL,
  staff_id INT NOT NULL REFERENCES staff(id),
  approved_by INT REFERENCES staff(id),
  shift_id INT REFERENCES shifts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE refund_items (
  id SERIAL PRIMARY KEY,
  refund_id INT NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
  sale_item_id BIGINT NOT NULL REFERENCES sale_items(id),
  qty NUMERIC(14,3) NOT NULL,
  amount BIGINT NOT NULL,
  restock BOOLEAN NOT NULL DEFAULT TRUE
);

-- ===== Coupons =====
CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  barcode_value TEXT NOT NULL UNIQUE,
  promotion_id INT REFERENCES promotions(id),
  member_id INT REFERENCES members(id),
  source TEXT NOT NULL DEFAULT 'receipt' CHECK (source IN ('receipt','member','manual','replacement')),
  reward JSONB NOT NULL,
  title TEXT NOT NULL,
  min_spend BIGINT NOT NULL DEFAULT 0,
  branch_ids INT[],
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RESERVED','USED','EXPIRED','CANCELLED','VOID','PENDING_REVIEW')),
  issued_sale_id BIGINT REFERENCES sales(id),
  issued_branch_id INT REFERENCES branches(id),
  issued_terminal_id INT REFERENCES terminals(id),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  reserved_cart_id TEXT,
  reserved_terminal_id INT REFERENCES terminals(id),
  reserved_until TIMESTAMPTZ,
  redeemed_sale_id BIGINT REFERENCES sales(id),
  redeemed_branch_id INT REFERENCES branches(id),
  redeemed_terminal_id INT REFERENCES terminals(id),
  redeemed_staff_id INT REFERENCES staff(id),
  redeemed_at TIMESTAMPTZ,
  discount_amount BIGINT,
  replaced_by UUID REFERENCES coupons(id),
  note TEXT
);
CREATE INDEX coupons_status_idx ON coupons(status);
CREATE INDEX coupons_issued_sale_idx ON coupons(issued_sale_id);
CREATE INDEX coupons_redeemed_sale_idx ON coupons(redeemed_sale_id);

CREATE TABLE coupon_events (
  id BIGSERIAL PRIMARY KEY,
  coupon_id UUID NOT NULL REFERENCES coupons(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  sale_id BIGINT,
  cart_id TEXT,
  staff_id INT REFERENCES staff(id),
  terminal_id INT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== Purchasing =====
CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  tax_id TEXT,
  lead_time_days INT NOT NULL DEFAULT 3,
  payment_terms_days INT NOT NULL DEFAULT 30,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE purchase_orders (
  id SERIAL PRIMARY KEY,
  po_no TEXT NOT NULL UNIQUE,
  supplier_id INT NOT NULL REFERENCES suppliers(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ordered','partial','received','cancelled')),
  expected_date DATE,
  note TEXT,
  total BIGINT NOT NULL DEFAULT 0,
  created_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE purchase_order_items (
  id SERIAL PRIMARY KEY,
  po_id INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_cost BIGINT NOT NULL,
  received_qty NUMERIC(14,3) NOT NULL DEFAULT 0
);

CREATE TABLE goods_receipts (
  id SERIAL PRIMARY KEY,
  grn_no TEXT NOT NULL UNIQUE,
  po_id INT REFERENCES purchase_orders(id),
  supplier_id INT NOT NULL REFERENCES suppliers(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  invoice_no TEXT,
  note TEXT,
  total BIGINT NOT NULL DEFAULT 0,
  received_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE goods_receipt_items (
  id SERIAL PRIMARY KEY,
  grn_id INT NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  po_item_id INT REFERENCES purchase_order_items(id),
  product_id INT NOT NULL REFERENCES products(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_cost BIGINT NOT NULL,
  lot_no TEXT,
  expiry_date DATE,
  lot_id INT REFERENCES stock_lots(id)
);

CREATE TABLE supplier_invoices (
  id SERIAL PRIMARY KEY,
  supplier_id INT NOT NULL REFERENCES suppliers(id),
  invoice_no TEXT NOT NULL,
  grn_id INT REFERENCES goods_receipts(id),
  amount BIGINT NOT NULL,
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('unpaid','paid','cancelled')),
  paid_at TIMESTAMPTZ,
  UNIQUE (supplier_id, invoice_no)
);

CREATE TABLE purchase_returns (
  id SERIAL PRIMARY KEY,
  return_no TEXT NOT NULL UNIQUE,
  supplier_id INT NOT NULL REFERENCES suppliers(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  grn_id INT REFERENCES goods_receipts(id),
  reason TEXT NOT NULL,
  total BIGINT NOT NULL DEFAULT 0,
  created_by INT REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE purchase_return_items (
  id SERIAL PRIMARY KEY,
  return_id INT NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_cost BIGINT NOT NULL
);

-- ===== Devices / printing / display =====
CREATE TABLE print_jobs (
  id UUID PRIMARY KEY,
  sale_id BIGINT REFERENCES sales(id),
  terminal_id INT REFERENCES terminals(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','printing','printed','failed','cancelled')),
  attempts INT NOT NULL DEFAULT 0,
  transport TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE display_pairings (
  code TEXT PRIMARY KEY,
  display_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  terminal_id INT REFERENCES terminals(id),
  paired_at TIMESTAMPTZ
);
CREATE TABLE displays (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  terminal_id INT REFERENCES terminals(id),
  name TEXT,
  lang TEXT NOT NULL DEFAULT 'th',
  paired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

