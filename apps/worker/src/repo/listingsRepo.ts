import { Db, chunkForSqlIn, type EbayListingRow } from "@mwmc/db";
import type { RawEbayListing, RawEbayItemDetail } from "@mwmc/providers";

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
 * SOURCING WORKFLOW item 9 (two-stage eBay enrichment): persists the
 * result of a stage-two "Get Item" call against a listing already saved by
 * upsertListing(). Deliberately a separate function/statement rather than
 * folded into upsertListing's own UPSERT — enrichment happens on a small,
 * budgeted subset of listings, at a different point in the pipeline
 * (AFTER buildOpportunities() has decided which candidates are promising),
 * not on every listing at search time.
 *
 * A listing enriched with an EMPTY conditionDescriptors array is a real,
 * meaningful outcome (eBay had nothing structured to say) and is stored as
 * such — enriched_at (not descriptor presence) is what distinguishes
 * "checked, nothing there" from "never checked".
 *
 * AI INTELLIGENCE gap 2 (migration 0020): also persists description/aspects
 * from the SAME Get Item call — item_aspects stores "[]" (not null) when
 * `detail.aspects` is an empty array, same "checked, nothing there" vs
 * "never checked" convention as condition_descriptors; stays null only when
 * `detail.aspects` itself is undefined (the field was entirely absent).
 */
export async function saveListingEnrichment(db: Db, detail: RawEbayItemDetail): Promise<void> {
  await db.exec(
    `UPDATE ebay_listings SET
       condition_descriptors = ?,
       condition_description = ?,
       item_description = ?,
       item_aspects = ?,
       enriched_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
    JSON.stringify(detail.conditionDescriptors),
    detail.conditionDescription ?? null,
    detail.description ?? null,
    detail.aspects !== undefined ? JSON.stringify(detail.aspects) : null,
    detail.ebayItemId,
  );
}

/**
 * SOURCING WORKFLOW item 9: which of these listing ids have ALREADY been
 * through stage-two enrichment at least once — used to stop scanRunner
 * from spending its per-run enrichment budget re-checking listings that
 * already have an answer. Split out from saveListingEnrichment so it's
 * trivially testable against a fake Db, same rationale as
 * expireEndedAuctionListings below.
 */
export async function getAlreadyEnrichedListingIds(db: Db, listingIds: string[]): Promise<Set<string>> {
  if (listingIds.length === 0) return new Set();
  // 2026-09-03 fix: was one unbounded `IN (?,?,?...)` for the whole array —
  // failed live with "too many SQL variables" once a scan accumulated
  // enough qualified candidates. See sqlChunk.ts's doc comment.
  const result = new Set<string>();
  for (const chunk of chunkForSqlIn(listingIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.queryAll<{ id: string }>(
      `SELECT id FROM ebay_listings WHERE id IN (${placeholders}) AND enriched_at IS NOT NULL`,
      ...chunk,
    );
    for (const row of rows) result.add(row.id);
  }
  return result;
}

/**
 * AI INTELLIGENCE gap 3 (selective AI review in the candidate pipeline):
 * batch-fetches full listing rows by id — scanRunner.ts's new AI review
 * step needs each candidate's own enriched evidence (condition/description/
 * aspects/seller data — see buildAdvisoryEvidence in
 * apps/worker/src/ai/advisoryEvidence.ts) to build a grounded
 * AiCandidateRouterProvider request, and the existing opportunity-listing
 * join query lives in routes/opportunities.ts (which scan/ must not import
 * from). Chunked the same way as getAlreadyEnrichedListingIds above — see
 * sqlChunk.ts's doc comment for why an unbounded IN(...) is unsafe.
 */
export async function getListingsByIds(db: Db, listingIds: string[]): Promise<Map<string, EbayListingRow>> {
  const result = new Map<string, EbayListingRow>();
  if (listingIds.length === 0) return result;
  for (const chunk of chunkForSqlIn(listingIds)) {
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.queryAll<EbayListingRow>(`SELECT * FROM ebay_listings WHERE id IN (${placeholders})`, ...chunk);
    for (const row of rows) result.set(row.id, row);
  }
  return result;
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

  // Same unbounded-IN-clause fix as getAlreadyEnrichedListingIds above —
  // see sqlChunk.ts's doc comment.
  for (const chunk of chunkForSqlIn(ended.map((row) => row.id))) {
    const placeholders = chunk.map(() => "?").join(",");
    await db.exec(
      `UPDATE ebay_listings SET status = 'ENDED', updated_at = datetime('now') WHERE id IN (${placeholders})`,
      ...chunk,
    );
  }
  return ended.length;
}
