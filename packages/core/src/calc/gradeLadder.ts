import type {
  ExitMarketFeeModel,
} from "./fees.js";
import { DEFAULT_EXIT_MARKET_FEE_MODEL, round2, round4 } from "./fees.js";
import type {
  GradeLadderResult,
  GradeLadderRung,
  GradingService,
  PsaGrade,
  SellingCostSettings,
} from "./types.js";
import { DEFAULT_SELLING_COSTS, PSA_GRADES } from "./types.js";
import { computeNetSaleProceeds } from "./netSaleProceeds.js";

/**
 * Economics at EVERY PSA grade for a given total graded basis — gross slab
 * value, selling fees, net proceeds, profit and ROC per rung.
 *
 * Losing rungs are computed and returned, never hidden: a card that loses
 * money at PSA 8 but returns 20x at PSA 10 is a legitimate asymmetric
 * opportunity, and suppressing the downside would make it impossible to
 * judge. Classification (see ../grading/classification.ts) decides what
 * KIND of opportunity this is; this function only does arithmetic.
 *
 * IMPORTANT: this computes economics CONDITIONAL ON achieving each grade.
 * It says nothing about the PROBABILITY of any grade, and nothing here may
 * be presented as an expected value — see ../grading/requiredHitRate.ts for
 * the honest alternative.
 */
export function computeGradeLadder(
  params: {
    totalGradedBasis: number;
    /** Gross slab market value at each grade, in GBP. */
    slabValues: Partial<Record<PsaGrade, number | null>>;
    service?: GradingService;
    /** GBP -> USD rate, for comparing slab values against USD declared-value caps. */
    usdPerGbp?: number;
    /** Sales behind each grade's price. Absent/null = not known, never zero. */
    saleCounts?: Partial<Record<PsaGrade, number | null>>;
    /** Grades priced from an average because the tier had no sold median. */
    estimatedGrades?: number[];
    buyerPaidShipping?: number;
    outboundPostage?: number;
    insurance?: number;
    packaging?: number;
  },
  feeModel: ExitMarketFeeModel = DEFAULT_EXIT_MARKET_FEE_MODEL,
  sellingCosts: SellingCostSettings = DEFAULT_SELLING_COSTS,
): GradeLadderResult {
  if (params.totalGradedBasis <= 0) {
    throw new Error("computeGradeLadder: totalGradedBasis must be > 0");
  }

  // Graded slabs ship heavier and usually insured — default to the graded
  // selling costs rather than the raw-card ones.
  const outboundPostage = params.outboundPostage ?? sellingCosts.outboundPostageGraded;
  const insurance = params.insurance ?? sellingCosts.saleInsuranceGraded;
  const packaging = params.packaging ?? sellingCosts.packaging;

  const capUsd = params.service?.declaredValueCapUsd ?? null;
  const usdPerGbp = params.usdPerGbp ?? null;

  const rungs: GradeLadderRung[] = PSA_GRADES.map((grade) => {
    const grossSlabValue = params.slabValues[grade] ?? null;

    const saleCount = params.saleCounts?.[grade] ?? null;
    const valueIsEstimated = params.estimatedGrades?.includes(grade) === true;

    if (grossSlabValue === null || grossSlabValue === undefined) {
      return {
        grade,
        grossSlabValue: null,
        sellingFees: null,
        netProceeds: null,
        profit: null,
        returnOnCapital: null,
        potentialUpcharge: false,
        saleCount: null,
        valueIsEstimated: false,
      };
    }

    const sale = computeNetSaleProceeds(
      {
        itemPrice: grossSlabValue,
        buyerPaidShipping: params.buyerPaidShipping,
        outboundPostage,
        insurance,
        packaging,
      },
      feeModel,
      sellingCosts,
    );

    const profit = round2(sale.netProceeds - params.totalGradedBasis);

    return {
      grade,
      grossSlabValue: round2(grossSlabValue),
      sellingFees: sale.fees.totalSellingFees,
      netProceeds: sale.netProceeds,
      profit,
      returnOnCapital: round4(profit / params.totalGradedBasis),
      potentialUpcharge: exceedsDeclaredValueCap(grossSlabValue, capUsd, usdPerGbp),
      saleCount,
      valueIsEstimated,
    };
  });

  const psa10 = rungs.find((r) => r.grade === 10) ?? null;
  const breakEven = findBreakEven(rungs);

  return {
    totalGradedBasis: round2(params.totalGradedBasis),
    rungs,
    breakEvenGrade: breakEven.grade,
    breakEvenUntestedBelow: breakEven.untestedBelow,
    psa10GrossMultiple:
      psa10?.grossSlabValue != null ? round4(psa10.grossSlabValue / params.totalGradedBasis) : null,
    psa10NetMultiple: psa10?.netProceeds != null ? round4(psa10.netProceeds / params.totalGradedBasis) : null,
    anyPotentialUpcharge: rungs.some((r) => r.potentialUpcharge),
  };
}

/**
 * TRUE when this grade's slab value would breach the selected service's
 * declared-value cap, meaning the submission may be bumped to a costlier
 * tier. Returns FALSE when we can't tell (no cap configured, or no FX rate
 * to compare a GBP value against a USD cap) rather than guessing — an
 * un-flagged upcharge is a known limitation, a fabricated one is a lie.
 */
export function exceedsDeclaredValueCap(
  slabValueGbp: number,
  capUsd: number | null,
  usdPerGbp: number | null,
): boolean {
  if (capUsd === null || usdPerGbp === null || usdPerGbp <= 0) return false;
  return slabValueGbp * usdPerGbp > capUsd;
}

/**
 * Lowest grade (ascending) with profit >= 0, AND which grades below it could
 * not be tested because they had no price.
 *
 * FIXED 2026-09-13. This used to return only the grade, having silently
 * skipped every unpriced rung on the way up. So "breaks even at PSA 7" meant
 * either "PSA 7 was checked and pays" or "PSA 6 has no data at all" — two
 * completely different facts, rendered identically, on the number the
 * operator's whole low-grade strategy rests on.
 *
 * The grade returned is unchanged. What is new is that the caller can now
 * tell whether it means anything.
 */
export function findBreakEven(rungs: GradeLadderRung[]): {
  grade: PsaGrade | null;
  untestedBelow: PsaGrade[];
} {
  const sorted = [...rungs].sort((a, b) => a.grade - b.grade);
  const untested: PsaGrade[] = [];
  for (const rung of sorted) {
    if (rung.profit === null) {
      untested.push(rung.grade);
      continue;
    }
    if (rung.profit >= 0) return { grade: rung.grade, untestedBelow: untested };
  }
  // Nothing breaks even. Untested rungs are not "below" anything, so they are
  // not reported here — the honest statement is simply "no grade breaks even
  // on the data we have".
  return { grade: null, untestedBelow: [] };
}

/** @deprecated Use findBreakEven, which also reports what it could not test. */
export function findBreakEvenGrade(rungs: GradeLadderRung[]): PsaGrade | null {
  return findBreakEven(rungs).grade;
}
