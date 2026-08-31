import type { ExitMarketFeeModel } from "../calc/fees.js";
import { DEFAULT_EXIT_MARKET_FEE_MODEL, computeSellingFees, round2, round4 } from "../calc/fees.js";

/**
 * FORECAST vs REALISED.
 *
 * A forecast is frozen the moment a card is purchased and is NEVER
 * recomputed from later data — otherwise the record of what we believed at
 * decision time gets quietly rewritten by hindsight, and the model can
 * never be held to account. Realised economics are computed separately here
 * from what actually happened, and the two are compared.
 *
 * Grading batch costs are the subtle part: at forecast time each card
 * carries an ESTIMATED share of an assumed batch. Once a real submission
 * goes out, the ACTUAL batch cost is divided across the cards actually in
 * it, and that allocation replaces the estimate.
 */

export interface RealisedAcquisition {
  purchasePrice: number;
  sellerPostage: number;
  importTax?: number;
  otherFees?: number;
}

export interface RealisedGrading {
  /** What the grader actually charged for this card's service tier. */
  gradingFee: number;
  /** This card's share of the ACTUAL batch logistics cost. */
  allocatedBatchCost: number;
  /** Any declared-value upcharge actually applied. Zero when none was. */
  upcharge?: number;
  consumables?: number;
}

export interface RealisedSale {
  /** What the buyer actually paid for the item. */
  itemPrice: number;
  buyerPaidShipping?: number;
  outboundPostage: number;
  packaging: number;
  insurance?: number;
  /**
   * Actual marketplace fees, when known from a payout statement. When
   * omitted, they are recomputed from the fee model — flagged via
   * `feesWereEstimated` so a realised figure is never silently a forecast.
   */
  actualSellingFees?: number;
}

export interface RealisedResult {
  totalCost: number;
  acquisitionCost: number;
  gradingCost: number;
  buyerPayment: number;
  sellingFees: number;
  feesWereEstimated: boolean;
  fulfilmentCost: number;
  realNetProfit: number;
  realReturnOnCapital: number;
  daysCapitalLocked: number | null;
  profitPerDay: number | null;
}

export function computeRealisedEconomics(params: {
  acquisition: RealisedAcquisition;
  grading?: RealisedGrading;
  sale: RealisedSale;
  purchasedAt?: string;
  soldAt?: string;
  feeModel?: ExitMarketFeeModel;
}): RealisedResult {
  const feeModel = params.feeModel ?? DEFAULT_EXIT_MARKET_FEE_MODEL;

  const acquisitionCost = round2(
    params.acquisition.purchasePrice +
      params.acquisition.sellerPostage +
      (params.acquisition.importTax ?? 0) +
      (params.acquisition.otherFees ?? 0),
  );

  const gradingCost = params.grading
    ? round2(
        params.grading.gradingFee +
          params.grading.allocatedBatchCost +
          (params.grading.upcharge ?? 0) +
          (params.grading.consumables ?? 0),
      )
    : 0;

  const buyerPaidShipping = params.sale.buyerPaidShipping ?? 0;
  const buyerPayment = round2(params.sale.itemPrice + buyerPaidShipping);

  const feesWereEstimated = params.sale.actualSellingFees === undefined;
  const sellingFees =
    params.sale.actualSellingFees ??
    computeSellingFees({ itemPrice: params.sale.itemPrice, buyerPaidShipping }, feeModel).totalSellingFees;

  const fulfilmentCost = round2(
    params.sale.outboundPostage + params.sale.packaging + (params.sale.insurance ?? 0),
  );

  const totalCost = round2(acquisitionCost + gradingCost);
  const realNetProfit = round2(buyerPayment - sellingFees - fulfilmentCost - totalCost);
  const daysCapitalLocked = daysBetween(params.purchasedAt, params.soldAt);

  return {
    totalCost,
    acquisitionCost,
    gradingCost,
    buyerPayment,
    sellingFees: round2(sellingFees),
    feesWereEstimated,
    fulfilmentCost,
    realNetProfit,
    realReturnOnCapital: totalCost > 0 ? round4(realNetProfit / totalCost) : 0,
    daysCapitalLocked,
    profitPerDay: daysCapitalLocked && daysCapitalLocked > 0 ? round2(realNetProfit / daysCapitalLocked) : null,
  };
}

/**
 * Allocates the ACTUAL cost of a real grading submission across the cards
 * actually in it — replacing the forecast's assumed batch size. A batch
 * that went out with 6 cards instead of the assumed 10 costs more per card,
 * and the realised numbers must say so.
 */
export function allocateBatchCost(params: {
  outboundPostage: number;
  returnPostage: number;
  insurance: number;
  otherBatchCosts?: number;
  cardCount: number;
}): number {
  if (params.cardCount < 1) {
    throw new Error("allocateBatchCost: cardCount must be >= 1");
  }
  return round2(
    (params.outboundPostage + params.returnPostage + params.insurance + (params.otherBatchCosts ?? 0)) /
      params.cardCount,
  );
}

export interface ForecastVsRealised {
  forecastNetProfit: number | null;
  realNetProfit: number;
  profitVariance: number | null;
  forecastReturnOnCapital: number | null;
  realReturnOnCapital: number;
  rocVariance: number | null;
  forecastCapitalLockDays: number | null;
  actualCapitalLockDays: number | null;
  capitalLockVariance: number | null;
  /** TRUE when the trade did better than forecast. */
  outperformed: boolean | null;
}

/**
 * Compares a frozen forecast against what actually happened. The forecast
 * side comes from `inventory.forecast_snapshot` — a copy taken at purchase
 * — never from a recomputation against today's market data.
 */
export function compareForecastVsRealised(params: {
  forecastNetProfit: number | null;
  forecastReturnOnCapital: number | null;
  forecastCapitalLockDays: number | null;
  realised: RealisedResult;
}): ForecastVsRealised {
  const { realised } = params;

  const profitVariance =
    params.forecastNetProfit === null ? null : round2(realised.realNetProfit - params.forecastNetProfit);

  return {
    forecastNetProfit: params.forecastNetProfit,
    realNetProfit: realised.realNetProfit,
    profitVariance,
    forecastReturnOnCapital: params.forecastReturnOnCapital,
    realReturnOnCapital: realised.realReturnOnCapital,
    rocVariance:
      params.forecastReturnOnCapital === null
        ? null
        : round4(realised.realReturnOnCapital - params.forecastReturnOnCapital),
    forecastCapitalLockDays: params.forecastCapitalLockDays,
    actualCapitalLockDays: realised.daysCapitalLocked,
    capitalLockVariance:
      params.forecastCapitalLockDays === null || realised.daysCapitalLocked === null
        ? null
        : realised.daysCapitalLocked - params.forecastCapitalLockDays,
    outperformed: profitVariance === null ? null : profitVariance >= 0,
  };
}

function daysBetween(from?: string, to?: string): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
}
