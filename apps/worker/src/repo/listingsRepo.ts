import { Db } from "@mwmc/db";
import type { RawEbayListing } from "@mwmc/providers";

export async function upsertListing(db: Db, listing: RawEbayListing, cardId: string | null, identityConfidence: number, identityNotes: string | null): Promise<void> {
  await db.exec(
    `INSERT INTO ebay_listings (
       id, card_id, identity_confidence, identity_notes, title, price, currency,
       shipping_cost, listing_type, item_condition,
       seller_feedback_score, seller_feedback_pct, item_url, image_urls,
       location_country, watchers, bids, end_time, fetched_at, status, raw_payload, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now'), 'ACTIVE', ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       card_id = excluded.card_id,
       identity_confidence = excluded.identity_confidence,
       identity_notes = excluded.identity_notes,
       price = excluded.price,
       shipping_cost = excluded.shipping_cost,
       watchers = excluded.watchers,
       bids = excluded.bids,
       fetched_at = datetime('now'),
       -- STABILISATION item 8 (freshness): re-observing a listing in a live
       -- search means it's active again, regardless of what an earlier
       -- expireEndedAuctionListings() run may have marked it — a listing_id
       -- being reused (relisted) is rare but this keeps status honest either
       -- way, and is a no-op for the overwhelmingly common already-ACTIVE case.
       status = 'ACTIVE',
       updated_at = datetime('now')`,
    listing.ebayItemId,
    cardId,
    identityConfidence,
    identityNotes,
    listing.title,
    listing.price,
    listing.currency,
    listing.shippingCost,
    listing.listingType,
    listing.itemCondition ?? null,
    listing.sellerFeedbackScore ?? null,
    listing.sellerFeedbackPct ?? null,
    listing.itemUrl,
    JSON.stringify(listing.imageUrls),
    listing.locationCountry ?? null,
    listing.watchers ?? null,
    listing.bids ?? null,
    listing.endTime ?? null,
    listing.rawPayload ? JSON.stringify(listing.rawPayload) : null,
  );
}

/**
 * STABILISATION item 8 (freshness/lifecycle): `ebay_listings.status` has
 * existed since migration 0002 but nothing ever transitioned it away from
 * its INSERT-time 'ACTIVE' default — every persisted opportunity looked
 * "live" forever, regardless of how long ago its underlying listing was
 * last actually seen in a search.
 *
 * This closes the one case we can know FOR CERTAIN without guessing: an
 * AUCTION's `end_time` is a fact eBay reports, not an inference, so a
 * listing past it is provably no longer purchasable at its last-seen price.
 * Deliberately NOT extended to FIXED/BEST_OFFER listings that simply
 * haven't been re-searched in a while — the search budget is bounded (see
 * item 3's rotation), so "not re-observed recently" means "we haven't
 * looked", not "it's gone"; guessing REMOVED/ENDED there would misinform
 * the user in the unsafe direction. Those are surfaced via `fetched_at`
 * instead (opportunitiesRepo.ts / the dashboard) so the user can judge
 * staleness themselves rather than the system silently deciding for them.
 *
 * Two-step (SELECT the affected ids, then UPDATE just those) rather than a
 * single UPDATE ... WHERE, purely so the count of listings this actually
 * touched is known without depending on D1's `meta.changes` shape — makes
 * this trivially testable against a fake Db too.
 */
export async function expireEndedAuctionListings(db: Db): Promise<number> {
  const ended = await db.queryAll<{ id: string }>(
    `SELECT id FROM ebay_listings
     WHERE listing_type = 'AUCTION' AND status = 'ACTIVE' AND end_time IS NOT NULL AND end_time < datetime('now')`,
  );
  if (ended.length === 0) return 0;

  const placeholders = ended.map(() => "?").join(",");
  await db.exec(
    `UPDATE ebay_listings SET status = 'ENDED', updated_at = datetime('now') WHERE id IN (${placeholders})`,
    ...ended.map((row) => row.id),
  );
  return ended.length;
}
