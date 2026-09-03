import { round4 } from "../calc/fees.js";

/**
 * SOURCING WORKFLOW item 10 ("why is this cheap?" panel): the single,
 * unambiguous number the panel is built around — how the delivered
 * acquisition cost compares to a real market reference. Deliberately NOT a
 * causal claim ("this is cheap because...") — just the honest arithmetic,
 * so the UI can present it as a fact to verify against, not a conclusion.
 *
 * FLIP and GRADE use different references because they're priced against
 * different things: a FLIP candidate's whole economics run off QSV (the
 * raw card's own quick-sale value), but a GRADE candidate has no single
 * QSV (see engine.ts's buildGradeCandidate — `qsv` is never set on a GRADE
 * row); what it DOES have is the raw card's plain market value, which is
 * still the right "what would this normally cost" reference even though
 * the actual profit path runs through grading, not a resale of the raw
 * card. Never falls back from one reference to the other — a GRADE row
 * with no raw_market_price gets `referenceValue: null`, not a QSV it was
 * never priced against.
 */
export interface PriceContextInput {
  strategy: "FLIP" | "GRADE";
  totalAcquisitionCost: number;
  /** From the opportunity row — null for every GRADE row (see doc comment). */
  qsv: number | null;
  /** From the market_snapshots row this opportunity was actually priced
   *  against (opportunity.market_snapshot_id) — null if no snapshot. */
  rawMarketPrice: number | null;
}

export interface PriceContextResult {
  referenceLabel: "QSV" | "raw market value";
  /** Null when no usable reference exists yet — never a fabricated number. */
  referenceValue: number | null;
  /** Positive = delivered cost sits below the reference (cheaper); negative
   *  = above it. Null whenever referenceValue is null or non-positive
   *  (a reference of £0 would make the fraction meaningless, not just
   *  unusually large). */
  discountFraction: number | null;
}

export function computePriceContext(input: PriceContextInput): PriceContextResult {
  const referenceLabel: PriceContextResult["referenceLabel"] = input.strategy === "FLIP" ? "QSV" : "raw market value";
  const reference = input.strategy === "FLIP" ? input.qsv : input.rawMarketPrice;

  if (reference === null || reference <= 0) {
    return { referenceLabel, referenceValue: null, discountFraction: null };
  }

  return {
    referenceLabel,
    referenceValue: reference,
    discountFraction: round4((reference - input.totalAcquisitionCost) / reference),
  };
}
