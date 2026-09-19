-- 0028 — two columns, both about not lying to the operator.
--
-- Written 2026-09-13 after auditing the live tool against real sold prices.
--
-- graded_confidence
--   market_snapshots.confidence describes the RAW card. It was the only
--   confidence there was, so it was also what appeared beside slab
--   economics: live, a Pikachu EX XY124 row read "100% confidence,
--   VERY_HIGH liquidity" — both earned by 110 raw sales — next to a PSA 10
--   of £65,878 standing on 34. This column carries the graded side's own
--   answer, derived from the graded tiers' sale counts and from how far the
--   provider's price windows disagree with each other.
--   NULL means the provider priced no named grade: nothing is known about
--   the slabs, which must never be read as the raw figure and never as zero.
--
-- pricing_version
--   flip_profiles/grade_profiles are recomputed on an age window (12h for
--   eligible cards, 14 days otherwise). That means a change to HOW a slab is
--   priced does not reach the screen when it is deployed — it reaches it
--   whenever each card's window next expires. A pricing fix shipped on
--   12 September was still invisible in production on the 13th for exactly
--   this reason. A profile whose stamp differs from the current
--   MARKET_PRICING_VERSION is now due immediately, regardless of age.
--   NULL means written before stamping existed, and is likewise due.
--
-- Both are nullable with no default and no backfill: an existing row
-- genuinely does not have these values, and inventing one would be the same
-- class of mistake this migration exists to correct.

ALTER TABLE market_snapshots ADD COLUMN graded_confidence REAL;

ALTER TABLE flip_profiles ADD COLUMN pricing_version TEXT;

-- The refresh selector filters on this on every scan, alongside computed_at.
CREATE INDEX IF NOT EXISTS idx_flip_profiles_pricing_version
  ON flip_profiles(pricing_version);
