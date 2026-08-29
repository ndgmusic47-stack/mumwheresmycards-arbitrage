-- Seeds the (placeholder) market preference used by
-- findExternalRefForCard() to pick deterministically between more than one
-- provider ref for the same internal card — see migration 0011 and
-- apps/worker/src/repo/externalCardRefsRepo.ts. EU-before-US is a starting
-- guess for a UK-based business, not a confirmed rule; editable here or via
-- Settings once real ingestion data shows actual market coverage/overlap.
INSERT INTO settings (key, value, description) VALUES
  ('external_ref_market_preference', '["EU","US"]', 'Preference order (most-preferred first) for which market''s provider catalogue ref to use when a card has more than one from the same provider. Placeholder default, not yet confirmed against real data.');
