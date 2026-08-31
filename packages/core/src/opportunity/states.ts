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
  /** Real economics computed, but it doesn't clear the bar. Kept and shown. */
  "WATCH",
  /** No market snapshot for this printing yet — economics not computable. */
  "NO_MARKET_DATA",
  "REJECTED_CARD_IDENTITY_UNCERTAIN",
] as const;

export type OpportunityState = (typeof OPPORTUNITY_STATES)[number];

export const STATE_LABELS: Record<OpportunityState, string> = {
  QUALIFIED_FLIP: "QUALIFIED FLIP",
  QUALIFIED_GRADE: "QUALIFIED GRADE",
  INSPECT_PHOTOS: "INSPECT PHOTOS",
  WATCH: "WATCH",
  NO_MARKET_DATA: "NO MARKET DATA",
  REJECTED_CARD_IDENTITY_UNCERTAIN: "REJECTED — CARD IDENTITY UNCERTAIN",
};

/** States that represent an actual actionable opportunity. */
export const QUALIFIED_STATES: OpportunityState[] = ["QUALIFIED_FLIP", "QUALIFIED_GRADE", "INSPECT_PHOTOS"];
