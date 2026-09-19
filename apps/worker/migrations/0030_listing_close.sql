-- What happened when a listing left eBay.
--
-- WHY. Nothing in this tool could say whether anything SELLS. It counted
-- what was for sale, and every judgement about which cards and which games
-- to pursue rested on that. A shelf full of slabs nobody buys looks
-- identical to a thriving market.
--
-- eBay will not simply tell us: the Marketplace Insights API is restricted
-- and closed to new applicants, and PokeTrace's sold-listings endpoint
-- returns 403 without a $98/month plan. So these columns record the one
-- thing that CAN be established from the searches already being run — see
-- packages/core/src/market/listingClose.ts for the full reasoning.
--
-- THE ONE PROVABLE CASE. An auction that passed its end time with bids on
-- it, and then stopped appearing, sold — and the final bid is a price
-- somebody actually paid. That is a real comp.
--
-- WHAT IS DELIBERATELY NOT RECORDED AS A SALE. A fixed-price listing that
-- disappears may have sold, expired, or been withdrawn, and those are
-- indistinguishable from absence. listingsRepo.ts already refuses to call
-- that SOLD because "SOLD would be a claim about something we cannot see",
-- and that judgement is preserved here: such rows get close_reason
-- 'VANISHED', which is what was observed rather than what might have
-- happened. An auction that disappears BEFORE its end time was cancelled,
-- not won, and is VANISHED too.
--
-- close_price is NULLABLE ON A PROVEN SALE, deliberately. An auction can be
-- known to have sold while its final figure was never captured. That is
-- still a data point for sell-through and useless as a comp, and the two
-- must not be conflated — a zero here would enter the record as a card that
-- sold for nothing.
--
-- Nothing backfills. Evidence accrues from the day this ships, which is the
-- argument for shipping it early rather than for skipping it.

ALTER TABLE ebay_listings ADD COLUMN closed_at TEXT;
ALTER TABLE ebay_listings ADD COLUMN close_reason TEXT;
ALTER TABLE ebay_listings ADD COLUMN close_price REAL;

-- The sold-comp query is "give me the proven sales for this card", so it is
-- worth an index from the start: this table is already 67,000 rows and only
-- grows.
CREATE INDEX idx_ebay_listings_close ON ebay_listings(card_id, close_reason, closed_at DESC);
