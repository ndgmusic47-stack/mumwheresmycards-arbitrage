import { round2 } from "./fees.js";

/**
 * SOURCING WORKFLOW item 14 — "the actionable number on an auction is MAX
 * BID, not current-bid profit."
 *
 * Reuses the exact same ceiling derivation packages/core/src/market/flipProfile.ts
 * already uses at the CARD/market level (solve for the highest all-in
 * acquisition cost that still clears both the absolute profit floor and the
 * ROC floor) — just applied here per LISTING, against the sale proceeds this
 * specific opportunity already computed, rather than a reference QSV. Kept
 * as a separate small function (not a call into flipProfile.ts) because the
 * inputs differ: flipProfile.ts solves from a raw QSV before any listing
 * exists; this solves from an actual listing's own `expectedNetSaleProceeds`,
 * which already reflects that listing's real sale-side economics.
 *
 * Deliberately FLIP-only. GRADE strategy has no single "sale proceeds" line
 * (proceeds depend on which grade the card comes back as) and qualifies via
 * a multi-branch economic-class predicate, not a linear profit/ROC
 * inequality — solving an equivalent ceiling for GRADE would need real new
 * design work, not a one-line reuse of this formula. Callers get `null` for
 * a GRADE row rather than a fabricated number (see computeMaxBidForRow).
 */
export interface MaxBidInput {
  /** This opportunity's own expected_net_sale_proceeds — the cash back after
   *  exit-market fees, independent of acquisition cost. Null when the QSV
   *  itself was never resolved (e.g. WATCH rows with no usable reference). */
  expectedNetSaleProceeds: number | null;
  /** What this opportunity was actually priced at (current bid, for an
   *  AUCTION listing, plus postage/tax/fees) — total_acquisition_cost. */
  totalAcquisitionCost: number;
  /** The bid/asking price itself (o.listing_price) — for an AUCTION listing
   *  this is the CURRENT bid, per the STABILISATION bug-9 fix; for a fixed
   *  price listing it's just the price. */
  listingPrice: number;
  minNetProfit: number;
  minReturnOnCapital: number;
}

export interface MaxBidResult {
  /** The highest bid (before postage/tax/fees) that would still clear the
   *  qualification bar — null when there's no usable sale-side reference to
   *  solve against at all. */
  maxBid: number | null;
  /** maxBid's counterpart in total-delivered-cost terms (maxBid + the same
   *  non-bid costs this listing actually carries). */
  maxDeliveredCost: number | null;
  /** postage + import tax + acquisition fees actually captured for this
   *  listing — the gap between totalAcquisitionCost and listingPrice. */
  nonBidCost: number;
  /** maxBid - the current listing price. Positive: real room to raise a bid
   *  and still qualify. Negative: the current price already exceeds what
   *  would qualify — bidding further is not supported by the economics. */
  headroomVsCurrentPrice: number | null;
}

export function computeMaxBid(input: MaxBidInput): MaxBidResult {
  const nonBidCost = round2(input.totalAcquisitionCost - input.listingPrice);

  if (input.expectedNetSaleProceeds === null) {
    return { maxBid: null, maxDeliveredCost: null, nonBidCost, headroomVsCurrentPrice: null };
  }

  // Same derivation as flipProfile.ts's maxProfitableAcquisitionPrice:
  //   netProceeds - acquisition >= minNetProfit => acquisition <= netProceeds - minNetProfit
  //   (netProceeds - acquisition) / acquisition >= minROC => acquisition <= netProceeds / (1 + minROC)
  const capFromProfit = input.expectedNetSaleProceeds - input.minNetProfit;
  const capFromRoc = input.expectedNetSaleProceeds / (1 + input.minReturnOnCapital);
  const maxDeliveredCost = round2(Math.max(0, Math.min(capFromProfit, capFromRoc)));
  const maxBid = round2(Math.max(0, maxDeliveredCost - nonBidCost));

  return {
    maxBid,
    maxDeliveredCost,
    nonBidCost,
    headroomVsCurrentPrice: round2(maxBid - input.listingPrice),
  };
}
