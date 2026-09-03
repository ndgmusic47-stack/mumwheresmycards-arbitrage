-- SOURCING WORKFLOW item 17 (review-status workflow): a manual sourcing
-- decision the USER records against a specific opportunity —
-- UNREVIEWED/CHECKED/INTERESTED/PASS/BOUGHT — plus free-text notes and when
-- it was last touched. Deliberately separate from, and never influencing,
-- the engine's own computed `state`/`qualifies`/`score` columns: this is a
-- human workflow layer on top of the economics, not a new qualification
-- signal. See updateOpportunityReview() in
-- apps/worker/src/repo/opportunitiesRepo.ts for how a value here survives a
-- re-scan of the same listing (it deliberately is NOT part of
-- upsertOpportunity's ON CONFLICT UPDATE SET).
--
-- Existing rows all default to 'UNREVIEWED' (the correct, honest starting
-- state for every opportunity that predates this migration).

ALTER TABLE opportunities ADD COLUMN review_status TEXT NOT NULL DEFAULT 'UNREVIEWED';
ALTER TABLE opportunities ADD COLUMN review_notes TEXT;
ALTER TABLE opportunities ADD COLUMN reviewed_at TEXT;
