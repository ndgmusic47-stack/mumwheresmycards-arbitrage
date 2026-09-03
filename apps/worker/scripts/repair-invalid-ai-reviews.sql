-- RELEASE HARDENING 2026-09-03 — one-off repair for the AI review /
-- enrichment ordering bug (see selectiveAiCandidateReview.ts's doc comment
-- for the full root cause).
--
-- Before the fix, a candidate could get ai_review_status written from bare
-- search-result evidence — i.e. its listing was NEVER successfully
-- stage-two enriched (ebay_listings.enriched_at IS NULL) at the time it was
-- AI-reviewed. Those rows are not wrong in a way that harms a user today
-- (AI review never creates/blocks an opportunity on its own — see
-- applyAiCandidateReview's own doc comment, and REVIEW/BLOCK only ever hide
-- a row from the default ACTIONABLE feed, never delete it), but they ARE
-- permanently stuck: listOpportunitiesForAiReview only ever offers
-- ai_review_status IS NULL rows to a future run, so a candidate reviewed
-- this way will NEVER be reconsidered even after it's genuinely enriched
-- later.
--
-- This script clears ONLY the four AI-review columns (migration 0021) on
-- rows matching that exact invalid condition, putting them back to
-- "not yet AI-reviewed" — ai_review_status = NULL — so the NEXT scan that
-- successfully enriches their listing will pick them up for a genuine,
-- evidence-backed review. It never touches state, qualifies, or any
-- economics column; it never deletes an opportunity.
--
-- USAGE (run the SELECT first to see what would change, then the UPDATE):
--
--   wrangler d1 execute mwmc-db --local  --file=apps/worker/scripts/repair-invalid-ai-reviews.sql   -- local dev DB
--   wrangler d1 execute mwmc-db --remote --file=apps/worker/scripts/repair-invalid-ai-reviews.sql   -- production DB (take a backup first — see wrangler d1 export)
--
-- (swap --local/--remote's database name for mwmc-db-live-local if you're
-- repairing the live_local environment's database instead.)
--
-- Safe to run more than once — once repaired, a row no longer matches the
-- WHERE clause, so a second run is a no-op for it.

-- 1) PREVIEW — how many rows are affected, and which ones. Read this before
--    running the UPDATE below; if it returns 0 rows, there is nothing to
--    repair and the UPDATE is a no-op.
SELECT
  o.id,
  o.listing_id,
  o.state,
  o.strategy,
  o.ai_review_status,
  o.ai_reviewed_at,
  l.enriched_at AS listing_enriched_at
FROM opportunities o
JOIN ebay_listings l ON l.id = o.listing_id
WHERE o.ai_review_status IS NOT NULL
  AND l.enriched_at IS NULL;

-- 2) REPAIR — clear the four AI-review columns for exactly those rows.
UPDATE opportunities
SET
  ai_review_status = NULL,
  ai_review_reason = NULL,
  ai_review_confidence = NULL,
  ai_reviewed_at = NULL
WHERE id IN (
  SELECT o.id
  FROM opportunities o
  JOIN ebay_listings l ON l.id = o.listing_id
  WHERE o.ai_review_status IS NOT NULL
    AND l.enriched_at IS NULL
);
