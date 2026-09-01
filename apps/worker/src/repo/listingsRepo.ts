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
