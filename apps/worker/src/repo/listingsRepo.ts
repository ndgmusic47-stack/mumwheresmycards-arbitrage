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
  /*
   * IMAGES ARE UPGRADED HERE, NEVER DOWNGRADED.
   *
   * `upsertListing` deliberately does not touch `image_urls` on a rescan
   * (first observation wins), which left every listing holding the single
   * thumbnail the search stage returned. The getItem call made here carries
   * the seller's full gallery.
   *
   * COALESCE-style guard rather than a blind write: if this enrichment pass
   * came back with nothing usable, the existing value is kept. A stage-two
   * call that failed to return photographs must never erase the one photo
   * the search stage did find.
   */
  const imageUrls = detail.imageUrls?.filter((url) => typeof url === "string" && url.length > 0) ?? [];

  await db.exec(
    `UPDATE ebay_listings SET
       condition_descriptors = ?,
       condition_description = ?,
       item_description = ?,
       item_aspects = ?,
       image_urls = CASE WHEN ? IS NULL THEN image_urls ELSE ? END,
       enriched_at = datetime('now'),
       updated_at = datetime('now')
     WHERE id = ?`,
    JSON.stringify(detail.conditionDescriptors),
    detail.conditionDescription ?? null,
    detail.description ?? null,
    detail.aspects !== undefined ? JSON.stringify(detail.aspects) : null,
    imageUrls.length > 0 ? JSON.stringify(imageUrls) : null,
    imageUrls.length > 0 ? JSON.stringify(imageUrls) : null,
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

/**
 * Marks listings REMOVED when a complete search for their card came back
 * without them — the only way this tool can ever learn that a fixed-price
 * listing has SOLD.
 *
 * eBay's Browse API never tells us a Buy-It-Now has gone; the listing simply
 * stops appearing in search results. `expireEndedAuctionListings` above
 * handles auctions (they carry an end_time we can compare against), but until
 * now a fixed-price card that sold last week sat in the feed marked ACTIVE
 * forever. The user's dashboard was carrying 1,652 known-dead listings plus an
 * unknown number of silently-sold ones.
 *
 * Absence is only EVIDENCE of death under two conditions, and this function
 * is deliberately only called when both hold (see scanRunner.ts):
 *
 *  1. **The result set was complete.** Searches are capped at
 *     `maxListingsPerCardSearch` and sorted NEWLY_LISTED, so for a card with
 *     more listings than the cap, a live older listing legitimately falls out
 *     of the window. Only when the search returned FEWER results than the cap
 *     did we actually see everything, making absence meaningful.
 *  2. **The listing was inside the price filter.** Searches carry a
 *     `maxPrice` ceiling derived from the card's economics. A listing priced
 *     above it is excluded by eBay, not missing from eBay — so only listings
 *     at or under the ceiling that we applied can be judged.
 *
 * Uses REMOVED rather than SOLD or ENDED on purpose: what was observed is
 * "this stopped coming back in our searches", not "eBay says it sold". SOLD
 * would be a claim about something we cannot see. And the judgement is
 * self-correcting either way — `upsertListing`'s ON CONFLICT clause sets
 * `status = 'ACTIVE'` whenever a listing is seen again, so a false positive
 * repairs itself on the next scan of that card rather than persisting.
 */
export async function markVanishedListingsRemoved(
  db: Db,
  cardId: string,
  seenListingIds: Set<string>,
  /** The ceiling actually applied to this search, or null if unfiltered. */
  appliedMaxPrice: number | null,
): Promise<number> {
  const candidates = await db.queryAll<{ id: string }>(
    `SELECT id FROM ebay_listings
     WHERE card_id = ? AND status = 'ACTIVE'
       AND (? IS NULL OR price <= ?)`,
    cardId,
    appliedMaxPrice,
    appliedMaxPrice,
  );

  const vanished = candidates.map((row) => row.id).filter((id) => !seenListingIds.has(id));
  if (vanished.length === 0) return 0;

  for (const chunk of chunkForSqlIn(vanished)) {
    const placeholders = chunk.map(() => "?").join(",");
    await db.exec(
      `UPDATE ebay_listings SET status = 'REMOVED', updated_at = datetime('now')
       WHERE id IN (${placeholders}) AND status = 'ACTIVE'`,
      ...chunk,
    );
  }
  return vanished.length;
}
