/**
 * WHEN A LISTING LEAVES eBAY, WHAT DO WE ACTUALLY KNOW?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. Nothing in this tool can say whether anything sells. It
 * counts what is FOR SALE, which is supply, and every judgement about which
 * cards and which games are worth pursuing has been made on that. The
 * operator caught it: "listing counts measure available listings, not
 * completed purchases or selling speed."
 *
 * eBay will not tell us. The Marketplace Insights API, which serves sold
 * data, is restricted and closed to new applicants; PokeTrace's own
 * sold-listings endpoint returns 403 without a $98/month plan. So the
 * question is what can be established from the search results we already
 * pull, honestly, without buying anything.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ANSWER IS: ONE CASE, CLEANLY, AND NOT THE OTHERS.
 *
 * An AUCTION that has passed its end time, had bids on it, and no longer
 * comes back in searches, sold. Not "probably sold" — an auction with a bid
 * above the reserve ends in a sale, and the final bid is the price somebody
 * actually paid. That is a real sold comp, obtained legitimately from the
 * Browse API we already call.
 *
 * Everything else is guesswork wearing a label:
 *
 *   - A FIXED-PRICE listing that disappears may have sold, or expired
 *     unsold, or been pulled by the seller. These are indistinguishable from
 *     absence, and this project's own listingsRepo already says so: it marks
 *     such rows REMOVED rather than SOLD because "SOLD would be a claim
 *     about something we cannot see". That judgement stands.
 *
 *   - An auction that vanishes BEFORE its end time was cancelled, not won.
 *     Treating it as a sale would put a phantom comp in the record at
 *     whatever the bidding happened to have reached.
 *
 *   - An auction that ends with NO bids did not sell. That is real
 *     information — it says the market would not pay the opening price — but
 *     it is not a sale and must never be counted as one.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS BUYS. Sell-through and time-to-sale become measurable on the
 * auction side, per card and per game, from the day it starts recording.
 * That is the only route to picking games on demand rather than on shelf
 * space, and it is the only sold-price series this tool can own outright.
 *
 * It is SLOW. Auctions are a minority of listings and a card may see none
 * for weeks. Nothing here backfills — evidence starts accruing the day it
 * ships, which is the argument for shipping it early rather than the
 * argument for skipping it.
 *
 * AND IT IS BIASED, in a direction worth naming. Auctions attract different
 * sellers and different cards than fixed-price listings, and an auction
 * price is what one winning bidder paid on one evening. A sold-through rate
 * measured here describes the auction market, not the whole market, and
 * should never be quoted as the latter.
 */

export type ListingCloseKind =
  /** Proven: the auction ran to its end with bids on it. */
  | "AUCTION_SOLD"
  /** Proven: the auction ran to its end and nobody bid. */
  | "AUCTION_UNSOLD"
  /** Unknowable: it stopped appearing, and that is all we saw. */
  | "VANISHED";

export interface ListingCloseFacts {
  listingType?: string | null;
  /** Number of bids eBay last reported. NULL means not known, never zero. */
  bids?: number | null;
  /** ISO timestamp the auction was due to end, or null for a fixed price. */
  endTime?: string | null;
  /** Last price seen. For a live auction that is the current bid. */
  price?: number | null;
}

export interface ListingCloseAssessment {
  kind: ListingCloseKind;
  /**
   * The price someone actually paid, for AUCTION_SOLD only. Null when the
   * sale is proven but the final figure was not captured — a sale with no
   * price is still a data point for sell-through and is useless as a comp,
   * and conflating the two would put a £0 sale in the record.
   */
  salePrice: number | null;
  /** Why, in words, for the audit trail on the row. */
  reason: string;
}

/**
 * Classify a listing that has stopped appearing in search results.
 *
 * `now` is injected rather than read from the clock so this stays pure and
 * testable, and so a scan can classify against the moment its results were
 * fetched rather than the moment the row happened to be written.
 */
export function assessListingClose(
  facts: ListingCloseFacts,
  now: Date = new Date(),
): ListingCloseAssessment {
  const vanished = (reason: string): ListingCloseAssessment => ({ kind: "VANISHED", salePrice: null, reason });

  if (facts.listingType !== "AUCTION") {
    return vanished(
      "Fixed-price or best-offer listing that stopped appearing. It may have sold, expired or been withdrawn, and those are indistinguishable from here.",
    );
  }

  if (!facts.endTime) {
    return vanished("Auction with no recorded end time — cannot establish that it ran to completion.");
  }

  const endedAt = new Date(facts.endTime);
  if (Number.isNaN(endedAt.getTime())) {
    return vanished("Auction with an unreadable end time — cannot establish that it ran to completion.");
  }

  if (endedAt.getTime() > now.getTime()) {
    // Gone before its own deadline. Whatever happened, it was not a win.
    return vanished(
      `Auction disappeared before its end time (${facts.endTime}) — withdrawn or ended early, not won at the bid on record.`,
    );
  }

  // NULL bids is "not known", never zero — the same rule the rest of this
  // codebase follows. An unknown bid count cannot prove a sale OR prove the
  // absence of one, so it resolves to the honest answer rather than either.
  if (facts.bids === null || facts.bids === undefined) {
    return vanished("Auction ended, but the bid count was never captured — cannot tell a sale from a no-sale.");
  }

  if (facts.bids <= 0) {
    return {
      kind: "AUCTION_UNSOLD",
      salePrice: null,
      reason: `Auction ran to ${facts.endTime} with no bids. The market declined the opening price — real information, and not a sale.`,
    };
  }

  const price = typeof facts.price === "number" && Number.isFinite(facts.price) && facts.price > 0 ? facts.price : null;

  return {
    kind: "AUCTION_SOLD",
    salePrice: price,
    reason:
      `Auction ran to ${facts.endTime} with ${facts.bids} bid${facts.bids === 1 ? "" : "s"}` +
      (price === null
        ? " — a proven sale, but the final price was not captured, so it counts for sell-through and not as a comp."
        : ` — sold at £${price.toFixed(2)}. Somebody paid this.`),
  };
}
