/**
 * WHAT THE GRADE LADDER DOES NOT COVER.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CORRECTION THIS EXISTS FOR, from the operator on 2026-09-19:
 *
 *   "'Pays at PSA 5' remains conditional. It is a useful downside scenario,
 *    not a guaranteed floor. The purchase could return a lower grade or no
 *    numerical grade."
 *
 * He is right, and the second half is the part the tool had no answer to.
 * The ladder runs PSA 1 to 10 and looks exhaustive. It is not. A submission
 * can come back:
 *
 *   - with a QUALIFIER (OC, ST, MK, MC, PD) — a numeric grade, but a slab
 *     that sells for a fraction of the clean grade it sits beside;
 *   - as AUTHENTIC or AUTHENTIC-ALTERED — genuine, no numeric grade at all,
 *     typically worth near or below the raw card;
 *   - NOT ENCAPSULATED — evidence of trimming, recolouring or counterfeit.
 *     The card comes back raw and the grading spend is gone.
 *
 * None of those is a rung. Before this file they were not merely
 * unquantified, they were UNMENTIONED — the ladder said "worst case PSA 1"
 * and a reader had no way to know that was the worst case ON THE SCALE
 * rather than the worst case FULL STOP.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS DELIBERATELY DOES NOT ESTIMATE HOW OFTEN THEY HAPPEN.
 *
 * That would need PSA population data cross-referenced with submission
 * counts, and would still be a base rate for the population rather than for
 * a card someone is holding. Attaching a percentage to "might come back
 * altered" would create exactly the false precision this project exists to
 * avoid, and it would be the first probability the tool ever invented.
 *
 * It also does not predict which outcome arrives. The standing rule holds:
 * never predict a grade from a condition, and never let a rung be read as a
 * forecast.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT DOES DO. Two things, both honest.
 *
 * It names the outcomes the ladder omits, so nothing has to be inferred
 * from silence.
 *
 * And it computes the one figure that IS exactly computable: the grading
 * spend is unrecoverable the moment the card is submitted. If the card comes
 * back unencapsulated, that money is gone and what remains is a raw card —
 * one that failed for a reason, so worth at most its raw value and probably
 * less. The "at most" is the honest bound. Anything tighter would be a
 * guess about a card nobody has seen.
 */

export type NonNumericOutcome = "QUALIFIER" | "AUTHENTIC_ALTERED" | "NOT_ENCAPSULATED";

export interface NonNumericOutcomeNote {
  outcome: NonNumericOutcome;
  label: string;
  /** What it means for the money, in plain words. */
  detail: string;
  /** TRUE when this project holds no price data for the outcome at all. */
  unpriced: boolean;
}

export interface OutcomeCoverageInput {
  /** Everything spent by the time the slab comes back: card, postage, fee, batch share. */
  totalGradedBasis: number;
  /** What the card and its postage cost — the part that is not grading. */
  rawAcquisitionCost: number;
  /**
   * Conservative raw resale value (QSV), or null when there is none. Used
   * only as an UPPER bound on what a returned card might fetch, never as an
   * expectation.
   */
  rawResaleValue?: number | null;
}

export interface OutcomeCoverageAssessment {
  /**
   * The grading spend: basis minus what the card itself cost. Unrecoverable
   * from the moment of submission, whatever comes back.
   */
  sunkGradingCost: number;
  /**
   * The best case if the card is returned unencapsulated: the grading spend
   * is gone and the raw card is sold on for at most its raw value. Null when
   * no raw value is known — an unknown bound is not a bound.
   */
  bestCaseIfNotEncapsulated: number | null;
  /** The outcomes the PSA 1-10 ladder does not represent. */
  notes: NonNumericOutcomeNote[];
  /** One line for the row, stating what the ladder covers and what it does not. */
  summary: string;
}

const NOTES: NonNumericOutcomeNote[] = [
  {
    outcome: "QUALIFIER",
    label: "Graded with a qualifier (OC, ST, MK, MC, PD)",
    detail:
      "A numeric grade with a defect called out on the label. It sits on the same rung on paper and sells for a fraction of the clean grade beside it. No qualified-slab prices are held anywhere in this tool, so every figure on the ladder assumes a clean grade.",
    unpriced: true,
  },
  {
    outcome: "AUTHENTIC_ALTERED",
    label: "Authentic, or Authentic-Altered",
    detail:
      "Genuine card, no numeric grade. Typically worth near or below the raw card, and nowhere near any rung. Not priced here.",
    unpriced: true,
  },
  {
    outcome: "NOT_ENCAPSULATED",
    label: "Returned unencapsulated",
    detail:
      "Evidence of trimming, recolouring or counterfeit. The card comes back raw, the grading spend is gone, and what is left failed for a reason — so it is worth at most the raw value and probably less.",
    unpriced: false,
  },
];

export function assessGradeOutcomeCoverage(input: OutcomeCoverageInput): OutcomeCoverageAssessment {
  const { totalGradedBasis, rawAcquisitionCost } = input;

  // Never negative: a basis below the card's own cost is a malformed input,
  // and a negative "sunk cost" would read as money recovered by grading.
  const sunkGradingCost = Math.max(0, round2(totalGradedBasis - rawAcquisitionCost));

  const raw = input.rawResaleValue;
  const usableRaw = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : null;

  // Best case, not expected case. Selling the returned card would carry its
  // own fees and postage on top; those are not deducted here because this is
  // deliberately the optimistic bound, and a reader should know the real
  // number is worse rather than be handed a precise-looking one.
  const bestCaseIfNotEncapsulated = usableRaw === null ? null : round2(usableRaw - totalGradedBasis);

  return {
    sunkGradingCost,
    bestCaseIfNotEncapsulated,
    notes: NOTES.map((note) => ({ ...note })),
    summary:
      `The grades above cover PSA 1 to 10 on a CLEAN grade only. A submission can also come back with a ` +
      `qualifier, as Authentic-Altered, or not encapsulated at all — none of which is a rung here, and none of ` +
      `which this tool can price. £${sunkGradingCost.toFixed(2)} of grading cost is unrecoverable whatever ` +
      `happens` +
      (bestCaseIfNotEncapsulated === null
        ? "."
        : `, and a card returned unencapsulated leaves you down £${Math.abs(bestCaseIfNotEncapsulated).toFixed(2)} at best.`) +
      ` How often any of this happens is not estimated, because estimating it would be inventing a number.`,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
