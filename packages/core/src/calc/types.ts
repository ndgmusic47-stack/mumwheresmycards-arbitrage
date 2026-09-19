/**
 * Commercial assumptions live in Settings, never in calculation code. Every
 * interface here has a DEFAULT_* seed value that is editable from the
 * dashboard (see migration 0013 and apps/worker/src/repo/settingsRepo.ts) —
 * the defaults exist so a fresh database is usable, not so any of these
 * numbers are baked in.
 */

export type LiquidityLevel = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";

export const LIQUIDITY_ORDER: Record<LiquidityLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  VERY_HIGH: 3,
};

// ---------------------------------------------------------------------------
// Selling-side costs (ours, not the marketplace's)
// ---------------------------------------------------------------------------

export interface SellingCostSettings {
  /** Our outbound postage when shipping a sold RAW card. */
  outboundPostage: number;
  /** Our outbound postage when shipping a sold GRADED slab (heavier, usually tracked/insured). */
  outboundPostageGraded: number;
  packaging: number;
  /** Insurance on the outbound sale shipment. */
  saleInsurance: number;
  saleInsuranceGraded: number;
}

export const DEFAULT_SELLING_COSTS: SellingCostSettings = {
  outboundPostage: 1.55,
  outboundPostageGraded: 4.5,
  packaging: 0.75,
  saleInsurance: 0,
  saleInsuranceGraded: 2.5,
};

// ---------------------------------------------------------------------------
// Grading: graders, services, batch logistics, consumables
// ---------------------------------------------------------------------------

/**
 * A grading company. Architected for several, but a grader is only ENABLED
 * for arbitrage once we have reliable raw-to-grade pricing, sold slab
 * pricing, liquidity, and an exact grade-tier mapping for it. Cheap grading
 * is not a reason to enable a grader — resale profit is the objective, not
 * the cheapest plastic slab.
 */
export interface Grader {
  id: string;
  name: string;
  enabled: boolean;
  /** Why a supported grader is currently disabled — shown in Settings. */
  disabledReason: string | null;
}

export const DEFAULT_GRADERS: Grader[] = [
  { id: "PSA", name: "PSA", enabled: true, disabledReason: null },
  {
    id: "BGS",
    name: "Beckett (BGS)",
    enabled: false,
    disabledReason: "Supported but disabled until BGS sold-slab pricing, liquidity and grade-tier mapping are validated.",
  },
  {
    id: "CGC",
    name: "CGC",
    enabled: false,
    disabledReason: "Supported but disabled until CGC sold-slab pricing, liquidity and grade-tier mapping are validated.",
  },
];

/**
 * A grading service tier. Fees, turnaround and declared-value caps are DATA:
 * nothing in the calculation path may assume "grading costs £65" or any
 * particular turnaround.
 */
export interface GradingService {
  id: string;
  graderId: string;
  name: string;
  /** Service fee per card, in GBP. */
  feePerCard: number;
  /**
   * Estimated turnaround in business days. ESTIMATE — grading companies
   * publish targets, not guarantees, and actuals routinely run longer.
   */
  estimatedTurnaroundBusinessDays: number;
  /**
   * Maximum final graded value this service tier accepts, in USD (the
   * currency graders publish these caps in). A card whose slab value at
   * some grade exceeds this cap may be bumped to a higher-priced tier —
   * flagged as POTENTIAL UPCHARGE, never silently priced.
   */
  declaredValueCapUsd: number | null;
  enabled: boolean;
  /**
   * PROVENANCE — added 2026-09-19, because until then there was none.
   *
   * The standing rule in this project is that selecting a grader must never
   * invent a fee. It was being broken quietly: £23 and £65 sat in this file
   * with no source and no date, and every economic decision the tool has
   * ever made rests on them. Checked against PSA's published price list for
   * the first time on 2026-09-19, they were wrong — see the note on
   * DEFAULT_GRADING_SERVICES.
   *
   * These three fields make an unsourced fee VISIBLE rather than plausible.
   * A service with no `pricedUsd` and no `verifiedAt` is a number somebody
   * typed, and should read as one.
   */
  /** The grader's own published price, in the currency they publish it in. */
  pricedUsd?: number | null;
  /** Where that figure came from. */
  sourceUrl?: string | null;
  /** ISO date the figure was last checked against that source. */
  verifiedAt?: string | null;
  /**
   * Why this service is switched off, when it is. A disabled service with no
   * reason is indistinguishable from one nobody got round to enabling.
   */
  unavailableReason?: string | null;
}

/**
 * PSA'S ACTUAL PRICES, checked 2026-09-19 — and what was here before was
 * wrong in a way that mattered.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT WAS HERE. "PSA Value" at £23 and "PSA Regular" at £65, with no
 * source and no date, and no record of anyone ever checking them. Every
 * grading decision this tool has made rests on those two numbers, and the
 * £23 one is the tier it reaches for on a cheap card.
 *
 * WHAT PSA ACTUALLY PUBLISHES. Their own service page lists Value and Value
 * Bulk as CURRENTLY UNAVAILABLE. The cheapest tier they are accepting is
 * Standard at $59.99 with a $1,000 declared-value cap, then Priority at
 * $79.99 with a $1,500 cap.
 *
 * So the tool has been pricing every cheap card against a service PSA is not
 * taking submissions for, at a fee roughly HALF what the cheapest available
 * tier actually costs. Not a rounding error — it is the difference between a
 * trade and a loss on anything thin, and it ran in the operator's favour on
 * screen and against him in reality.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE GBP FIGURES ARE DERIVED AND SHOWN AS SUCH. PSA charges in USD.
 * Storing a frozen GBP number hides the fact that the real cost moves with
 * the exchange rate. `pricedUsd` is now the source of truth and the GBP
 * figure is a conversion at the project's static rate, so the next person to
 * read this can see which is the fact and which is the arithmetic.
 *
 * WHAT IS STILL NOT MODELLED, and should not be assumed away:
 *   - Value Bulk ($24.99) requires PSA Collector's Club membership and a
 *     20-card minimum. Neither the membership cost nor that minimum exists
 *     anywhere in this model, and the batch size here is 10.
 *   - Shipping a UK submission to PSA, and the customs handling on the way
 *     back, are not in these fees.
 * Both make the real cost HIGHER than what is below.
 */
export const DEFAULT_GRADING_SERVICES: GradingService[] = [
  {
    id: "PSA_VALUE",
    graderId: "PSA",
    name: "PSA Value (not accepting submissions)",
    // Left at its historical figure deliberately rather than deleted: rows
    // priced against it are still in the database and should stay readable.
    feePerCard: 23,
    estimatedTurnaroundBusinessDays: 160,
    declaredValueCapUsd: 500,
    enabled: false,
    pricedUsd: null,
    sourceUrl: "https://www.psacard.com/services/tradingcardgrading",
    verifiedAt: "2026-09-19",
    unavailableReason:
      "PSA lists Value and Value Bulk as currently unavailable. Every figure this tool produced against this tier assumed a service that could not be bought.",
  },
  {
    id: "PSA_STANDARD",
    graderId: "PSA",
    name: "PSA Standard",
    // $59.99 at the project's static USD->GBP rate of 0.7403.
    feePerCard: 44.41,
    estimatedTurnaroundBusinessDays: 95,
    declaredValueCapUsd: 1000,
    enabled: true,
    pricedUsd: 59.99,
    sourceUrl: "https://www.psacard.com/services/tradingcardgrading",
    verifiedAt: "2026-09-19",
  },
  {
    id: "PSA_REGULAR",
    graderId: "PSA",
    // Renamed to what PSA actually calls it. "Regular" is not on their price
    // list; Priority is the $1,500-cap tier this row was always describing.
    name: "PSA Priority",
    // $79.99 at 0.7403. Was £65, which matched no published figure.
    feePerCard: 59.22,
    estimatedTurnaroundBusinessDays: 75,
    declaredValueCapUsd: 1500,
    enabled: true,
    pricedUsd: 79.99,
    sourceUrl: "https://www.psacard.com/services/tradingcardgrading",
    verifiedAt: "2026-09-19",
  },
];

/**
 * Grading logistics are BATCH costs, not per-card costs. Our operational
 * assumption is a minimum 10-card submission, so postage/insurance to and
 * from the grader are shared across the batch — modelling £8 outbound and
 * £7 return PER CARD (as this project previously did) overstates the cost
 * of grading a single card by an order of magnitude and silently killed
 * otherwise-viable candidates.
 */
export interface GradingBatchSettings {
  batchSize: number;
  batchOutboundPostage: number;
  batchReturnPostage: number;
  batchInsurance: number;
}

export const DEFAULT_GRADING_BATCH: GradingBatchSettings = {
  batchSize: 10,
  batchOutboundPostage: 15,
  batchReturnPostage: 20,
  batchInsurance: 12,
};

/** Genuinely per-card consumables — these do NOT get divided by batch size. */
export interface GradingConsumables {
  sleeveCost: number;
  cardSaverCost: number;
}

export const DEFAULT_GRADING_CONSUMABLES: GradingConsumables = {
  sleeveCost: 0.1,
  cardSaverCost: 0.2,
};

/**
 * What we assume a declared-value upcharge costs when a grade's slab value
 * exceeds the selected service's cap. The exact escalation is NOT known
 * ahead of submission, so this is an explicit reserve, flagged as such, and
 * never presented as a known charge.
 */
export interface UpchargeSettings {
  /** Estimated additional cost if the card is bumped above the service tier. */
  estimatedUpchargeCost: number;
  /** Whether to include the reserve in the graded basis, or only flag it. */
  includeReserveInBasis: boolean;
}

export const DEFAULT_UPCHARGE_SETTINGS: UpchargeSettings = {
  estimatedUpchargeCost: 40,
  includeReserveInBasis: false,
};

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------

export interface AcquisitionInput {
  purchasePrice: number;
  sellerPostage: number;
  importTax?: number;
  acquisitionFees?: number;
}

export interface TotalAcquisitionCost {
  purchasePrice: number;
  sellerPostage: number;
  importTax: number;
  acquisitionFees: number;
  total: number;
}

// ---------------------------------------------------------------------------
// Flip result
// ---------------------------------------------------------------------------

export interface FlipProfitResult {
  totalAcquisitionCost: number;
  netSaleProceeds: number;
  /** TRUE NET PROFIT = net sale cash - total acquisition. */
  netProfit: number;
  /** RETURN ON ACQUISITION CAPITAL = true net profit / total acquisition. */
  returnOnCapital: number;
  /** Profit as a fraction of the buyer's payment (revenue), not of proceeds. */
  profitMargin: number;
  /** Estimated days the capital is tied up before the sale completes. */
  expectedDaysToSale: number | null;
  /** True net profit per £ of capital deployed — identical to ROC, surfaced explicitly. */
  profitPerPoundOfCapital: number;
}

// ---------------------------------------------------------------------------
// Grading basis + ladder
// ---------------------------------------------------------------------------

export interface GradedBasisInput {
  rawPurchasePrice: number;
  sellerPostage: number;
  importTax?: number;
  acquisitionFees?: number;
  service: GradingService;
  batch?: GradingBatchSettings;
  consumables?: GradingConsumables;
  /** Set when a declared-value upcharge reserve should be carried in the basis. */
  upchargeReserve?: number;
}

export interface TotalGradedBasis {
  rawPurchasePrice: number;
  sellerPostage: number;
  importTax: number;
  acquisitionFees: number;
  /** Grading service fee per card for the selected tier. */
  gradingFee: number;
  /** (batch outbound + batch return + batch insurance) / batch size. */
  perCardSharedLogistics: number;
  sleeve: number;
  cardSaver: number;
  upchargeReserve: number;
  total: number;
  /** Echoed so the UI can show which service/batch assumptions produced this. */
  serviceId: string;
  batchSize: number;
}

/**
 * THE WHOLE SCALE — widened from [6,7,8,9,10] on 2026-09-19.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY. The operator's business, in his words: "I want money all through the
 * grading scale. I want to buy at £200 raw and sell at £500 PSA 5. I'm not
 * going to aim for gems." Under a five-rung scale that trade could not be
 * expressed at all — not filtered out, not scored badly, simply
 * inexpressible, because there was nowhere to put a PSA 5 price.
 *
 * The data was never missing. Migration 0026 has been storing the full
 * graded spectrum in market_snapshots.graded_prices_json since 12
 * September, and on the live database the day this changed there were
 * 20,150 snapshots carrying a PSA 5, 12,315 a PSA 4, 7,928 a PSA 3, 5,647 a
 * PSA 2 and 12,736 a PSA 1. Fetched, stored, and read by nothing on the
 * scan path.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS SAFE TO WIDEN. Every consumer looks a rung up BY GRADE
 * (`rungs.find(r => r.grade === 9)`), never by position, so a longer ladder
 * adds rungs without moving any existing one. The single positional use is
 * scenarioEngine's zip of two ladders, and both are built from this list.
 * A grade with no price already produces a null rung, so cards with no low
 * data behave exactly as before.
 *
 * WHAT IT CHANGES FOR FREE. findBreakEven walks the scale in ascending
 * order and reports `untestedBelow` — the grades it could not check. A card
 * that broke even "at PSA 6" now says so while naming 1 to 5 as untested,
 * which is what was always true and was never stated.
 *
 * Ascending order is load-bearing: findBreakEven relies on it to return the
 * LOWEST grade that pays.
 */
export const PSA_GRADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type PsaGrade = (typeof PSA_GRADES)[number];

export interface GradeLadderRung {
  grade: PsaGrade;
  /** Gross slab market value at this grade — null when no market data. */
  grossSlabValue: number | null;
  sellingFees: number | null;
  netProceeds: number | null;
  profit: number | null;
  returnOnCapital: number | null;
  /** TRUE when this grade's slab value exceeds the service's declared-value cap. */
  potentialUpcharge: boolean;
  /**
   * How many sales the provider had behind this grade's price. Added
   * 2026-09-13. `null` means NOT KNOWN — never zero. A rung with a price and
   * a null count is a number with no stated evidence, and the operator is
   * entitled to see the difference.
   */
  saleCount: number | null;
  /**
   * TRUE when this grade's price is a provider AVERAGE because no sold
   * median existed for the tier. Weaker than the rest of the ladder.
   */
  valueIsEstimated: boolean;
}

export interface GradeLadderResult {
  totalGradedBasis: number;
  rungs: GradeLadderRung[];
  /** Lowest grade (ascending) at which profit >= 0, or null if none break even. */
  breakEvenGrade: PsaGrade | null;
  /**
   * Grades BELOW `breakEvenGrade` that had no price at all, so could not be
   * tested. Added 2026-09-13, and the reason matters.
   *
   * `findBreakEvenGrade` walks upward and skips unpriced rungs, so "breaks
   * even at PSA 7" previously meant either "PSA 7 was checked and pays" or
   * "PSA 6 has no data, so we started at 7". Those are completely different
   * facts and they rendered identically — on the one control closest to the
   * operator's actual strategy.
   *
   * Empty array = every grade below the break-even was priced and genuinely
   * loses money. Non-empty = the break-even shown may be pessimistic, and the
   * listed grades are simply unknown.
   */
  breakEvenUntestedBelow: PsaGrade[];
  /** PSA10 GROSS slab value / total graded basis — the headline upside multiple. */
  psa10GrossMultiple: number | null;
  /** PSA10 NET proceeds / total graded basis. */
  psa10NetMultiple: number | null;
  /** TRUE when any populated grade would breach the service's declared-value cap. */
  anyPotentialUpcharge: boolean;
}
