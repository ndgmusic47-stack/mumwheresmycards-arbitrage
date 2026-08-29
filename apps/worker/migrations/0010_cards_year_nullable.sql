-- Makes `cards.year` nullable. PokeTrace does not resolve a release year
-- for every set (some real sets return `releaseDate: null` — see
-- PokeTraceCatalogueProvider.ts) and the catalogue sync previously SKIPPED
-- every card in such a set entirely rather than store it with an unknown
-- year — silently dropping otherwise-perfectly-addressable, sellable cards
-- from the catalogue. `year` is identity/display metadata only (never used
-- in pricing, grading, or hashing logic beyond being one more distinguishing
-- field — see packages/core/src/card/hash.ts), so there is no reason it
-- needs to be non-null. See packages/core/src/card/types.ts CardPrinting.year
-- doc comment.
--
-- SQLite has no ALTER COLUMN to drop a NOT NULL constraint, so this rebuilds
-- the table (standard SQLite pattern). No production data exists yet (this
-- application has not been deployed — see ARCHITECTURE.md), so a plain
-- rebuild is safe; done via 12-step-style rebuild rather than editing
-- migration 0001 directly so this migration stays resumable/idempotent for
-- anyone who already applied 0001-0009 against a local D1.
PRAGMA foreign_keys=OFF;

CREATE TABLE cards_new (
  id              TEXT PRIMARY KEY,
  game            TEXT NOT NULL DEFAULT 'pokemon',
  name            TEXT NOT NULL,
  set_name        TEXT NOT NULL,
  set_code        TEXT NOT NULL,
  card_number     TEXT NOT NULL,
  year            INTEGER,                    -- nullable: unresolved release year, never fabricated
  language        TEXT NOT NULL DEFAULT 'EN',
  edition         TEXT NOT NULL DEFAULT 'na',
  variant         TEXT NOT NULL DEFAULT 'normal',
  finish          TEXT NOT NULL DEFAULT 'na',
  rarity          TEXT,
  stamp_type      TEXT,
  printing_hash   TEXT NOT NULL UNIQUE,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_ebay_scanned_at TEXT
);

INSERT INTO cards_new (
  id, game, name, set_name, set_code, card_number, year, language,
  edition, variant, finish, rarity, stamp_type, printing_hash, notes,
  created_at, updated_at, last_ebay_scanned_at
)
SELECT
  id, game, name, set_name, set_code, card_number, year, language,
  edition, variant, finish, rarity, stamp_type, printing_hash, notes,
  created_at, updated_at, last_ebay_scanned_at
FROM cards;

DROP TABLE cards;
ALTER TABLE cards_new RENAME TO cards;

CREATE INDEX idx_cards_name ON cards(name);
CREATE INDEX idx_cards_set_code ON cards(set_code);
CREATE INDEX idx_cards_lookup ON cards(name, set_code, card_number, year, language, edition, variant, finish);

PRAGMA foreign_keys=ON;
