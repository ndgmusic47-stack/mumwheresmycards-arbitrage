-- Canonical card model. Every row is one EXACT printing. Never merge rows
-- across variant/edition/language/finish — printing_hash is the sole identity
-- key used by every join in the rest of the schema.

CREATE TABLE cards (
  id              TEXT PRIMARY KEY,          -- = printing_hash (deterministic, see packages/core/src/card)
  game            TEXT NOT NULL DEFAULT 'pokemon',
  name            TEXT NOT NULL,             -- "Charizard"
  set_name        TEXT NOT NULL,             -- "Base Set"
  set_code        TEXT NOT NULL,             -- "BS"
  card_number     TEXT NOT NULL,             -- "4/102"
  year            INTEGER NOT NULL,
  language        TEXT NOT NULL DEFAULT 'EN',
  edition         TEXT NOT NULL DEFAULT 'na',    -- '1st' | 'unlimited' | 'na'
  variant         TEXT NOT NULL DEFAULT 'normal',-- 'normal' | 'holo' | 'reverse_holo' | 'stamped' | 'promo'
  finish          TEXT NOT NULL DEFAULT 'na',    -- e.g. 'shadowless' | 'unlimited_shadow' | 'na'
  rarity          TEXT,
  stamp_type      TEXT,                      -- e.g. staff/prerelease/cosmos holo stamp
  printing_hash   TEXT NOT NULL UNIQUE,      -- redundant w/ id, kept explicit for clarity in joins
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cards_name ON cards(name);
CREATE INDEX idx_cards_set_code ON cards(set_code);
CREATE INDEX idx_cards_lookup ON cards(name, set_code, card_number, year, language, edition, variant, finish);
