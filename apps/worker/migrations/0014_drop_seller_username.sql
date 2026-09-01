-- Migration 0014: drop ebay_listings.seller_username
--
-- Context: eBay disables production API keysets that have not either (a)
-- implemented their Marketplace Account Deletion / Account Closure
-- Notification webhook, or (b) been granted an exemption from that
-- requirement. The requirement applies to apps that retain eBay-account-
-- linked data. This app never used seller_username for anything beyond an
-- on-screen label on the opportunity detail page — no tracking, no
-- cross-referencing, no retention logic depended on it.
--
-- Rather than argue the point, this migration removes the column entirely
-- (after nulling any existing values) so the honest answer to "does this
-- app store eBay user data" is simply no. seller_feedback_score and
-- seller_feedback_pct are RATINGS, not identity, and are kept — they feed
-- listing-quality scoring elsewhere in the app.

UPDATE ebay_listings SET seller_username = NULL;

ALTER TABLE ebay_listings DROP COLUMN seller_username;
