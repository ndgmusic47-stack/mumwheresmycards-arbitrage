/**
 * Opportunity states.
 *
 * IMPORTANT CHANGE from v1: a state reflects ECONOMIC QUALIFICATION, never
 * a score threshold. `QUALIFIED_FLIP` / `QUALIFIED_GRADE` mean the trade
 * cleared the economic rules in ../filters/predicates.ts. Score orders
 * qualifying opportunities within those states and nothing more — there is
 * no longer any state that a candidate can only reach by scoring above an
 * arbitrary number.
 */
export const OPPORTUNITY_STATES = [
  /** Meets the raw-flip economic bar (£ profit AND ROC). */
  "QUALIFIED_FLIP",
  /** Meets a defined grading economic structure and all guardrails. */
  "QUALIFIED_GRADE",
  /** Qualifies economically, but the card's identity needs photo verification first. */
  "INSPECT_PHOTOS",
  /**
   * AI INTELLIGENCE spec item 6, gap (A): the economics qualified as a raw
   * FLIP/GRADE candidate, but eBay's own structured condition (or, weakly,
   * the title) says this listing is an already-graded slab. A graded slab
   * must never be bought/sold on raw-card economics — see
   * listingStructure.ts and the override in engine.ts. Deliberately not in
   * QUALIFIED_STATES: this needs a human to confirm the slab/grade before
   * it's actionable, exactly like INSPECT_PHOTOS.
   */
  "REVIEW_ALREADY_GRADED",
  /**
   * AI INTELLIGENCE spec item 6, gap (B): the title matches confident
   * lot/bundle language, so the listing's full price cannot safely be
   * attributed to a single card's economics. See listingStructure.ts.
   * Deliberately not in QUALIFIED_STATES for the same reason as above.
   */
  "REVIEW_LIKELY_LOT",
  /**
   * AI INTELLIGENCE spec item 7: the listing's title carries an explicit,
   * non-near-mint condition claim, and the opportunity only clears the
   * qualifying bar against the near-mint reference price — the
   * condition-adjusted reference (see conditionAdjustedReference on the
   * candidate) does not. Never silently repriced off this; a human must
   * confirm actual condition first. Deliberately not in QUALIFIED_STATES.
   */
  "REVIEW_CONDITION_DEPENDENT",
  /** Real economics computed, but it doesn't clear the bar. Kept and shown. */
  "WATCH",
  /** No market snapshot for this printing yet — economics not computable. */
  "NO_MARKET_DATA",
  "REJECTED_CARD_IDENTITY_UNCERTAIN",
  /**
   * The economics calculators refused this listing's numbers outright —
   * e.g. a real eBay listing reporting a £0 price, or a currency with no
   * configured FX rate. These calculators throw on invalid input by design
   * (it's meant to catch programming bugs), which is exactly wrong for one
   * malformed real-world listing out of hundreds: found live, a single
   * £0-price listing threw out of buildOpportunities() and killed the
   * ENTIRE scan run, discarding every other listing's opportunity with it.
   * buildOpportunities() now catches per-listing/per-strategy and downgrades
   * to this state instead of propagating — see the try/catch around
   * buildFlipCandidate/buildGradeCandidate below.
   */
  "REJECTED_COMPUTATION_ERROR",
] as const;

export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

export const STATE_LABELS: Record<OpportunityState, string> = {
  QUALIFIED_FLIP: "QUALIFIED FLIP",
  QUALIFIED_GRADE: "QUALIFIED GRADE",
  INSPECT_PHOTOS: "INSPECT PHOTOS",
  REVIEW_ALREADY_GRADED: "REVIEW — ALREADY GRADED",
  REVIEW_LIKELY_LOT: "REVIEW — LIKELY LOT/BUNDLE",
  REVIEW_CONDITION_DEPENDENT: "REVIEW — CONDITION DEPENDENT",
  WATCH: "WATCH",
  NO_MARKET_DATA: "NO MARKET DATA",
  REJECTED_CARD_IDENTITY_UNCERTAIN: "REJECTED — CARD IDENTITY UNCERTAIN",
  REJECTED_COMPUTATION_ERROR: "REJECTED — INVALID LISTING DATA",
};

/** States that represent an actual actionable opportunity. */
export const QUALIFIED_STATES: OpportunityState[] = ["QUALIFIED_FLIP", "QUALIFIED_GRADE", "INSPECT_PHOTOS"];
