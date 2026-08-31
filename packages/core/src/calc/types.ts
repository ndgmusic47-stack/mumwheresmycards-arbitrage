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
}

export const DEFAULT_GRADING_SERVICES: GradingService[] = [
  {
    id: "PSA_REGULAR",
    graderId: "PSA",
    name: "PSA Regular",
    feePerCard: 65,
    estimatedTurnaroundBusinessDays: 75,
    declaredValueCapUsd: 1500,
    enabled: true,
  },
  {
    id: "PSA_VALUE",
    graderId: "PSA",
    name: "PSA Value",
    feePerCard: 23,
    estimatedTurnaroundBusinessDays: 160,
    declaredValueCapUsd: 500,
    enabled: true,
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

export const PSA_GRADES = [6, 7, 8, 9, 10] as const;
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
}

export interface GradeLadderResult {
  totalGradedBasis: number;
  rungs: GradeLadderRung[];
  /** Lowest grade (ascending) at which profit >= 0, or null if none break even. */
  breakEvenGrade: PsaGrade | null;
  /** PSA10 GROSS slab value / total graded basis — the headline upside multiple. */
  psa10GrossMultiple: number | null;
  /** PSA10 NET proceeds / total graded basis. */
  psa10NetMultiple: number | null;
  /** TRUE when any populated grade would breach the service's declared-value cap. */
  anyPotentialUpcharge: boolean;
}
