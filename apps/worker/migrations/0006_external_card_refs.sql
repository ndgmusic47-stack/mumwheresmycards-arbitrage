-- Maps an internal card (printing_hash) to a market-data provider's OWN
-- card identifier. Required because the real PokeTrace API is looked up by
-- provider card ID (GET /cards/{id}), not by searching identity fields —
-- see ARCHITECTURE.md "CARD MARKET" layer and the realignment note "Store
-- the provider's own card ID. Do not rely only on printingHash for
-- external provider mapping." A card could in principle carry refs from
-- more than one provider over time (e.g. if the market-data provider is
-- swapped later per the provider-abstraction design), hence the composite
-- unique key rather than one ref per card.
CREATE TABLE external_card_refs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  provider              TEXT NOT NULL,             -- 'poketrace' | ...
  provider_card_id      TEXT NOT NULL,              -- the provider's own opaque ID
  internal_card_id      TEXT NOT NULL REFERENCES cards(id),
  provider_updated_at   TEXT,                       -- provider's own "last updated" timestamp, used for sync freshness
  raw_payload           TEXT,                       -- json, provider's catalogue-entry response for audit
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_card_id)
);

CREATE INDEX idx_external_card_refs_internal ON external_card_refs(internal_card_id);
CREATE INDEX idx_external_card_refs_provider ON external_card_refs(provider);
