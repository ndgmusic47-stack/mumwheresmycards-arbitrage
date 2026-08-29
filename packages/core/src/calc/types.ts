/** Editable via the settings table / dashboard Settings tab (see migration 0005 seed row `fee_schedule`). */
export interface FeeSchedule {
  ebayFinalValueFeePct: number; // e.g. 0.1325 for 13.25%
  ebayFixedFeePerOrder: number; // flat per-order fee, e.g. 0.30
  paymentProcessingPct: number; // additional payment processing %, often 0 when bundled into FVF
  gradingFeePsaRegular: number; // PSA service fee per card
  gradingUpchargeReserve: number; // reserve for potential value-based upcharge tiers
  insuredPostageAllocation: number; // allocated cost of insured postage to the grading company
  outboundPostageDefault: number; // default outbound postage when selling
  packagingDefault: number; // default packaging cost when selling
  cardSaverCost: number;
  sleeveCost: number;
  gradingReturnShippingDefault: number;
  gradingInsuranceDefault: number;
  /** Raw purchase price above which a PSA declared-value upcharge tier is assumed to apply. */
  gradingUpchargeThreshold: number;
}

export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  ebayFinalValueFeePct: 0.1325,
  ebayFixedFeePerOrder: 0.3,
  paymentProcessingPct: 0,
  gradingFeePsaRegular: 65, // corrected for the current UK PSA Regular service tier — was wrongly modeled at £25
  gradingUpchargeReserve: 15,
  insuredPostageAllocation: 8,
  outboundPostageDefault: 4.5,
  packagingDefault: 1.5,
  cardSaverCost: 0.2,
  sleeveCost: 0.1,
  gradingReturnShippingDefault: 7,
  gradingInsuranceDefault: 3,
  gradingUpchargeThreshold: 500,
};

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

export interface SaleInput {
  salePrice: number;
  outboundPostage?: number;
  insurance?: number;
  packaging?: number;
  /** Overrides for fee schedule fields; falls back to DEFAULT_FEE_SCHEDULE. */
  fees?: Partial<Pick<FeeSchedule, "ebayFinalValueFeePct" | "ebayFixedFeePerOrder" | "paymentProcessingPct">>;
}

export interface NetSaleProceeds {
  salePrice: number;
  marketplaceFee: number;
  fixedFee: number;
  paymentProcessingFee: number;
  outboundPostage: number;
  insurance: number;
  packaging: number;
  totalDeductions: number;
  netProceeds: number;
}

export interface FlipProfitResult {
  totalAcquisitionCost: number;
  netSaleProceeds: number;
  netProfit: number;
  returnOnCapital: number; // netProfit / totalAcquisitionCost
  profitMargin: number; // netProfit / gross sale price (QSV)
}

export interface GradingBasisInput {
  rawPurchasePrice: number;
  sellerPostage: number;
  packaging?: number;
  sleeve?: number;
  cardSaver?: number;
  insuredGradingPostageAllocation?: number;
  gradingFee?: number;
  returnShipping: number;
  insurance: number;
  /** Only applied when the card's expected value crosses a PSA upcharge tier. */
  upchargeReserveApplies?: boolean;
  fees?: Partial<Pick<FeeSchedule, "packagingDefault" | "cardSaverCost" | "sleeveCost" | "insuredPostageAllocation" | "gradingFeePsaRegular" | "gradingUpchargeReserve">>;
}

export interface TotalGradedBasis {
  rawPurchasePrice: number;
  sellerPostage: number;
  packaging: number;
  sleeve: number;
  cardSaver: number;
  insuredGradingPostageAllocation: number;
  gradingFee: number;
  returnShipping: number;
  insurance: number;
  upchargeReserve: number;
  total: number;
}

export const PSA_GRADES = [6, 7, 8, 9, 10] as const;
export type PsaGrade = (typeof PSA_GRADES)[number];

export interface GradeLadderRung {
  grade: PsaGrade;
  marketPrice: number | null; // null when no market data at this grade
  netProceeds: number | null;
  profit: number | null;
}

export interface GradeLadderResult {
  totalGradedBasis: number;
  rungs: GradeLadderRung[];
  /** Lowest grade (ascending) at which profit >= 0, or null if no grade breaks even. */
  breakEvenGrade: PsaGrade | null;
  psa10UpsideMultiple: number | null; // PSA10 net proceeds / total graded basis
}

export type LiquidityLevel = "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";

export const LIQUIDITY_ORDER: Record<LiquidityLevel, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  VERY_HIGH: 3,
};
