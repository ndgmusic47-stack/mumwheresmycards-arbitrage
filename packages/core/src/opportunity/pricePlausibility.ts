/**
 * IS THIS PRICE BELIEVABLE AT ALL?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TRADE THIS EXISTS TO STOP. Found live on 2026-09-13, at the very top
 * of a search built from the operator's own strategy:
 *
 *   Lugia ex, EX Unseen Forces #105/115 — £55.00 buy-it-now
 *   DOWNSIDE PROTECTED · QUALIFIED GRADE · PSA 6 profit £879.17
 *
 * Every number in that row was computed correctly. The tool's own record for
 * that same card, at that same moment, held a conservative raw value of
 * £1,522.93 and a maximum sane acquisition price of £938.96. It knew the raw
 * card was worth over a thousand pounds and presented a £55 asking price as
 * a protected trade, with no warning anywhere.
 *
 * A genuine Lugia ex 105/115 does not sell for £55 buy-it-now. It is
 * damaged, it is a proxy, it is a reprint, it is a fake, it is a different
 * card, or the listing is not what it says. The single most reliable signal
 * available — the gap between the asking price and what the card is worth —
 * was sitting in the database and nothing looked at it.
 *
 * This is the same shape as the purchase the operator had already regretted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT IS NOT A REJECTION. A cheap listing is the entire premise of the
 * business, and this rule cannot be allowed to throw away the good ones. So
 * it never rejects and never edits a number: it moves the row to review, so
 * a human looks at the photographs before any money moves. The economics
 * shown alongside stay exactly as computed — they are what the trade WOULD
 * be, if the card is what the listing claims. That "if" is the whole point.
 *
 * WHY IT ALSO FIXES AUCTIONS, WITHOUT A SECOND RULE. Grade economics are
 * computed against a listing's current price, and for an auction that is the
 * live bid. An auction opening at £1 therefore produced, live, a £939 profit
 * at PSA 6 and sorted straight to the top of a profit-ordered feed. Under
 * this rule £1 against a four-figure card is exactly as implausible as £55
 * was, for exactly the same reason — the price is not yet a real price — and
 * the row goes to review until the bid rises into a believable range, at
 * which point a later scan qualifies it normally. One rule, both problems,
 * no auction-specific special case anywhere.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT COMPARES AGAINST. The card's CONSERVATIVE raw value (QSV), not the
 * provider's raw average. The average is the statistic a mis-listed bundle
 * distorts, and it runs high — on the very card above it read £1,655 against
 * a true market figure nearer £1,025. Measuring a suspicious discount
 * against an inflated reference would flag honest listings. QSV is derived
 * from sold medians with a haircut already applied, so it is both lower and
 * better evidenced.
 *
 * WHEN IT SAYS NOTHING. No reference, or a non-positive one, means the
 * question cannot be asked, and an unanswerable question is not a finding.
 * Absent evidence is not evidence — the same rule the rest of the engine
 * follows.
 */

export interface PricePlausibilityInput {
  /** Everything it costs to get the card in hand: price plus postage etc. */
  deliveredCost: number;
  /**
   * The card's own conservative raw reference (QSV) in GBP, or null when the
   * card has no sold-median evidence to derive one from.
   */
  rawReference: number | null;
  /**
   * Whether the price being judged is a live auction bid. The RULE does not
   * change — a price far below the card's value is not a usable price either
   * way — but the EXPLANATION does, and it matters. On a fixed price the
   * likely story is that the card is not what it claims; on an auction the
   * likely story is simply that bidding has not finished. Telling an
   * operator to inspect a card for damage when the real answer is "come back
   * when the bid is real" is a small lie that costs him time.
   */
  isAuction?: boolean;
}

export interface PricePlausibilityAssessment {
  /** True when the price is too far below the card's own value to believe. */
  implausible: boolean;
  /** deliveredCost / rawReference, or null when it could not be computed. */
  ratio: number | null;
  /** Operator-facing explanation. Null when there is nothing to say. */
  reason: string | null;
}

/**
 * The default floor, as a fraction of the card's conservative raw value.
 *
 * 0.25 is chosen against real listings rather than picked for roundness. A
 * grading buy is normally 50-100% of a card's raw value — you are paying
 * roughly what the raw card is worth and adding value by grading it — and
 * even an excellent raw flip find is 30-50%. Below a quarter, the discount
 * has stopped being a bargain and started being a description of a different
 * card.
 *
 * Measured against the cases that prompted this:
 *   Lugia ex at £55 against £1,522.93 ......  3.6%  flagged
 *   the £1 opening auction bid ..............  0.1%  flagged
 *   the Blastoise bought by mistake at £30 .. 20.3%  flagged
 *   a genuine half-price find ............... 50.0%  passes
 *
 * Adjustable in Settings, because the right number is a matter of the
 * operator's appetite and will want tuning against his own results.
 */
export const DEFAULT_PRICE_PLAUSIBILITY_FLOOR_RATIO = 0.25;

export function assessPricePlausibility(
  input: PricePlausibilityInput,
  floorRatio: number = DEFAULT_PRICE_PLAUSIBILITY_FLOOR_RATIO,
): PricePlausibilityAssessment {
  const { deliveredCost, rawReference } = input;

  if (rawReference === null || !Number.isFinite(rawReference) || rawReference <= 0) {
    return { implausible: false, ratio: null, reason: null };
  }
  if (!Number.isFinite(deliveredCost) || deliveredCost <= 0) {
    // A zero or negative delivered cost is a malformed listing, and
    // REJECTED_COMPUTATION_ERROR already owns that case. Saying nothing here
    // keeps one failure reported by one rule.
    return { implausible: false, ratio: null, reason: null };
  }

  const ratio = deliveredCost / rawReference;
  if (ratio >= floorRatio) {
    return { implausible: false, ratio, reason: null };
  }

  const measurement =
    `£${deliveredCost.toFixed(2)} delivered against a conservative raw value of £${rawReference.toFixed(2)} ` +
    `for this exact printing — ${(ratio * 100).toFixed(1)}% of what the raw card is worth, below the ` +
    `${(floorRatio * 100).toFixed(0)}% floor.`;

  return {
    implausible: true,
    ratio,
    reason: input.isAuction
      ? `BID TOO LOW TO BE A REAL PRICE YET — the economics below are not decided. ${measurement} ` +
        `Grade and flip figures are computed against the CURRENT bid, so at this stage they describe a purchase ` +
        `nobody is going to make. Nothing is wrong with the listing on this evidence; it simply has not finished ` +
        `bidding. It qualifies on its own once the bid reaches a believable level — and if it somehow ends here, ` +
        `check the card as carefully as you would any other listing at this price.`
      : `PRICE TOO GOOD TO BE TRUE — VERIFY THE CARD BEFORE BUYING. ${measurement} ` +
        `The economics below are correct IF the card is what the listing says it is, and that is the part to ` +
        `check: heavy damage, a proxy or reprint, a fake, the wrong printing, or a listing that is not what it ` +
        `appears. A settled asking price this far under the card's own value is far more often a different card ` +
        `than a bargain.`,
  };
}
