import type { FeeSchedule, GradeLadderResult, GradeLadderRung, PsaGrade } from "./types.js";
import { DEFAULT_FEE_SCHEDULE, PSA_GRADES } from "./types.js";
import { computeNetSaleProceeds } from "./netSaleProceeds.js";
import { round2 } from "./acquisitionCost.js";

/**
 * For a given TOTAL GRADED BASIS, compute NET proceeds and PROFIT at each
 * PSA grade (6-10) using that grade's market price, and derive the
 * break-even grade (lowest grade, ascending, where profit >= 0).
 *
 * IMPORTANT: this only computes economics *conditional on* achieving each
 * grade. It says nothing about the *probability* of achieving any grade —
 * see packages/core/src/opportunity for how historical gem rate is
 * surfaced separately and explicitly NOT treated as that probability.
 */
export function computeGradeLadder(
  params: {
    totalGradedBasis: number;
    psaPrices: Partial<Record<PsaGrade, number | null>>;
    /** Selling costs applied when liquidating the slabbed card. */
    outboundPostage?: number;
    insurance?: number;
    packaging?: number;
  },
  feeSchedule: FeeSchedule = DEFAULT_FEE_SCHEDULE,
): GradeLadderResult {
  if (params.totalGradedBasis <= 0) {
    throw new Error("computeGradeLadder: totalGradedBasis must be > 0");
  }

  const rungs: GradeLadderRung[] = PSA_GRADES.map((grade) => {
    const marketPrice = params.psaPrices[grade] ?? null;

    if (marketPrice === null || marketPrice === undefined) {
      return { grade, marketPrice: null, netProceeds: null, profit: null };
    }

    const proceeds = computeNetSaleProceeds(
      {
        salePrice: marketPrice,
        outboundPostage: params.outboundPostage,
        insurance: params.insurance,
        packaging: params.packaging,
      },
      feeSchedule,
    );

    const profit = round2(proceeds.netProceeds - params.totalGradedBasis);

    return { grade, marketPrice, netProceeds: proceeds.netProceeds, profit };
  });

  const breakEvenGrade = findBreakEvenGrade(rungs);

  const psa10Rung = rungs.find((r) => r.grade === 10);
  const psa10UpsideMultiple =
    psa10Rung?.netProceeds != null ? round4(psa10Rung.netProceeds / params.totalGradedBasis) : null;

  return {
    totalGradedBasis: round2(params.totalGradedBasis),
    rungs,
    breakEvenGrade,
    psa10UpsideMultiple,
  };
}

/** Lowest grade (ascending) with profit >= 0; null if no populated grade breaks even. */
export function findBreakEvenGrade(rungs: GradeLadderRung[]): PsaGrade | null {
  const sorted = [...rungs].sort((a, b) => a.grade - b.grade);
  for (const rung of sorted) {
    if (rung.profit !== null && rung.profit >= 0) {
      return rung.grade;
    }
  }
  return null;
}

function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}
