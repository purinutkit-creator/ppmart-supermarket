-- Multiple online storefronts: each store has its own website (/shop/<slug>), on/off switch,
-- stock branch, product scope, banners, theme, shipping and payment options.

ALTER TABLE products
  ADD COLUMN compare_price BIGINT CHECK (compare_price IS NULL OR compare_price >= 0); -- "was" price shown struck through

CREATE TABLE storefronts (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  branch_id INT REFERENCES branches(id),     -- stock + pickup branch (NULL = first active branch)
  sort_order INT NOT NULL DEFAULT 0,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Uploaded storefront media (logos, hero banners)
CREATE TABLE shop_media (
  id SERIAL PRIMARY KEY,
  storefront_id INT REFERENCES storefronts(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BYTEA NOT NULL,
  width INT,
  height INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE online_orders ADD COLUMN storefront_id INT REFERENCES storefronts(id);

-- The existing single shop becomes the first storefront (keeps its settings and orders).
INSERT INTO storefronts (slug, name, enabled, branch_id, config)
SELECT 'main', COALESCE(s.value->>'title', 'ช้อปออนไลน์'), COALESCE((s.value->>'enabled')::boolean, true),
       NULLIF(s.value->>'branchId', '')::int, COALESCE(s.value, '{}'::jsonb)
FROM (SELECT (SELECT value FROM settings WHERE key = 'shop') AS value) s;

UPDATE online_orders SET storefront_id = (SELECT id FROM storefronts WHERE slug = 'main') WHERE storefront_id IS NULL;
