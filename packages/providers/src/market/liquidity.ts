import type { LiquidityLevel } from "@mwmc/core";

/**
 * Liquidity classification thresholds based on sold-comp sample size in
 * the lookback window. v1 heuristic; swap for a real turnover-rate model
 * once enough scan history exists.
 */
export function classifyLiquidity(sampleSize: number): LiquidityLevel {
  if (sampleSize >= 40) return "VERY_HIGH";
  if (sampleSize >= 15) return "HIGH";
  if (sampleSize >= 5) return "MEDIUM";
  return "LOW";
}
