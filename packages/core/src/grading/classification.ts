import type { GradeLadderResult, PsaGrade } from "../calc/types.js";
import { round2 } from "../calc/fees.js";

/**
 * ECONOMIC CLASSIFICATION of a grading candidate.
 *
 * The engine must discover safe opportunities, balanced opportunities AND
 * large asymmetric opportunities. Being artificially conservative — e.g.
 * demanding that PSA 8 be profitable — throws away exactly the trades with
 * the best payoff structures. Being fake-scientific — inventing a grade
 * probability and calling the result an expected value — is worse.
 *
 * So instead of one pass/fail bar, every candidate is classified by the
 * SHAPE of its economics:
 *
 *   DOWNSIDE PROTECTED  PSA 7 already breaks even. The floor is covered, so
 *                       8/9/10 are upside on top of a trade that doesn't
 *                       lose. This is the most attractive structure there
 *                       is and is scored accordingly.
 *
 *   BALANCED            PSA 8 is around break-even (small, bounded loss)
 *                       and PSA 9 makes real money. The realistic middle of
 *                       the distribution pays.
 *
 *   ASYMMETRIC          The upper grades are exceptional enough to be worth
 *                       surfacing even though the lower grades lose. NOT a
 *                       buy recommendation — a discovery rule. The downside
 *                       is shown explicitly alongside it, and the required
 *                       hit rate says how often a 10 must land.
 *
 * A candidate can satisfy more than one structure; the strongest applies,
 * in the order above. Every threshold is editable in Settings.
 */

export type EconomicClass = "DOWNSIDE_PROTECTED" | "BALANCED" | "ASYMMETRIC" | "UNCLASSIFIED";

export interface ClassificationSettings {
  /** PSA7 profit at or above this qualifies as downside protected. */
  downsideProtectedMinPsa7Profit: number;
  /** Max acceptable PSA8 LOSS, as a fraction of graded basis (0.10 = -10%). */
  balancedMaxPsa8LossPctOfBasis: number;
  /** PSA9 must clear the greater of this absolute figure... */
  balancedMinPsa9Profit: number;
  /** ...and this fraction of the graded basis. */
  balancedMinPsa9ProfitPctOfBasis: number;
  /** Asymmetric discovery: minimum absolute PSA10 profit. */
  asymmetricMinPsa10Profit: number;
  /** Asymmetric discovery: minimum PSA10 GROSS slab value / graded basis. */
  asymmetricMinPsa10GrossMultiple: number;
}

export const DEFAULT_CLASSIFICATION_SETTINGS: ClassificationSettings = {
  downsideProtectedMinPsa7Profit: 0,
  balancedMaxPsa8LossPctOfBasis: 0.1,
  balancedMinPsa9Profit: 40,
  balancedMinPsa9ProfitPctOfBasis: 0.25,
  asymmetricMinPsa10Profit: 500,
  asymmetricMinPsa10GrossMultiple: 5,
};

export interface ClassificationResult {
  economicClass: EconomicClass;
  /** Every class this candidate satisfies, strongest first. */
  satisfiedClasses: EconomicClass[];
  /** Human-readable justification, shown on the dashboard row. */
  rationale: string;
  /** Why it failed to classify, when UNCLASSIFIED. */
  unclassifiedReasons: string[];
  /** The PSA9 profit bar actually applied (the max() of the two settings). */
  balancedPsa9ProfitThreshold: number;
  /** The PSA8 loss floor actually applied, as a negative currency amount. */
  balancedPsa8LossFloor: number;
}

export function classifyGradeEconomics(
  ladder: GradeLadderResult,
  settings: ClassificationSettings = DEFAULT_CLASSIFICATION_SETTINGS,
): ClassificationResult {
  const profitAt = (grade: PsaGrade): number | null =>
    ladder.rungs.find((r) => r.grade === grade)?.profit ?? null;

  const psa7 = profitAt(7);
  const psa8 = profitAt(8);
  const psa9 = profitAt(9);
  const psa10 = profitAt(10);

  const basis = ladder.totalGradedBasis;
  const psa9Threshold = round2(
    Math.max(settings.balancedMinPsa9Profit, basis * settings.balancedMinPsa9ProfitPctOfBasis),
  );
  const psa8LossFloor = round2(-Math.abs(basis * settings.balancedMaxPsa8LossPctOfBasis));

  const satisfied: EconomicClass[] = [];
  const reasons: string[] = [];

  // --- A. DOWNSIDE PROTECTED -------------------------------------------
  if (psa7 !== null && psa7 >= settings.downsideProtectedMinPsa7Profit) {
    satisfied.push("DOWNSIDE_PROTECTED");
  } else if (psa7 === null) {
    reasons.push("No PSA 7 market data — downside protection can't be established.");
  } else {
    reasons.push(
      `PSA 7 loses £${Math.abs(psa7).toFixed(2)} (needs >= £${settings.downsideProtectedMinPsa7Profit.toFixed(2)} for downside protection).`,
    );
  }

  // --- B. BALANCED ------------------------------------------------------
  if (psa8 !== null && psa9 !== null) {
    const psa8Ok = psa8 >= psa8LossFloor;
    const psa9Ok = psa9 >= psa9Threshold;
    if (psa8Ok && psa9Ok) {
      satisfied.push("BALANCED");
    } else {
      if (!psa8Ok) {
        reasons.push(
          `PSA 8 loss £${Math.abs(psa8).toFixed(2)} exceeds the balanced floor of £${Math.abs(psa8LossFloor).toFixed(2)} (${(settings.balancedMaxPsa8LossPctOfBasis * 100).toFixed(0)}% of basis).`,
        );
      }
      if (!psa9Ok) {
        reasons.push(`PSA 9 profit £${psa9.toFixed(2)} is below the balanced bar of £${psa9Threshold.toFixed(2)}.`);
      }
    }
  } else {
    reasons.push("Missing PSA 8 or PSA 9 market data — balanced structure can't be assessed.");
  }

  // --- C. ASYMMETRIC ----------------------------------------------------
  // Deliberately does NOT require PSA8 or PSA9 profitability.
  const grossMultiple = ladder.psa10GrossMultiple;
  if (psa10 !== null && grossMultiple !== null) {
    const profitOk = psa10 >= settings.asymmetricMinPsa10Profit;
    const multipleOk = grossMultiple >= settings.asymmetricMinPsa10GrossMultiple;
    if (profitOk && multipleOk) {
      satisfied.push("ASYMMETRIC");
    } else {
      if (!profitOk) {
        reasons.push(
          `PSA 10 profit £${psa10.toFixed(2)} is below the asymmetric bar of £${settings.asymmetricMinPsa10Profit.toFixed(2)}.`,
        );
      }
      if (!multipleOk) {
        reasons.push(
          `PSA 10 gross multiple ${grossMultiple.toFixed(2)}x is below the asymmetric bar of ${settings.asymmetricMinPsa10GrossMultiple}x.`,
        );
      }
    }
  } else {
    reasons.push("No PSA 10 market data — asymmetric upside can't be assessed.");
  }

  const economicClass = satisfied[0] ?? "UNCLASSIFIED";

  return {
    economicClass,
    satisfiedClasses: satisfied,
    rationale: buildRationale(economicClass, { psa7, psa8, psa9, psa10, grossMultiple, psa9Threshold }),
    unclassifiedReasons: economicClass === "UNCLASSIFIED" ? reasons : [],
    balancedPsa9ProfitThreshold: psa9Threshold,
    balancedPsa8LossFloor: psa8LossFloor,
  };
}

function buildRationale(
  economicClass: EconomicClass,
  data: {
    psa7: number | null;
    psa8: number | null;
    psa9: number | null;
    psa10: number | null;
    grossMultiple: number | null;
    psa9Threshold: number;
  },
): string {
  switch (economicClass) {
    case "DOWNSIDE_PROTECTED":
      return `PSA 7 already returns £${(data.psa7 ?? 0).toFixed(2)} — the floor is covered, and every grade above it is upside on a trade that doesn't lose.`;
    case "BALANCED":
      return `PSA 8 is near break-even (£${(data.psa8 ?? 0).toFixed(2)}) and PSA 9 returns £${(data.psa9 ?? 0).toFixed(2)}, clearing the £${data.psa9Threshold.toFixed(2)} bar — the realistic middle of the distribution pays.`;
    case "ASYMMETRIC":
      return `PSA 10 returns £${(data.psa10 ?? 0).toFixed(2)} at ${(data.grossMultiple ?? 0).toFixed(2)}x the graded basis. Lower grades lose money — check the required PSA 10 hit rate before acting.`;
    default:
      return "Does not meet any defined economic opportunity structure.";
  }
}
