-- AI INTELLIGENCE spec items 19-20: proprietary learning database.
--
-- BEFORE adding anything, this migration only fills the gaps in what
-- already exists — most of the "purchase/arrival/grading/sale truth
-- tables" this spec item asks for were already built in STABILISATION
-- (migration 0004: inventory, grading_submissions, grading_results,
-- transactions) and the review-status workflow (migration 0016:
-- opportunities.review_status/review_notes/reviewed_at). In particular,
-- `inventory.forecast_snapshot` (added after migration 0004, see
-- apps/worker/src/routes/inventory.ts) already freezes a full copy of the
-- opportunity's forecast at PURCHASE time — that is exactly a "learning
-- snapshot", already shipped, for the one moment (an actual purchase) it
-- already covers.
--
-- What was genuinely missing, closed here:
--
--   1. review_reason_code on `opportunities` — a CLOSED VOCABULARY for WHY
--      a human made a review decision. review_notes (migration 0016) is
--      free text; free text cannot be aggregated into "which reasons
--      account for most PASS decisions" later. Not a DB CHECK constraint,
--      deliberately — see review_status's own precedent in migration 0016,
--      which also validates only in application code
--      (apps/worker/src/repo/opportunitiesRepo.ts's REVIEW_STATUSES) so the
--      vocabulary can grow without a migration.
--
--   2. learning_review_snapshots — inventory.forecast_snapshot only exists
--      for opportunities that became an actual PURCHASE. The majority of
--      real review decisions are PASS/INTERESTED/CHECKED, which never
--      create an inventory row at all — meaning the single most valuable
--      training signal ("the system showed X, a human with real judgment
--      said no, here is exactly what X looked like at that moment") had
--      nowhere to land. This table is the same "freeze a JSON copy, never
--      update it" pattern inventory.forecast_snapshot already uses,
--      captured on EVERY review decision (PASS and BOUGHT included) rather
--      than only a purchase.
--
--   3. Arrival truth fields on `inventory` — a purchase can be recorded at
--      `PURCHASED` status, but nothing captured whether the card that
--      physically ARRIVED actually matched what the listing claimed
--      (condition, identity). That is precisely the ground truth the
--      condition-adjusted-reference work (spec item 7) and the
--      graded-slab/lot classifier (spec item 6) would eventually want to
--      calibrate against — "how often does a title's condition claim
--      actually hold up on arrival" is an empirical question this schema
--      previously had no way to ever answer.

ALTER TABLE opportunities ADD COLUMN review_reason_code TEXT;

CREATE TABLE learning_review_snapshots (
  id                TEXT PRIMARY KEY,             -- uuid
  opportunity_id    TEXT NOT NULL REFERENCES opportunities(id),
  review_status     TEXT NOT NULL,                 -- the status this decision set it to
  review_reason_code TEXT,
  review_notes      TEXT,
  -- Full copy of the opportunities row exactly as it stood the moment this
  -- decision was recorded — see inventory.forecast_snapshot for the
  -- established precedent this mirrors. Never updated after insert.
  opportunity_snapshot TEXT NOT NULL,
  captured_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_learning_review_snapshots_opportunity ON learning_review_snapshots(opportunity_id, captured_at DESC);

ALTER TABLE inventory ADD COLUMN arrived_at TEXT;
-- NULL = not yet confirmed either way (the honest default — never defaults
-- to "matched"). 1 = card as described. 0 = a real mismatch found on
-- arrival (wrong condition, wrong card, undisclosed damage, etc.).
ALTER TABLE inventory ADD COLUMN condition_matched_listing INTEGER;
ALTER TABLE inventory ADD COLUMN arrival_notes TEXT;
