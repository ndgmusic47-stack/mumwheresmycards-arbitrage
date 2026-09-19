-- The low half of the grade scale, as stored profit columns.
--
-- WHY. The operator's stated business: "I want money all through the
-- grading scale. I want to buy at £200 raw and sell at £500 PSA 5. I'm not
-- going to aim for gems." Until 2026-09-19 the engine's grade ladder ran
-- PSA 6 to 10 only, so that sentence could not be expressed anywhere in the
-- tool — not rejected, not scored badly, simply unsayable.
--
-- The prices were never missing. Migration 0026 has stored the provider's
-- whole graded spectrum in market_snapshots.graded_prices_json since
-- 12 September. Measured on the live database the day this migration was
-- written: PSA 5 present on 20,150 snapshots, PSA 4 on 12,315, PSA 3 on
-- 7,928, PSA 2 on 5,647, PSA 1 on 12,736. Fetched, stored, and read by
-- nothing on the scan path.
--
-- WHY COLUMNS HERE, WHEN 0026 DELIBERATELY CHOSE JSON. Different question.
-- 0026 stores an OBSERVATION whose shape belongs to the provider — thirty
-- odd tiers across six grading companies, varying by card — and JSON is
-- right for that. These five are a COMPUTED RESULT on a fixed scale this
-- project owns, and they are filtered on directly: the dashboard's
-- "must make at least £X at PSA n" builds `o.psa{n}_profit >= ?`, which
-- needs a real column to be indexable and to match the five that already
-- exist for 6 to 10. Five columns on a closed scale is not the open-ended
-- migration treadmill 0026 was avoiding.
--
-- NULL IS NOT ZERO, and matters more here than anywhere else in the schema.
-- A null means this card has no recorded sales at that grade, so the rung
-- was never tested. Read as zero it would become "this card is worthless as
-- a PSA 3", which is a different and false claim — and on the low grades,
-- where sales are thinnest, it would be false constantly. Every filter
-- comparison against NULL is false in SQL, which is the behaviour wanted:
-- an untested grade never satisfies a profit floor.

ALTER TABLE opportunities ADD COLUMN psa1_profit REAL;
ALTER TABLE opportunities ADD COLUMN psa2_profit REAL;
ALTER TABLE opportunities ADD COLUMN psa3_profit REAL;
ALTER TABLE opportunities ADD COLUMN psa4_profit REAL;
ALTER TABLE opportunities ADD COLUMN psa5_profit REAL;
