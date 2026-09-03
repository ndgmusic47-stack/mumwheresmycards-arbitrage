-- SOURCING WORKFLOW item 9 (two-stage eBay enrichment): storage for the
-- optional second-stage "Get Item" call, fired only for a small, budgeted
-- set of PROMISING listings per scan run (see apps/worker/src/scan/
-- scanRunner.ts) — never for every search result.
--
-- condition_descriptors is stored RAW/unmapped (eBay's numeric
-- name/value dictionary IDs, JSON-encoded) rather than interpreted — see
-- RawEbayItemDetail's doc comment in packages/providers/src/ebay/
-- EbayListingsProvider.ts for why. enriched_at is NULL until this listing
-- has actually gone through stage two at least once; that NULL-ness is the
-- signal the UI uses to show "not enriched yet" vs "enriched", not an
-- empty conditionDescriptors array (which is also a real, valid outcome —
-- eBay simply had nothing structured to say about this listing's condition).

ALTER TABLE ebay_listings ADD COLUMN condition_descriptors TEXT;
ALTER TABLE ebay_listings ADD COLUMN condition_description TEXT;
ALTER TABLE ebay_listings ADD COLUMN enriched_at TEXT;
