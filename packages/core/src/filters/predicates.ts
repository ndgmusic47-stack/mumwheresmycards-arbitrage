import { LIQUIDITY_ORDER } from "../calc/types.js";
import type { FilterableOpportunity, FilterEvaluation, FilterFailure, FilterSet } from "./types.js";

/**
 * Evaluate one opportunity against a full filter set. Returns not just a
 * boolean but every failing reason, so the dashboard can show *why* an
 * opportunity was filtered out (and so `REJECTED — MARGIN TOO LOW` /
 * `REJECTED — LIQUIDITY TOO LOW` states can be derived from the same logic
 * the UI filter bar uses — no duplicate rules to keep in sync).
 */
export function evaluateFilters(opp: FilterableOpportunity, filters: FilterSet): FilterEvaluation {
  const failures: FilterFailure[] = [];
  const { global, flip, grade } = filters;

  if (global.strategy !== "BOTH" && opp.strategy !== global.strategy) {
    failures.push({ filter: "strategy", reason: `strategy ${opp.strategy} excluded by filter ${global.strategy}` });
  }

  if (opp.netProfit < global.minNetProfit) {
    failures.push({ filter: "minNetProfit", reason: `netProfit ${opp.netProfit} < ${global.minNetProfit}` });
  }

  if (opp.returnOnCapital < global.minReturnOnCapital) {
    failures.push({
      filter: "minReturnOnCapital",
      reason: `ROC ${opp.returnOnCapital} < ${global.minReturnOnCapital}`,
    });
  }

  if (opp.profitMargin < global.minProfitMargin) {
    failures.push({
      filter: "minProfitMargin",
      reason: `margin ${opp.profitMargin} < ${global.minProfitMargin}`,
    });
  }

  if (opp.acquisitionPrice > global.maxAcquisitionPrice) {
    failures.push({
      filter: "maxAcquisitionPrice",
      reason: `acquisition ${opp.acquisitionPrice} > ${global.maxAcquisitionPrice}`,
    });
  }

  if (LIQUIDITY_ORDER[opp.liquidity] < LIQUIDITY_ORDER[global.minLiquidity]) {
    failures.push({
      filter: "minLiquidity",
      reason: `liquidity ${opp.liquidity} < ${global.minLiquidity}`,
    });
  }

  if (opp.confidence < global.minConfidence) {
    failures.push({ filter: "minConfidence", reason: `confidence ${opp.confidence} < ${global.minConfidence}` });
  }

  if (opp.strategy === "FLIP") {
    if ((opp.qsv ?? 0) < flip.minQsv) {
      failures.push({ filter: "minQsv", reason: `QSV ${opp.qsv ?? 0} < ${flip.minQsv}` });
    }
    if ((opp.daysToSaleEstimate ?? Infinity) > flip.maxDaysToSale) {
      failures.push({
        filter: "maxDaysToSale",
        reason: `daysToSale ${opp.daysToSaleEstimate ?? Infinity} > ${flip.maxDaysToSale}`,
      });
    }
  }

  if (opp.strategy === "GRADE") {
    if ((opp.psa10Value ?? 0) < grade.minPsa10Value) {
      failures.push({ filter: "minPsa10Value", reason: `PSA10 value ${opp.psa10Value ?? 0} < ${grade.minPsa10Value}` });
    }
    if ((opp.psa10UpsideMultiple ?? 0) < grade.minPsa10UpsideMultiple) {
      failures.push({
        filter: "minPsa10UpsideMultiple",
        reason: `PSA10 multiple ${opp.psa10UpsideMultiple ?? 0} < ${grade.minPsa10UpsideMultiple}`,
      });
    }
    if (opp.breakEvenGrade === null || opp.breakEvenGrade === undefined || opp.breakEvenGrade > grade.minAcceptableBreakEvenGrade) {
      failures.push({
        filter: "minAcceptableBreakEvenGrade",
        reason: `break-even grade ${opp.breakEvenGrade ?? "NONE"} worse than PSA ${grade.minAcceptableBreakEvenGrade}`,
      });
    }
    if (grade.safeZoneOnly && !isSafeZone(opp.breakEvenGrade ?? null)) {
      failures.push({ filter: "safeZoneOnly", reason: `break-even grade ${opp.breakEvenGrade ?? "NONE"} outside safe zone` });
    }
    if ((opp.gradedBasis ?? Infinity) > grade.maxGradedBasis) {
      failures.push({
        filter: "maxGradedBasis",
        reason: `graded basis ${opp.gradedBasis ?? Infinity} > ${grade.maxGradedBasis}`,
      });
    }
  }

  return { passes: failures.length === 0, failures };
}

/**
 * "Safe zone" = the card is profitable even at a conservative/low grade
 * (PSA 7 or better), i.e. you don't need a near-perfect grade to avoid a
 * loss. Threshold is a fixed PSA 7 cutoff for v1; can become a setting.
 */
export function isSafeZone(breakEvenGrade: number | null, safeZoneGradeCutoff = 7): boolean {
  return breakEvenGrade !== null && breakEvenGrade <= safeZoneGradeCutoff;
}
