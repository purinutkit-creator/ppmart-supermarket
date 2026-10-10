-- Online shop: product images, size variants, size chart, online orders

ALTER TABLE products
  ADD COLUMN description TEXT,
  ADD COLUMN online BOOLEAN NOT NULL DEFAULT TRUE,          -- listed on the online shop
  ADD COLUMN parent_id INT REFERENCES products(id) ON DELETE CASCADE, -- size variant -> parent product
  ADD COLUMN variant_label TEXT,                              -- e.g. "M", "42", "XL"
  ADD COLUMN variant_sort INT NOT NULL DEFAULT 0,
  ADD COLUMN size_chart JSONB;                                -- {columns:[...], rows:[[...]], note}
CREATE INDEX products_parent_idx ON products(parent_id);

CREATE TABLE product_images (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  width INT,
  height INT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX product_images_product_idx ON product_images(product_id, sort_order);

CREATE TABLE online_orders (
  id SERIAL PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,
  access_token_hash TEXT NOT NULL,          -- lets a guest view their own order
  idempotency_key TEXT NOT NULL UNIQUE,
  member_id INT REFERENCES members(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  fulfillment TEXT NOT NULL CHECK (fulfillment IN ('pickup','delivery')),
  address TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment','paid','preparing','ready','shipped','completed','cancelled')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('promptpay','pay_at_store','cod')),
  payment_intent_id UUID REFERENCES payment_intents(id),
  paid_at TIMESTAMPTZ,
  subtotal BIGINT NOT NULL,
  discount_total BIGINT NOT NULL DEFAULT 0,
  shipping_fee BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL,
  sale_id BIGINT REFERENCES sales(id),
  cancelled_reason TEXT,
  tracking_no TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX online_orders_status_idx ON online_orders(status, created_at DESC);

CREATE TABLE online_order_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES online_orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  variant_label TEXT,
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_price BIGINT NOT NULL,
  discount BIGINT NOT NULL DEFAULT 0,
  line_total BIGINT NOT NULL
);

-- Web channel: a virtual terminal + system staff so paid web orders appear in sales reports.
INSERT INTO roles (key, name, permissions, max_discount_pct, is_system) VALUES ('system', 'System', '{}', 0, true) ON CONFLICT (key) DO NOTHING;
INSERT INTO staff (employee_code, name, pin_hash, role_id, is_active)
  SELECT 'WEB', 'เว็บไซต์ (Online)', '!disabled', id, false FROM roles WHERE key='system'
  ON CONFLICT (employee_code) DO NOTHING;
INSERT INTO terminals (branch_id, code, name)
  SELECT id, 'WEB', 'Online Shop' FROM branches ORDER BY id LIMIT 1
  ON CONFLICT (code) DO NOTHING;

UPDATE roles SET permissions = array_append(permissions, 'orders.manage')
  WHERE key IN ('admin','manager','supervisor') AND NOT ('orders.manage' = ANY(permissions));
