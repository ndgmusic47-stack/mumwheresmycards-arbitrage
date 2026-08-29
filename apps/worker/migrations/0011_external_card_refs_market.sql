-- Adds `market` to external_card_refs: PokeTrace's catalogue exposes a
-- 'US' | 'EU' market dimension per card (see CatalogueCardDTO.market), which
-- the catalogue sync previously read off every card but then silently
-- discarded before this migration — never stored anywhere. That data loss
-- matters because card IDENTITY has no market dimension (packages/core
-- resolves a printing the same way regardless of which market it was sold
-- in), so the SAME internal card can legitimately pick up more than one
-- external_card_refs row from the same provider — one per market it's
-- catalogued in. Without a stored `market`, findExternalRefForCard()
-- (apps/worker/src/repo/externalCardRefsRepo.ts) could only pick a row with
-- an unordered `LIMIT 1`, meaning which market's pricing a card's profile
-- was built from was arbitrary and could change between runs. This column
-- lets that lookup order rows by an explicit, visible market preference
-- instead of by whatever order SQLite happens to return them in.
ALTER TABLE external_card_refs ADD COLUMN market TEXT;

CREATE INDEX idx_external_card_refs_market ON external_card_refs(internal_card_id, market);
