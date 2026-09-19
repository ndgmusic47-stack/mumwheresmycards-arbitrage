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
import { FEED_HIDDEN_REVIEW_STATUSES } from "./pipelineStages";

export type LiquidityLevel = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
export type EconomicClass = "DOWNSIDE_PROTECTED" | "BALANCED" | "ASYMMETRIC" | "UNCLASSIFIED";

/**
 * The dashboard's top-level bucket. Each maps to a real `state` list sent to
 * the server (see CATEGORY_STATES), so `total`/`remaining` on the dashboard
 * describe the same rows the table shows — no client-side-only filtering
 * pretending to be a server-side count. ALL sends no state filter at all.
 */
export type OpportunityCategory = "ALL" | "ACTIONABLE" | "REVIEW" | "NEAR_MISS" | "REJECTED" | "PASSED";

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
  /*
   * PASSED — added 2026-09-18, and it exists because of a hole I made.
   *
   * On the 13th the "My decision" dropdown was removed as redundant with the
   * Pipeline board. On the 14th every acted-on status was hidden from the
   * working feed, correctly, so a card under offer stopped reappearing.
   * Together those two changes made a Pass PERMANENT AND INVISIBLE: no view
   * anywhere listed a passed card, and nothing could undo one.
   *
   * What that did, measured on the live database: of the 141 listings under
   * £30 that break even at a PSA 6 — exactly the trade the operator was
   * hunting — 138 were passed and 3 were unreviewed. The feed read "no
   * opportunities match the current filters" while holding 141 matches.
   *
   * Worse, the earliest of those passes is dated 10 September, three days
   * before the slab-pricing fixes. A large share were dismissed against PSA
   * 10 values inflated by up to four times and PSA 9s about 30% high. Those
   * were not bad decisions; they were decisions taken on bad numbers, and
   * there was no way back to them.
   *
   * No state filter: a pass is a decision about a LISTING, and it can sit on
   * a row in any state. The reviewStatus filter does the work — see
   * buildServerFilterParams.
   */
  PASSED: null,
  ACTIONABLE: ["QUALIFIED_FLIP", "QUALIFIED_GRADE"],
  REVIEW: [
    "INSPECT_PHOTOS",
    "REVIEW_ALREADY_GRADED",
    "REVIEW_LIKELY_LOT",
    "REVIEW_CONDITION_DEPENDENT",
    // 2026-09-13: the asking price is so far below what the card is worth
    // raw that the LISTING is what needs checking, not the trade. See
    // pricePlausibility.ts in @mwmc/core. Auctions whose current bid has not
    // yet reached a believable level land here too, and leave on their own
    // once the bidding is real.
    "REVIEW_PRICE_IMPLAUSIBLE",
    /*
     * 2026-09-18: our own slab prices for the card contradict themselves —
     * a ladder running backwards, or a PSA 10 at an impossible multiple of
     * its own PSA 9. Distinct from REVIEW_PRICE_IMPLAUSIBLE: that one doubts
     * the listing, this one doubts the data we valued it with.
     *
     * It is wired in here in the same breath as the state was added, because
     * the last four review states spent weeks being computed, stored and
     * unreachable from this dashboard for want of exactly this line. On the
     * live feed the day it shipped this covers roughly half of what used to
     * sit in ACTIONABLE, so leaving it out would not have been a small gap.
     */
    "REVIEW_SLAB_DATA_IMPLAUSIBLE",
  ],
  NEAR_MISS: ["WATCH"],
  REJECTED: ["NO_MARKET_DATA", "REJECTED_CARD_IDENTITY_UNCERTAIN", "REJECTED_COMPUTATION_ERROR"],
};

export interface DashboardFilters {
  /**
   * WHICH GAMES TO SHOW — added 2026-09-19 with the multi-game build.
   *
   * An empty array means ALL games, deliberately, rather than a list of
   * every known game. The tool can represent six games and has cards for
   * one or two of them; a filter that enumerated all six would show four
   * checkboxes that select nothing, and an operator would reasonably read
   * that as the tool being broken rather than the game being empty. What
   * is offered comes from the games actually present in the feed.
   *
   * This is cross-cutting like sourceRegion: it describes the CARD, not the
   * trade, so it applies in every category and under every strategy.
   */
  games: string[];
  strategy: "ALL" | "FLIP" | "GRADE";
  /** Which state bucket the dashboard is showing — drives the server-side
   *  `state` filter (see CATEGORY_STATES), so counts/paging stay honest. */
  category: OpportunityCategory;
  /**
   * SUPERSEDED 2026-09-10 by `listingKind`, but kept because saved URLs,
   * bookmarks and natural-language queries carry it. When listingKind is
   * "ALL" and this is true, it still means AUCTION.
   */
  auctionsOnly: boolean;
  /** Which kinds of listing to show: all, buy-it-now only, or auctions only. */
  listingKind: "ALL" | "BIN" | "BEST_OFFER" | "AUCTION";
  /**
   * WHERE THE CARD SHIPS FROM — added 2026-09-13.
   *
   * An economics filter, not a convenience one. Import tax and acquisition
   * fees are £0 everywhere in this app, so a non-UK row understates its
   * delivered cost and overstates profit at every grade. On the live feed
   * that was 83% of listings. See sourceRegion.ts in @mwmc/core, including
   * why "UK & Europe" is NOT the same as "no import cost".
   */
  sourceRegion: "ANY" | "UK_ONLY" | "UK_EU";
  /**
   * eBay's own Graded/Ungraded flag, semantically rather than by literal
   * string — the server expands each into every language eBay writes it in.
   * "ANY" sends nothing. "UNGRADED" is what this tool is normally shopping
   * for; "GRADED" exists because looking at slabs deliberately is a
   * legitimate thing to want, and it is the only way to inspect what the
   * already-graded classifier has been catching.
   */
  ebayCondition: "ANY" | "UNGRADED" | "GRADED";

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
  maxExpectedDaysToSale: number;

  // ---- GRADE ----
  maxRawAcquisitionCost: number;
  maxTotalGradedBasis: number;
  minPsa10Value: number;
  minPsa10Profit: number;
  /** Worst acceptable break-even grade. null = don't require one. */
  maxBreakEvenGrade: number | null;
  /** Max acceptable REQUIRED PSA10 rate vs PSA9 fallback. 1 = no ceiling. */
  maxRequiredPsa10Rate: number;
  /**
   * THE GRADE THE OPERATOR IS ACTUALLY BETTING ON, and what it has to pay.
   * Added 2026-09-13 — this is where the low-grade strategy lives. Before
   * these, three of the grade filters were about PSA 10 and neither PSA 6
   * nor PSA 7 could be expressed at all.
   */
  buyGrade: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  /** Min profit at `buyGrade`. -Infinity = off. */
  minBuyGradeProfit: number;
  graderId: string | "ANY";
  gradingServiceId: string | "ANY";
  maxEstimatedCapitalLockDays: number;
}

export const DEFAULT_DASHBOARD_FILTERS: DashboardFilters = {
  // Empty = every game. See the field's doc comment for why this is not a
  // list of all known games.
  games: [],
  strategy: "ALL",
  category: "ACTIONABLE",
  auctionsOnly: false,
  listingKind: "ALL",
  sourceRegion: "ANY",
  ebayCondition: "ANY",

  minNetProfit: 40,
  minReturnOnCapital: 0.4,
  minMargin: 0,
  maxAcquisitionCost: 500,
  minQsv: 20,
  minLiquidity: "MEDIUM",
  maxExpectedDaysToSale: 30,

  maxRawAcquisitionCost: 1000,
  /*
   * No cap — 2026-09-19, "remove it, I don't need it". Infinity rather than
   * a big number so the two places that read it both do the right thing
   * without a special case: the row filter compares against it directly,
   * and buildServerFilterParams already omits a non-finite value from the
   * request instead of sending it.
   */
  maxTotalGradedBasis: Number.POSITIVE_INFINITY,
  minPsa10Value: 80,
  minPsa10Profit: 0,
  maxBreakEvenGrade: null,
  maxRequiredPsa10Rate: 1,
  buyGrade: 7,
  minBuyGradeProfit: -Infinity,
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
  /** Low-grade profits — the ones the buy-grade floor is read against.
   *  PSA 1-5 added 2026-09-19 with migration 0029; null there means no
   *  recorded sales at that grade, never a worthless card. */
  psa1_profit: number | null;
  psa2_profit: number | null;
  psa3_profit: number | null;
  psa4_profit: number | null;
  psa5_profit: number | null;
  psa6_profit: number | null;
  psa7_profit: number | null;
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
// PASSED gets the economics filters too: the point of the view is "show me
// the passed cards that match what I am hunting NOW", not all of them ever.
const CATEGORIES_WITH_ECONOMICS_FILTERING: OpportunityCategory[] = ["ACTIONABLE", "REVIEW", "NEAR_MISS", "PASSED"];

export function applyDashboardFilters<T extends FilterableRow>(rows: T[], filters: DashboardFilters): T[] {
  const applyEconomics = CATEGORIES_WITH_ECONOMICS_FILTERING.includes(filters.category);

  return rows.filter((row) => {
    if (filters.strategy !== "ALL" && row.strategy !== filters.strategy) return false;
    if (!listingKindAllows(filters, row.listing_type)) return false;

    if (!applyEconomics) return true;

    if (LIQUIDITY_ORDER[row.liquidity as LiquidityLevel] < LIQUIDITY_ORDER[filters.minLiquidity]) return false;

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
    if (row.total_acquisition_cost > filters.maxRawAcquisitionCost) return false;
    if ((row.total_graded_basis ?? Infinity) > filters.maxTotalGradedBasis) return false;
    if ((row.psa10_value ?? 0) < filters.minPsa10Value) return false;
    if ((row.psa10_profit ?? -Infinity) < filters.minPsa10Profit) return false;
    // The buy-grade floor, client side. `psa{n}_profit` columns already
    // exist for 6..10 on the row.
    if (Number.isFinite(filters.minBuyGradeProfit)) {
      const profit = buyGradeProfit(row, filters.buyGrade);
      if ((profit ?? -Infinity) < filters.minBuyGradeProfit) return false;
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
/** The `l.listing_type IN (...)` set for the current selection, or undefined
 *  for "everything" (in which case no clause is sent at all). */
export function listingTypesFor(filters: DashboardFilters): string | undefined {
  switch (filters.listingKind) {
    case "BIN":
      // "Buy It Now" as a person means it: purchasable without bidding.
      return "FIXED,BEST_OFFER";
    case "BEST_OFFER":
      return "BEST_OFFER";
    case "AUCTION":
      return "AUCTION";
    case "ALL":
    default:
      return filters.auctionsOnly ? "AUCTION" : undefined;
  }
}

/** Client-side mirror of listingTypesFor, so the rows on screen and the rows
 *  the server returned can never disagree about what was asked for. */
export function listingKindAllows(filters: DashboardFilters, listingType: string | null | undefined): boolean {
  const allowed = listingTypesFor(filters);
  if (!allowed) return true;
  return allowed.split(",").includes(String(listingType));
}

export function buildServerFilterParams(filters: DashboardFilters): Partial<OpportunityQueryParams> {
  const params: Partial<OpportunityQueryParams> = {};
  // listingKind wins; auctionsOnly is only consulted when it is untouched,
  // so an old bookmark keeps behaving exactly as it did.
  const listingTypes = listingTypesFor(filters);
  if (listingTypes) params.listingType = listingTypes;
  // 2026-09-09: only live listings reach the working feed. An auction whose
  // end time has passed, or a fixed-price listing that stopped coming back in
  // a complete search (i.e. sold), is no longer something to review — and
  // finding that out by clicking through to a dead eBay page is the worst
  // possible way to learn it. Not a user-facing toggle: "just remove" was the
  // instruction. Saved leads are exempt — Pipeline queries without this.
  params.listingStatus = "ACTIVE";
  /*
   * Anything already dealt with leaves the working feed.
   *
   * This said "PASS" and nothing else until 2026-09-14, when a card moved to
   * UNDER OFFER was seen coming back as a fresh candidate. The feed's job is
   * "things I have not acted on"; a lead you are mid-negotiation on, or have
   * already bought, reappearing as an option invites acting on it twice.
   *
   * The list is shared with the Pipeline board rather than written out again
   * here — see pipelineStages.ts for why the duplication was the bug.
   */
  if (filters.category === "PASSED") {
    // The one view that shows them ON PURPOSE. Hiding and showing the same
    // rows in one request would return nothing, which is precisely the
    // silent-empty-feed failure this view exists to end.
    params.reviewStatus = "PASS";
  } else {
    params.excludeReviewStatus = FEED_HIDDEN_REVIEW_STATUSES.join(",");
  }

  // Both cross-cutting: they describe the LISTING, not the trade, so unlike
  // the economics thresholds below they apply in every category and under
  // every strategy. Only sent when they would actually narrow something.
  if (filters.sourceRegion !== "ANY") params.region = filters.sourceRegion;
  if (filters.ebayCondition !== "ANY") params.condition = filters.ebayCondition;
  // Sent only when it would narrow something — an empty selection means
  // every game and must not become `game=` on the query string, which the
  // server would read as a filter matching nothing.
  if (filters.games.length > 0) params.game = filters.games.join(",");

  if (!CATEGORIES_WITH_ECONOMICS_FILTERING.includes(filters.category)) {
    return params;
  }

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

    // 2026-09-08: the rest of the GRADE levers, now real server-side filters
    // rather than a client-side pass over the ~75 rows already on screen.
    // Against 12,362 grade candidates that pass narrowed less than 1% of the
    // set, so tightening a threshold appeared to do nothing.
    //
    // Each is sent ONLY when it would actually narrow anything — an
    // untouched control must not put a clause on the wire, or the "no
    // minimum" defaults (0, 1, ±Infinity, null) would start excluding rows
    // whose column is simply NULL.
    if (Number.isFinite(filters.minBuyGradeProfit)) {
      params.buyGrade = filters.buyGrade;
      params.minBuyGradeProfit = filters.minBuyGradeProfit;
    }
    if (Number.isFinite(filters.maxTotalGradedBasis)) params.maxTotalGradedBasis = filters.maxTotalGradedBasis;
    if (filters.minPsa10Value > 0) params.minPsa10Value = filters.minPsa10Value;
    if (Number.isFinite(filters.minPsa10Profit) && filters.minPsa10Profit !== 0) {
      params.minPsa10Profit = filters.minPsa10Profit;
    }
    // NOTE (2026-09-13 redundancy cull): `maxBreakEvenGrade` and
    // `minPsa10Profit` no longer have controls — the "must make at least £X
    // at PSA Y" rule says both, and more. See FilterBar.tsx for the working
    // out. The FIELDS and their clauses stay, because a bookmarked URL may
    // carry either, and removing a widget must never silently change what an
    // existing link returns.
    if (filters.maxBreakEvenGrade !== null) params.maxBreakEvenGrade = filters.maxBreakEvenGrade;
    // NOTE (2026-09-09 filter audit): `maxRequiredPsa10Rate`, `graderId` and
    // `maxEstimatedCapitalLockDays` are no longer surfaced as controls — see
    // FilterBar.tsx for why each was removed. The FIELDS stay on
    // DashboardFilters (a saved URL or a natural-language query may still
    // carry one), and are still honoured here if present, so removing the
    // widget never silently changes what an existing link returns.
    if (filters.maxRequiredPsa10Rate < 1) params.maxRequiredPsa10Rate = filters.maxRequiredPsa10Rate;
    if (filters.graderId !== "ANY") params.graderId = filters.graderId;
    if (filters.gradingServiceId !== "ANY") params.gradingServiceId = filters.gradingServiceId;
  }

  return params;
}

/**
 * Profit at the grade the operator is buying on.
 *
 * The row carries a psa{n}_profit column for every grade; this just picks the
 * one that matches, rather than the tool assuming — as it did until
 * 2026-09-13 — that the grade anybody cares about is the 10.
 *
 * Widened to PSA 1-5 on 2026-09-19 (migration 0029). A row with no sales at
 * the chosen grade has NULL there, and null never clears the floor — so
 * asking for PSA 3 returns cards genuinely evidenced at PSA 3 rather than
 * every card with a blank read as zero.
 */
export function buyGradeProfit(row: FilterableRow, grade: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10): number | null {
  switch (grade) {
    case 1:
      return row.psa1_profit ?? null;
    case 2:
      return row.psa2_profit ?? null;
    case 3:
      return row.psa3_profit ?? null;
    case 4:
      return row.psa4_profit ?? null;
    case 5:
      return row.psa5_profit ?? null;
    case 6:
      return row.psa6_profit ?? null;
    case 7:
      return row.psa7_profit ?? null;
    case 8:
      return row.psa8_profit ?? null;
    case 9:
      return row.psa9_profit ?? null;
    case 10:
      // Added 2026-09-13 when this rule absorbed the separate "Min PSA10
      // profit" control, which was the same test with the grade hardcoded.
      return row.psa10_profit ?? null;
  }
}
