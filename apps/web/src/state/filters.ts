/**
 * Dashboard filters — every commercial lever adjustable from the UI, with
 * no code change required. Mirrors the engine's qualification rules
 * (packages/core/src/filters) field for field, applied client-side against
 * the already-scored feed.
 *
 * Filtering here NEVER uses score. Score is a ranking signal only; the
 * economics decide what's an opportunity, and these filters narrow that set
 * by economics too.
 */

export type LiquidityLevel = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
export type EconomicClass = "DOWNSIDE_PROTECTED" | "BALANCED" | "ASYMMETRIC" | "UNCLASSIFIED";

export interface DashboardFilters {
  strategy: "ALL" | "FLIP" | "GRADE";
  /** Show only trades that cleared the economic bar. */
  qualifiedOnly: boolean;

  // ---- RAW FLIP ----
  minNetProfit: number;
  minReturnOnCapital: number; // fraction
  maxAcquisitionCost: number;
  minQsv: number;
  minLiquidity: LiquidityLevel;
  minConfidence: number; // fraction
  maxExpectedDaysToSale: number;

  // ---- GRADE ----
  economicClasses: EconomicClass[];
  maxRawAcquisitionCost: number;
  maxTotalGradedBasis: number;
  minPsa10Value: number;
  minPsa10Profit: number;
  minPsa10GrossMultiple: number;
  minPsa9Profit: number;
  /** Max acceptable PSA8 loss as a fraction of graded basis. 1 = no limit. */
  maxPsa8LossPctOfBasis: number;
  /** Worst acceptable break-even grade. null = don't require one. */
  maxBreakEvenGrade: number | null;
  /** Max acceptable REQUIRED PSA10 rate vs PSA9 fallback. 1 = no ceiling. */
  maxRequiredPsa10Rate: number;
  graderId: string | "ANY";
  gradingServiceId: string | "ANY";
  maxEstimatedCapitalLockDays: number;
}

export const DEFAULT_DASHBOARD_FILTERS: DashboardFilters = {
  strategy: "ALL",
  qualifiedOnly: true,

  minNetProfit: 40,
  minReturnOnCapital: 0.4,
  maxAcquisitionCost: 500,
  minQsv: 20,
  minLiquidity: "MEDIUM",
  minConfidence: 0.6,
  maxExpectedDaysToSale: 30,

  economicClasses: ["DOWNSIDE_PROTECTED", "BALANCED", "ASYMMETRIC"],
  maxRawAcquisitionCost: 1000,
  maxTotalGradedBasis: 1500,
  minPsa10Value: 80,
  minPsa10Profit: 0,
  minPsa10GrossMultiple: 0,
  minPsa9Profit: -Infinity,
  maxPsa8LossPctOfBasis: 1,
  maxBreakEvenGrade: null,
  maxRequiredPsa10Rate: 1,
  graderId: "ANY",
  gradingServiceId: "ANY",
  maxEstimatedCapitalLockDays: 400,
};

const LIQUIDITY_ORDER: Record<LiquidityLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  VERY_HIGH: 3,
};

export interface FilterableRow {
  strategy: "FLIP" | "GRADE";
  qualifies: number;
  liquidity: string;
  confidence: number;
  total_acquisition_cost: number;
  // FLIP
  qsv: number | null;
  expected_net_profit: number | null;
  return_on_capital: number | null;
  days_to_sale_estimate: number | null;
  // GRADE
  economic_class: string | null;
  total_graded_basis: number | null;
  psa10_value: number | null;
  psa8_profit: number | null;
  psa9_profit: number | null;
  psa10_profit: number | null;
  psa10_gross_multiple: number | null;
  break_even_grade: string | null;
  required_psa10_rate_vs_psa9: number | null;
  estimated_capital_lock_days: number | null;
  grader_id: string | null;
  grading_service_id: string | null;
}

export function applyDashboardFilters<T extends FilterableRow>(rows: T[], filters: DashboardFilters): T[] {
  return rows.filter((row) => {
    if (filters.strategy !== "ALL" && row.strategy !== filters.strategy) return false;
    if (filters.qualifiedOnly && row.qualifies !== 1) return false;

    if (LIQUIDITY_ORDER[row.liquidity as LiquidityLevel] < LIQUIDITY_ORDER[filters.minLiquidity]) return false;
    if (row.confidence < filters.minConfidence) return false;

    if (row.strategy === "FLIP") {
      if ((row.expected_net_profit ?? -Infinity) < filters.minNetProfit) return false;
      if ((row.return_on_capital ?? -Infinity) < filters.minReturnOnCapital) return false;
      if (row.total_acquisition_cost > filters.maxAcquisitionCost) return false;
      if ((row.qsv ?? 0) < filters.minQsv) return false;
      if ((row.days_to_sale_estimate ?? Infinity) > filters.maxExpectedDaysToSale) return false;
      return true;
    }

    // GRADE
    if (row.economic_class && !filters.economicClasses.includes(row.economic_class as EconomicClass)) return false;
    if (row.total_acquisition_cost > filters.maxRawAcquisitionCost) return false;
    if ((row.total_graded_basis ?? Infinity) > filters.maxTotalGradedBasis) return false;
    if ((row.psa10_value ?? 0) < filters.minPsa10Value) return false;
    if ((row.psa10_profit ?? -Infinity) < filters.minPsa10Profit) return false;
    if ((row.psa10_gross_multiple ?? 0) < filters.minPsa10GrossMultiple) return false;

    if (Number.isFinite(filters.minPsa9Profit) && (row.psa9_profit ?? -Infinity) < filters.minPsa9Profit) {
      return false;
    }

    if (filters.maxPsa8LossPctOfBasis < 1 && row.psa8_profit !== null && row.total_graded_basis) {
      const floor = -Math.abs(row.total_graded_basis * filters.maxPsa8LossPctOfBasis);
      if (row.psa8_profit < floor) return false;
    }

    if (filters.maxBreakEvenGrade !== null) {
      const grade = row.break_even_grade ? Number(row.break_even_grade) : null;
      if (grade === null || grade > filters.maxBreakEvenGrade) return false;
    }

    if (filters.maxRequiredPsa10Rate < 1) {
      const rate = row.required_psa10_rate_vs_psa9;
      if (rate === null || rate > filters.maxRequiredPsa10Rate) return false;
    }

    if ((row.estimated_capital_lock_days ?? Infinity) > filters.maxEstimatedCapitalLockDays) return false;
    if (filters.graderId !== "ANY" && row.grader_id !== filters.graderId) return false;
    if (filters.gradingServiceId !== "ANY" && row.grading_service_id !== filters.gradingServiceId) return false;

    return true;
  });
}
