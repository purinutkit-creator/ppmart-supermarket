-- Member password login, extended profile and member cards (RFID / barcode / printed number)
ALTER TABLE members
  ADD COLUMN password_hash TEXT,
  ADD COLUMN password_changed_at TIMESTAMPTZ,
  ADD COLUMN failed_logins INT NOT NULL DEFAULT 0,
  ADD COLUMN locked_until TIMESTAMPTZ,
  ADD COLUMN address TEXT,
  ADD COLUMN gender TEXT CHECK (gender IN ('male','female','other','unspecified')),
  ADD COLUMN nationality TEXT,
  ADD COLUMN country TEXT,
  ADD COLUMN profile_completed_at TIMESTAMPTZ;

CREATE TABLE member_cards (
  code TEXT PRIMARY KEY,                -- printed card number, barcode value or RFID/NFC UID
  kind TEXT NOT NULL DEFAULT 'number' CHECK (kind IN ('number','barcode','rfid')),
  member_id INT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  linked_by INT REFERENCES staff(id),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX member_cards_member_idx ON member_cards(member_id);
