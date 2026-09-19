/**
 * HOW MUCH EVIDENCE A CARD MUST HAVE BEFORE IT IS WORTH SEARCHING FOR.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE PROBLEM, measured on the live database 2026-09-19. Roughly 1,900
 * catalogued cards were excluded from the grade universe for failing a flat
 * confidence bar of 0.4, and 1,174 of them sat at exactly 0.35 — one notch
 * under a line nobody chose against evidence.
 *
 * Confidence here is a 0-1 trust score on the card's price data. Where the
 * provider gives none, it is derived from sale counts: 20 or more scores
 * 1.0, so 0.4 is about eight recorded sales and 0.35 is seven.
 *
 * "At least eight sales" is a sensible bar for a £6 card, where thin data is
 * genuinely noise. It is close to nonsense for a £600 one, where few sales
 * is what scarcity looks like. The flat bar therefore excludes cards FOR
 * BEING SCARCE, which is circular: the rarer and more valuable the card, the
 * more likely it is refused, and the premium end is exactly where this
 * business is heading.
 *
 * And it fails silently. A card refused here never enters the eBay search
 * universe, so no listing for it is ever priced and nothing reports a near
 * miss. It simply is not there.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHICH WAY THE BAR SHOULD MOVE, because the opposite case is real.
 *
 * There is an honest argument for demanding MORE evidence on an expensive
 * card: more money at risk. It is rejected here for a specific reason, not
 * waved away. This gate is not a risk control — it asks "is there enough
 * data to compute anything at all". Risk is handled where risk belongs: in
 * the economics, in the price-plausibility check, and in the slab-ladder
 * gate. Loading a second, implicit risk rule onto a data-availability test
 * is how a card comes to be rejected twice for the same reason while the
 * report names neither.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE RISK OF THIS CHANGE, stated plainly. Thin data is precisely how the
 * impossible slab prices got in — a PSA 10 backed by a handful of sales,
 * one of them freakish. Lowering the bar for expensive cards lets more
 * thinly-evidenced cards through, and some of them will be wrong.
 *
 * What makes it defensible NOW rather than a week ago is that the
 * contradiction is caught downstream: gradeLadderPlausibility.ts pulls any
 * card whose ladder runs backwards or whose PSA 10 is an impossible multiple
 * of its own PSA 9 out of the actionable feed, whatever its confidence. The
 * loosening and the catch were not in place together before.
 *
 * It is still a loosening. If the feed fills with thin nonsense, this is the
 * first thing to put back.
 */

/** The two anchor points the bar interpolates between. */
export interface ConfidenceBarSettings {
  /** Required confidence at or below `pivotLowValue`. */
  atLowValue: number;
  /** Required confidence at or above `pivotHighValue`. */
  atHighValue: number;
  /** Raw value (GBP) at or below which the full bar applies. */
  pivotLowValue: number;
  /** Raw value (GBP) at or above which the relaxed bar applies. */
  pivotHighValue: number;
}

/**
 * 0.4 down to 0.2 between £50 and £500.
 *
 * The numbers are chosen to be legible rather than clever. 0.4 is the bar
 * that has been in force all along and stays put for ordinary cards. 0.2 is
 * about four recorded sales — still evidence, still refusing a card with one
 * lonely sale behind it, but no longer demanding that a scarce card behave
 * like a common one.
 *
 * £50 and £500 bracket the range this business actually operates in: below
 * £50 the flat £28 grading fee dominates and thin data is not worth the
 * risk; above £500 a card with four sales a month is simply a normal scarce
 * card.
 *
 * Every one of these is a setting because the right values are a matter of
 * the operator's appetite and will want tuning against his own results.
 */
export const DEFAULT_CONFIDENCE_BAR: ConfidenceBarSettings = {
  atLowValue: 0.4,
  atHighValue: 0.2,
  pivotLowValue: 50,
  pivotHighValue: 500,
};

/**
 * The confidence a card of this value must clear.
 *
 * Linear between the two pivots, flat outside them. Deliberately monotonic
 * and continuous: a card must never clear the bar by getting *cheaper*, and
 * a penny either side of a pivot must not change the verdict.
 *
 * A null or unusable raw value returns the strict bar. Not knowing what a
 * card is worth is not a reason to trust its data more.
 */
export function requiredGradeConfidence(
  rawValue: number | null,
  settings: ConfidenceBarSettings = DEFAULT_CONFIDENCE_BAR,
): number {
  const { atLowValue, atHighValue, pivotLowValue, pivotHighValue } = settings;

  if (rawValue === null || !Number.isFinite(rawValue) || rawValue <= 0) return atLowValue;
  if (rawValue <= pivotLowValue) return atLowValue;
  if (rawValue >= pivotHighValue) return atHighValue;

  // A degenerate or inverted pivot range would otherwise divide by zero or
  // interpolate backwards. The strict bar is the safe answer to a
  // misconfiguration.
  const span = pivotHighValue - pivotLowValue;
  if (span <= 0) return atLowValue;

  const travelled = (rawValue - pivotLowValue) / span;
  return atLowValue + (atHighValue - atLowValue) * travelled;
}
