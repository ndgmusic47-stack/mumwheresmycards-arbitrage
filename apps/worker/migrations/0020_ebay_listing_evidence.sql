-- AI INTELLIGENCE gap 2 (multimodal, evidence-rich Listing Analyst): stores
-- two more fields from the SAME stage-two "Get Item" enrichment call that
-- migration 0015 already added condition_descriptors/condition_description
-- for — eBay's free-text listing description and seller-declared item
-- specifics ("aspects": Language/Grade/Card Condition/etc.), confirmed
-- field names against developer.ebay.com/api-docs/buy/browse/resources/
-- item/methods/getItem, 2026-09-03. Nothing new is fetched from eBay; this
-- is the same enrichment call, just no longer throwing two of its fields
-- away. Nullable, same "NULL means never enriched, not 'checked, nothing
-- there'" convention as the existing enrichment columns — see
-- saveListingEnrichment() in listingsRepo.ts.

ALTER TABLE ebay_listings ADD COLUMN item_description TEXT;
ALTER TABLE ebay_listings ADD COLUMN item_aspects TEXT;
