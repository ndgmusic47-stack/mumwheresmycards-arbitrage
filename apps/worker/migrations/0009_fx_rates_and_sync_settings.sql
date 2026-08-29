-- Additional configurable settings introduced by the catalogue-first
-- realignment: static v1 FX rates (PokeTrace prices in USD/EUR, this
-- application is GBP throughout), catalogue sync tuning, the coarse
-- market-profile eligibility thresholds, and the eBay-search API budget.
-- All editable in Settings — none of these are live feeds.
INSERT INTO settings (key, value, description) VALUES
  ('fx_rates', '{"GBP":1,"USD":0.79,"EUR":0.86}', 'Static v1 FX rates for normalizing provider prices to GBP. Editable in Settings — not a live feed; refresh periodically.'),
  ('catalogue_sync', '{"pageSize":20,"maxPagesPerRun":25}', 'Catalogue sync tuning: page size per provider call, and the max pages fetched in one run (keeps a single scheduled sync bounded and resumable).'),
  ('market_profile_settings', '{"minFlipRawValue":5,"minFlipLiquidity":"LOW","minFlipConfidence":0.4,"minGradeRawValue":5,"minGradeConfidence":0.4,"maxAcceptableBreakEvenGradeForEligibility":10}', 'Coarse pre-filter thresholds deciding whether a catalogued card enters the Dynamic Flip/Grade Universe at all — looser than, and separate from, the per-listing dashboard filters.'),
  ('ebay_scan_budget', '{"maxCardsSearchedPerRun":25,"maxListingsPerCardSearch":20}', 'How many Dynamic Flip/Grade Universe members to search eBay for per scan run, and how many listings to pull per card — the API-quota guard for the eBay step.');
