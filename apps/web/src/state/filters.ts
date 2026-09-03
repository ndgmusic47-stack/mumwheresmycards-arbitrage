/**
 * Dashboard filters — every commercial lever adjustable from the UI, with
 * no code change required. Mirrors the engine's qualification rules
 * (packages/core/src/filters) field for field.
 *
 * SOURCING WORKFLOW item 6: the highest-value fields (delivered cost, QSV,
 * net profit, ROC, confidence, liquidity, auctions-only) are now sent to
 * the server (see buildServerFilterParams below) so the browser only ever
 * fetches one page of ALREADY-narrowed rows (item 19: no full-table client
 * loads). applyDashboardFilters still runs client-side on top of whatever
 * page comes back — it's a no-op for the fields already sent server-side,
 * and does real work for the long tail of GRADE-specific fields that aren't
 * (economic class, PSA-multiple thresholds, grader/service pickers, etc.),
 * which stay client-side over the current ~75-row page rather than growing
 * the server's WHERE clause for filters used far less often.
 *
 * Filtering here NEVER uses score. Score is a ranking signal only; the
 * economics decide what's an opportunity, and these filters narrow that set
 * by economics too.
 */
import type { OpportunityQueryParams } from "../api/client";

export type LiquidityLevel = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
export type EconomicClass = "DOWNSIDE_PROTECTED" | "BALANCED" | "ASYMMETRIC" | "UNCLASSIFIED";

/**
 * The dashboard's top-level bucket. Each maps to a real `state` list sent to
 * the server (see CATEGORY_STATES), so `total`/`remaining` on the dashboard
 * describe the same rows the table shows — no client-side-only filtering
 * pretending to be a server-side count. ALL sends no state filter at all.
 */
export type OpportunityCategory = "ALL" | "ACTIONABLE" | "REVIEW" | "NEAR_MISS" | "REJECTED";

/**
 * ACTIONABLE and REVIEW both always carry qualifies=1 (every REVIEW state is
 * a downgrade path off an otherwise-qualifying trade — see engine.ts) but
 * are kept separate here because a REVIEW row needs a human to confirm
 * something first: INSPECT_PHOTOS (identity), REVIEW_ALREADY_GRADED (eBay
 * says this is a graded slab, not raw), REVIEW_LIKELY_LOT (title reads as a
 * multi-card lot/bundle), or REVIEW_CONDITION_DEPENDENT (only clears the bar
 * against the near-mint reference price). REJECTED covers every rejection
 * reason distinctly, since "no market data" and "identity uncertain" call
 * for different follow-up.
 */
/**
 * MWMC V1 FINAL SHIP PASS item 2: REVIEW used to only include INSPECT_PHOTOS
 * (an identity/photo check), but packages/core/src/opportunity/states.ts has
 * three more human-review states — REVIEW_ALREADY_GRADED, REVIEW_LIKELY_LOT,
 * REVIEW_CONDITION_DEPENDENT — that the engine has computed and stored since
 * the AI INTELLIGENCE pass (see listingStructure.ts/engine.ts), deliberately
 * excluded from QUALIFIED_STATES for the same "needs a human first" reason
 * as INSPECT_PHOTOS. They were never wired into this category, so those rows
 * were silently unreachable from the dashboard even though they were being
 * computed and stored correctly the whole time — audited and confirmed
 * real, not a placeholder, before adding them here.
 */
export const CATEGORY_STATES: Record<OpportunityCategory, string[] | null> = {
  ALL: null,
  ACTIONABLE: ["QUALIFIED_FLIP", "QUALIFIED_GRADE"],
  REVIEW: ["INSPECT_PHOTOS", "REVIEW_ALREADY_GRADED", "REVIEW_LIKELY_LOT", "REVIEW_CONDITION_DEPENDENT"],
  NEAR_MISS: ["WATCH"],
  REJECTED: ["NO_MARKET_DATA", "REJECTED_CARD_IDENTITY_UNCERTAIN", "REJECTED_COMPUTATION_ERROR"],
};

export interface DashboardFilters {
  strategy: "ALL" | "FLIP" | "GRADE";
  /** Which state bucket the dashboard is showing — drives the server-side
   *  `state` filter (see CATEGORY_STATES), so counts/paging stay honest. */
  category: OpportunityCategory;
  /** Cross-cutting tag (listing_type === 'AUCTION'), not a state — stays a
   *  client-side filter over whatever the category already loaded. */
  auctionsOnly: boolean;
  /** SOURCING WORKFLOW item 17: the user's own manual sourcing decision —
   *  a cross-cutting tag on top of the category, same pattern as
   *  auctionsOnly, and applied regardless of category (unlike the granular
   *  economics thresholds below, this is a plain equality check with no
   *  "does it apply to this row" ambiguity). "ALL" is the default: reviewing
   *  status is opt-in, never silently hiding rows nobody has looked at yet. */
  reviewStatus: "ALL" | "UNREVIEWED" | "CHECKED" | "INTERESTED" | "PASS" | "BOUGHT";
  /** MWMC V1 FINAL SHIP PASS item 2: on the ACTIONABLE tab, a QUALIFIED_FLIP/
   *  QUALIFIED_GRADE row that AI routed to REVIEW or BLOCK_FROM_ACTIONABLE is
   *  hidden by default (routes/opportunities.ts's includeAiFlagged gate) —
   *  correct for the default sourcing feed, but it must stay INSPECTABLE
   *  somewhere rather than simply disappearing with no trace. Checking this
   *  sends includeAiFlagged=1, bringing those rows back into the SAME table
   *  (each rendering an AI-flag badge — see OpportunityTable.tsx's
   *  AiFlagTag) rather than routing them to a separate view. A no-op outside
   *  ACTIONABLE, same as the server's own gate (isActionableStateFilter). */
  showAiFlagged: boolean;

  // ---- RAW FLIP ----
  minNetProfit: number;
  minReturnOnCapital: number; // fraction
  /** AI INTELLIGENCE gap 4: minimum profit_margin (net profit / buyer
   *  payment), as a fraction. FLIP only — GRADE rows have no single
   *  "margin" figure (a per-grade profit ladder instead), same reasoning as
   *  minNetProfit/minReturnOnCapital already being FLIP-only levers. 0 =
   *  no minimum (the default, so adding this field changes no existing
   *  filtered view until a user or NL query actually raises it). */
  minMargin: number;
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
  category: "ACTIONABLE",
  auctionsOnly: false,
  reviewStatus: "ALL",
  showAiFlagged: false,

  minNetProfit: 40,
  minReturnOnCapital: 0.4,
  minMargin: 0,
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
  listing_type: string;
  review_status: string;
  liquidity: string;
  confidence: number;
  total_acquisition_cost: number;
  // FLIP
  qsv: number | null;
  expected_net_profit: number | null;
  return_on_capital: number | null;
  profit_margin: number | null;
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

/**
 * Categories whose rows carry real, comparable economics. ACTIONABLE and
 * REVIEW always qualify (qualifies=1); NEAR_MISS (WATCH) rows have full
 * computed economics too, just below the qualifying bar, so narrowing them
 * further (e.g. "show me the closest near-misses") is legitimate. REJECTED
 * rows and the mixed ALL bucket do not get the granular economics pass —
 * applying a minQsv/minNetProfit threshold to a NO_MARKET_DATA or
 * REJECTED_COMPUTATION_ERROR row (null economics) would silently re-hide
 * exactly the rows those views exist to surface.
 */
const CATEGORIES_WITH_ECONOMICS_FILTERING: OpportunityCategory[] = ["ACTIONABLE", "REVIEW", "NEAR_MISS"];

export function applyDashboardFilters<T extends FilterableRow>(rows: T[], filters: DashboardFilters): T[] {
  const applyEconomics = CATEGORIES_WITH_ECONOMICS_FILTERING.includes(filters.category);

  return rows.filter((row) => {
    if (filters.strategy !== "ALL" && row.strategy !== filters.strategy) return false;
    if (filters.auctionsOnly && row.listing_type !== "AUCTION") return false;
    if (filters.reviewStatus !== "ALL" && row.review_status !== filters.reviewStatus) return false;

    if (!applyEconomics) return true;

    if (LIQUIDITY_ORDER[row.liquidity as LiquidityLevel] < LIQUIDITY_ORDER[filters.minLiquidity]) return false;
    if (row.confidence < filters.minConfidence) return false;

    if (row.strategy === "FLIP") {
      if ((row.expected_net_profit ?? -Infinity) < filters.minNetProfit) return false;
      if ((row.return_on_capital ?? -Infinity) < filters.minReturnOnCapital) return false;
      if ((row.profit_margin ?? -Infinity) < filters.minMargin) return false;
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

/**
 * SOURCING WORKFLOW item 6: translate the subset of DashboardFilters that
 * has a real server-side column into GET /api/opportunities query params.
 *
 * Two fields (expected_net_profit, return_on_capital) are FLIP-only on the
 * opportunities table — NULL on every GRADE row — so sending minNetProfit
 * or minRoc while `strategy === "ALL"` would silently filter out every
 * grading candidate. Same reasoning for maxAcquisitionCost/
 * maxRawAcquisitionCost, which are the SAME underlying column
 * (total_acquisition_cost) but different UI fields depending on strategy,
 * and for capital-lock, which only exists on GRADE rows. Each of these is
 * only sent when the current strategy makes it unambiguous; the mixed "ALL"
 * view falls back to applyDashboardFilters doing that part client-side, same
 * as before this item existed — never silently wrong, just less
 * pre-filtered on the wire for that one view.
 */
export function buildServerFilterParams(filters: DashboardFilters): Partial<OpportunityQueryParams> {
  const params: Partial<OpportunityQueryParams> = {};
  if (filters.auctionsOnly) params.listingType = "AUCTION";
  // A no-op server-side outside ACTIONABLE (isActionableStateFilter only
  // ever matches state=QUALIFIED_FLIP,QUALIFIED_GRADE), so it's always safe
  // to send regardless of category — see DashboardFilters.showAiFlagged.
  if (filters.showAiFlagged) params.includeAiFlagged = true;

  if (!CATEGORIES_WITH_ECONOMICS_FILTERING.includes(filters.category)) {
    return params;
  }

  // Safe regardless of strategy — every opportunity row has these two.
  params.minConfidence = filters.minConfidence;
  const minOrder = LIQUIDITY_ORDER[filters.minLiquidity];
  params.liquidity = (Object.keys(LIQUIDITY_ORDER) as LiquidityLevel[])
    .filter((l) => LIQUIDITY_ORDER[l] >= minOrder)
    .join(",");

  if (filters.strategy === "FLIP") {
    params.minNetProfit = filters.minNetProfit;
    params.minRoc = filters.minReturnOnCapital;
    params.minMargin = filters.minMargin;
    params.maxDeliveredCost = filters.maxAcquisitionCost;
    params.minQsv = filters.minQsv;
  } else if (filters.strategy === "GRADE") {
    params.maxDeliveredCost = filters.maxRawAcquisitionCost;
    params.maxCapitalLock = filters.maxEstimatedCapitalLockDays;
  }

  return params;
}
