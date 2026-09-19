-- HOW MANY SALES SIT BEHIND EACH GRADED PRICE.
--
-- 2026-09-13. The operator bought a card on this tool's numbers and found
-- afterwards that the grade values it showed were the price guide's own
-- EXTRAPOLATIONS — a PSA 9 figure the publisher marks as an estimate,
-- standing on roughly one graded sale a year.
--
-- The tool had no way to know that, and no way to say it. Exactly one sample
-- size survived ingestion: the RAW tier's. It was then carried downstream and
-- rendered as "slab liquidity", so a once-a-year PSA 10 price wore the
-- liquidity of a raw card that sells weekly.
--
-- WHY A JSON MAP, same reasoning as 0026's graded_prices_json: the set of
-- tiers a provider returns is not ours to fix, and thirty nullable INTEGER
-- columns would be a migration every time it changed.
--
-- `estimated_grades_json` records the grades whose price is a provider
-- AVERAGE because no sold median existed for that tier. Everything else is
-- now the lower of the 7-day and 30-day medians, matching the raw side.
-- A grade in this list is a weaker number than the rest of the ladder.
--
-- Both are additive and nullable. A snapshot taken before this migration has
-- neither, and everything downstream must treat absent as "not known" — never
-- as zero sales, which would silently disqualify every existing row.

ALTER TABLE market_snapshots ADD COLUMN graded_sale_counts_json TEXT;
ALTER TABLE market_snapshots ADD COLUMN estimated_grades_json TEXT;
