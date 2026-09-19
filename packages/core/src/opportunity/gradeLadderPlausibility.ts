import type { PsaGrade } from "../calc/types.js";

/**
 * IS THIS SLAB LADDER A MARKET, OR IS IT BROKEN DATA?
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT PROMPTED THIS. Reported 2026-09-18: "the tool isn't working — I'm not
 * getting new cards in my feed."
 *
 * The supply was fine. eBay listings were arriving at 22,000-26,000 a day.
 * What was wrong was the content of the few rows that reached him. Every one
 * of the 141 live listings under £30 that broke even at PSA 6 — the exact
 * trade he hunts — looked like this:
 *
 *   PSA 6 profit band   cards   avg buy   avg claimed PSA 10   multiple
 *   under £10             39     £17.10        £3,055            68x
 *   £10-25                34     £19.56        £4,937           106x
 *   £25-50                25     £20.76        £5,409           112x
 *   £50-100                8     £21.38        £5,097           104x
 *   £100-250              24     £16.84       £15,774           358x
 *   over £250             11     £19.55       £31,922           655x
 *
 * A £19.55 raw Pokémon single does not have a £31,922 PSA 10. He passed 138
 * of those 141 by hand. He was right to, and the tool had given him no way
 * to tell the broken rows from the real ones — so the honest ones were
 * buried and the feed read as empty.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MEASURED ACROSS THE WHOLE LIVE FEED, 2026-09-18. 12,747 active qualified
 * GRADE opportunities:
 *
 *   ladder runs backwards somewhere ......  3,484  (27%)
 *   PSA 10 more than  3x its own PSA 9 ... 11,891  (93%)
 *   PSA 10 more than  5x its own PSA 9 ... 11,131  (87%)
 *   PSA 10 more than 10x its own PSA 9 ...  6,763  (53%)
 *   PSA 10 more than 20x its own PSA 9 ...  1,920  (15%)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE 13 SEPTEMBER PRICING CHANGE DID NOT FIX THIS, stated plainly
 * because it was reported as having done so.
 *
 * That change took each tier's LOWEST reported window instead of the
 * provider's average, to stop one freak sale owning a tier. Split by whether
 * a row has been repriced since:
 *
 *                              rows   inverted   PSA10 > 10x PSA9
 *   last priced before it     9,094     29.6%         54.1%
 *   repriced since it         3,653     21.8%         50.5%
 *
 * It helped — 29.6% to 21.8% — and it is nowhere near enough. The reason is
 * structural: picking the lowest of six windows defends against ONE bad
 * window. When every number attached to a card is wrong together, the lowest
 * of six wrong numbers is still wrong. The known cause of "wrong together"
 * is the card identity collapse — a jumbo or oversized promo sharing one
 * catalogue row with the standard card, so the jumbo's sold prices are
 * attached to a £19 card. No choice of window can repair that, and this
 * module does not pretend to: it detects the damage, it does not price
 * around it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE TWO TESTS, AND WHY THEY ARE DIFFERENT IN KIND.
 *
 * 1. MONOTONICITY. PSA grades are totally ordered and the market prices them
 *    that way: a PSA 9 of a card is never worth more than a PSA 10 of the
 *    same card. An inversion is therefore not a judgement call and needs no
 *    threshold — it is proof that at least one tier on that ladder is wrong.
 *    It says nothing about WHICH one, which is why this reviews rather than
 *    reprices.
 *
 * 2. THE PSA 10 JUMP. A real PSA 9 -> PSA 10 step is roughly 2-5x on modern
 *    cards, and reaches 10-20x only on genuinely scarce vintage. Above 10x
 *    the figure is far more often one thin-tier outlier than a market: the
 *    top tier always has the fewest sales and therefore the fattest tail.
 *    This one IS a judgement, the threshold is a setting, and 10 is where it
 *    starts by default — not for roundness, but because it is the point at
 *    which the live distribution above stops looking like a price ladder.
 *
 * Both are compared GRADED-TO-GRADED, deliberately. Comparing a slab to the
 * raw card would fold in the raw price's own errors and the genuine variance
 * in how much grading adds, and would flag honest vintage cards whose raw
 * copies are beaten up. The ladder is judged against itself.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT NEVER REJECTS AND NEVER EDITS A NUMBER. Same reason as
 * pricePlausibility.ts: the finding here is about the DATA, not the trade.
 * Nothing in this file knows whether the card is a good buy — it knows the
 * evidence being used to answer that question is internally contradictory.
 * So it moves the row to review with the contradiction spelled out, leaves
 * every computed figure exactly as computed, and lets a human look. A row
 * removed from the feed is counted and visible; nothing disappears silently.
 *
 * BLANK IS NOT ZERO. A tier with no data is skipped, not read as £0. A
 * missing PSA 9 does not make the PSA 10 infinitely suspicious, and a
 * missing middle rung does not manufacture an inversion across the gap —
 * adjacency is evaluated over the tiers that actually have values.
 */

/** A slab value per grade, as the ladder reports it. Null means no data. */
export type SlabLadder = Partial<Record<PsaGrade, number | null>>;

export type GradeLadderFindingKind = "LADDER_INVERTED" | "PSA10_JUMP_IMPLAUSIBLE";

export interface GradeLadderFinding {
  kind: GradeLadderFindingKind;
  /** Operator-facing sentence naming the exact contradiction. */
  detail: string;
}

export interface GradeLadderAssessment {
  /** True when the ladder contradicts itself and cannot be relied on. */
  implausible: boolean;
  findings: GradeLadderFinding[];
  /** PSA 10 / PSA 9, or null when either tier has no value. */
  psa10OverPsa9: number | null;
  /** Operator-facing explanation, or null when there is nothing to say. */
  reason: string | null;
}

/**
 * The most a PSA 10 may exceed its own PSA 9 before the ladder is treated as
 * damaged rather than steep.
 *
 * 10 flags 53% of the live feed as it stands. That is not a comfortable
 * number and it is the correct one: 27% of the same feed is provably
 * impossible on the monotonicity test alone, which needs no threshold and
 * admits no false positives. A market where half the rows are wrong is what
 * the measurement found, not what this constant assumes.
 *
 * Overridable per call via OpportunityEngineSettings.maxPsa10OverPsa9.
 * Raising it shows more rows and trusts the thin top tier further; lowering
 * it shows fewer and trusts it less.
 *
 * NOT yet exposed in the Settings UI, and said plainly here rather than
 * claimed: nothing reads it out of the settings table, so in production this
 * default is the only value in force. The same is true of
 * pricePlausibilityFloorRatio, whose comment does claim otherwise — both
 * want wiring, and until they have it the constant is the setting.
 */
export const DEFAULT_MAX_PSA10_OVER_PSA9 = 10;

/** Ascending, because every test here is about order. */
/**
 * THE WHOLE SCALE — widened from [6,7,8,9,10] on 2026-09-19, the same day
 * the ladder itself gained grades 1 to 5.
 *
 * Adding the low rungs without widening this check left a hole big enough
 * to drive the original bug straight back through. Found live, on the
 * operator's own dashboard, on a card he was being shown as actionable:
 *
 *   PSA 1  £412.16   sales not recorded
 *   PSA 2  £130.02   sales not recorded
 *   PSA 3  £112.41   sales not recorded
 *   PSA 4   £98.20   sales not recorded
 *   PSA 5  £112.41   sales not recorded
 *   PSA 6  £237.56   57 sales
 *   PSA 7  £374.70   60 sales
 *
 * A PSA 1 worth more than a PSA 7 of the same card is not a market, and the
 * gate could not see it because it started looking at PSA 6. Worse, the
 * break-even calculation CAN see it: it reported "breaks even at PSA 1.0"
 * and the card was presented as downside-protected on the strength of a
 * £412 figure with no sales behind it.
 *
 * So widening the ladder made the tool more dangerous, not less, until this
 * line changed. That is the lesson worth keeping: a new rung is a new place
 * for bad data to enter, and every check that guards the ladder has to grow
 * with it.
 */
const LADDER_GRADES: PsaGrade[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function assessGradeLadderPlausibility(
  ladder: SlabLadder,
  maxPsa10OverPsa9: number = DEFAULT_MAX_PSA10_OVER_PSA9,
): GradeLadderAssessment {
  const findings: GradeLadderFinding[] = [];

  // Only the tiers that actually carry a usable value. A blank tier is an
  // absent measurement, not a zero, and it takes no part in any comparison.
  const present = LADDER_GRADES.map((grade) => ({ grade, value: ladder[grade] ?? null })).filter(
    (rung): rung is { grade: PsaGrade; value: number } =>
      rung.value !== null && Number.isFinite(rung.value) && rung.value > 0,
  );

  // TEST 1 — monotonicity, over the tiers present. Comparing each tier to
  // the next one that HAS a value (rather than to grade+1) is what stops a
  // missing middle rung from inventing an inversion across the gap.
  for (let i = 1; i < present.length; i++) {
    const lower = present[i - 1]!;
    const higher = present[i]!;
    if (higher.value < lower.value) {
      findings.push({
        kind: "LADDER_INVERTED",
        detail:
          `PSA ${higher.grade} is priced at £${higher.value.toFixed(2)}, BELOW the PSA ${lower.grade} at ` +
          `£${lower.value.toFixed(2)}. A higher grade of the same card is never worth less than a lower one, ` +
          `so at least one of those two figures is wrong.`,
      });
    }
  }

  // TEST 2 — the PSA 10 jump, measured against the card's own PSA 9.
  const psa9 = ladder[9] ?? null;
  const psa10 = ladder[10] ?? null;
  const comparable =
    psa9 !== null && psa10 !== null && Number.isFinite(psa9) && Number.isFinite(psa10) && psa9 > 0 && psa10 > 0;
  const psa10OverPsa9 = comparable ? psa10! / psa9! : null;

  if (psa10OverPsa9 !== null && psa10OverPsa9 > maxPsa10OverPsa9) {
    findings.push({
      kind: "PSA10_JUMP_IMPLAUSIBLE",
      detail:
        `PSA 10 is priced at £${psa10!.toFixed(2)} against a PSA 9 at £${psa9!.toFixed(2)} — ` +
        `${psa10OverPsa9.toFixed(1)}x, past the ${maxPsa10OverPsa9}x limit. The PSA 10 tier has the fewest ` +
        `recorded sales of any grade, so a jump this size is far more often a single freak sale than a market.`,
    });
  }

  if (findings.length === 0) {
    return { implausible: false, findings: [], psa10OverPsa9, reason: null };
  }

  return {
    implausible: true,
    findings,
    psa10OverPsa9,
    reason:
      `SLAB PRICES FOR THIS CARD CONTRADICT THEMSELVES — the profit figures below are built on them. ` +
      `${findings.map((f) => f.detail).join(" ")} ` +
      `Nothing here says the listing is bad; it says the evidence used to value it is not trustworthy, so the ` +
      `profit at every grade is unreliable in a direction that cannot be determined from the data alone. Check ` +
      `the card's real sold prices before committing money.`,
  };
}
