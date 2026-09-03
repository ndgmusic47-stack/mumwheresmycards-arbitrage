import { round2, round4 } from "../calc/fees.js";
import type { ForecastVsRealised } from "./realisedEconomics.js";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream N: the AI financial auditor's
 * ground truth. A single `ForecastVsRealised` record (already produced by
 * `compareForecastVsRealised`, see that file's own doc comment) says how
 * ONE realised trade compared to its frozen forecast; this file aggregates
 * many of them into the summary statistics that reveal a SYSTEMIC pattern —
 * "GRADE trades have underperformed forecast profit by an average of £X
 * across N sales" — a question no single trade's own numbers can answer.
 *
 * WHY THIS STAYS 100% DETERMINISTIC, SAME AS `scenarioEngine.ts`
 * (Workstream M): this app's founding "AI never a source of financial
 * numbers" discipline applies just as much to an AGGREGATE figure as to a
 * single one. `summarizeForecastVariance()` computes every statistic here;
 * the AI financial auditor (`packages/providers/src/audit/`) only ever
 * narrates the result, never recomputes it.
 */
export interface VarianceSummary {
  /** Count of records that actually HAD a forecast to compare against — a
   *  realised trade with no linked opportunity (so no frozen forecast)
   *  contributes nothing here, never a fabricated zero variance. */
  sampleSize: number;
  outperformedCount: number;
  underperformedCount: number;
  /** Fraction of `sampleSize` that outperformed. Null only when
   *  `sampleSize` is 0 — never a fabricated 0/0. */
  outperformedRate: number | null;
  meanProfitVariance: number | null;
  medianProfitVariance: number | null;
  /** Null when no record in the sample had a comparable ROC variance
   *  (rocVariance is itself only present when the trade had a forecast
   *  ROC) — kept independent of `sampleSize` since a record can contribute
   *  a profit variance without a ROC one, or vice versa, in principle. */
  meanRocVariance: number | null;
  meanCapitalLockVarianceDays: number | null;
}

const EMPTY_SUMMARY: VarianceSummary = {
  sampleSize: 0,
  outperformedCount: 0,
  underperformedCount: 0,
  outperformedRate: null,
  meanProfitVariance: null,
  medianProfitVariance: null,
  meanRocVariance: null,
  meanCapitalLockVarianceDays: null,
};

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? round2(sorted[mid]!) : round2((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Same as `mean()` but rounded to 4dp — for fraction-shaped values (ROC
 *  variance) rather than currency-shaped ones. */
function meanFraction(values: number[]): number | null {
  if (values.length === 0) return null;
  return round4(values.reduce((sum, v) => sum + v, 0) / values.length);
}

/**
 * Aggregates a batch of `ForecastVsRealised` records — one per realised
 * (sold) trade — into the summary statistics the AI financial auditor
 * narrates over. A record whose own `profitVariance` is null (no forecast
 * existed to compare against — e.g. inventory added without a linked
 * opportunity) is excluded from `sampleSize` entirely, never counted as a
 * zero-variance trade.
 */
export function summarizeForecastVariance(records: ForecastVsRealised[]): VarianceSummary {
  const withForecast = records.filter((r) => r.profitVariance !== null);
  if (withForecast.length === 0) return EMPTY_SUMMARY;

  const profitVariances = withForecast.map((r) => r.profitVariance!);
  const rocVariances = withForecast.map((r) => r.rocVariance).filter((v): v is number => v !== null);
  const lockVariances = withForecast.map((r) => r.capitalLockVariance).filter((v): v is number => v !== null);

  const outperformedCount = withForecast.filter((r) => r.outperformed === true).length;
  const underperformedCount = withForecast.filter((r) => r.outperformed === false).length;

  return {
    sampleSize: withForecast.length,
    outperformedCount,
    underperformedCount,
    outperformedRate: round4(outperformedCount / withForecast.length),
    meanProfitVariance: mean(profitVariances),
    medianProfitVariance: median(profitVariances),
    meanRocVariance: meanFraction(rocVariances),
    meanCapitalLockVarianceDays: mean(lockVariances),
  };
}
