export interface DashboardFilters {
  strategy: "ALL" | "FLIP" | "GRADE";
  minNetProfit: number;
  minReturnOnCapital: number; // fraction
  minProfitMargin: number; // fraction
  maxAcquisitionPrice: number;
  minLiquidity: "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
  minConfidence: number; // fraction
  minQsv: number;
  maxDaysToSale: number;
  minPsa10Value: number;
  minPsa10UpsideMultiple: number;
  safeZoneOnly: boolean;
}

export const DEFAULT_DASHBOARD_FILTERS: DashboardFilters = {
  strategy: "ALL",
  minNetProfit: 50,
  minReturnOnCapital: 0.35,
  minProfitMargin: 0.15,
  maxAcquisitionPrice: 500,
  minLiquidity: "MEDIUM",
  minConfidence: 0.6,
  minQsv: 20,
  maxDaysToSale: 30,
  minPsa10Value: 80,
  minPsa10UpsideMultiple: 2.0,
  safeZoneOnly: false,
};

const LIQUIDITY_ORDER: Record<DashboardFilters["minLiquidity"], number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  VERY_HIGH: 3,
};

/**
 * Client-side filtering against the already-scored opportunity feed. Kept
 * intentionally parallel in spirit to packages/core/src/filters/predicates
 * (same fields, same semantics) — a future iteration can push this
 * server-side using the exact same FilterSet shape without changing this
 * component's contract.
 */
export function applyDashboardFilters<
  T extends {
    strategy: "FLIP" | "GRADE";
    expected_net_profit: number | null;
    return_on_capital: number | null;
    profit_margin: number | null;
    total_acquisition_cost: number;
    liquidity: string;
    confidence: number;
    qsv: number | null;
    total_graded_basis: number | null;
    psa10_profit: number | null;
    break_even_grade: string | null;
  },
>(opportunities: T[], filters: DashboardFilters): T[] {
  return opportunities.filter((o) => {
    if (filters.strategy !== "ALL" && o.strategy !== filters.strategy) return false;
    if ((o.expected_net_profit ?? o.psa10_profit ?? -Infinity) < filters.minNetProfit) return false;
    if ((o.return_on_capital ?? -Infinity) < filters.minReturnOnCapital) return false;
    if ((o.profit_margin ?? -Infinity) < filters.minProfitMargin) return false;
    if (o.total_acquisition_cost > filters.maxAcquisitionPrice) return false;
    if (LIQUIDITY_ORDER[o.liquidity as DashboardFilters["minLiquidity"]] < LIQUIDITY_ORDER[filters.minLiquidity]) return false;
    if (o.confidence < filters.minConfidence) return false;

    if (o.strategy === "FLIP" && (o.qsv ?? 0) < filters.minQsv) return false;

    if (o.strategy === "GRADE" && filters.safeZoneOnly) {
      const grade = o.break_even_grade ? Number(o.break_even_grade) : null;
      if (grade === null || grade > 7) return false;
    }

    return true;
  });
}
