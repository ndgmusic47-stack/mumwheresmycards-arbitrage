/**
 * PokeTrace prices in USD (US market) or EUR (EU/Cardmarket) — not GBP —
 * and this application's entire financial engine (packages/core/src/calc)
 * assumes GBP throughout. This is a v1, deliberately simple normalization
 * layer: a small, editable, STATIC rate table (settings key `fx_rates`),
 * not a live FX feed. Treat it as an approximation to refresh periodically
 * via Settings, not a source of truth — see ARCHITECTURE.md.
 */
export interface FxRates {
  GBP: number;
  [currency: string]: number;
}

export const DEFAULT_FX_RATES: FxRates = { GBP: 1, USD: 0.79, EUR: 0.86 };

/**
 * Converts an amount FROM the given currency INTO GBP. Rates are expressed
 * as "1 unit of fromCurrency = rate GBP" (e.g. USD: 0.79 means $1 = 80p).
 * GBP is always a no-op regardless of the table (so a missing/stale GBP
 * entry can never distort already-correct data). Throws on an unknown
 * currency rather than silently treating it as GBP — a wrong FX rate
 * table is a config problem to surface immediately, not to guess past.
 */
export function convertToGbp(amount: number | null, fromCurrency: string, rates: FxRates = DEFAULT_FX_RATES): number | null {
  if (amount === null) return null;
  const currency = fromCurrency.toUpperCase();
  if (currency === "GBP") return amount;

  const rate = rates[currency];
  if (rate === undefined) {
    throw new Error(`convertToGbp: no FX rate configured for currency "${currency}" (configured: ${Object.keys(rates).join(", ")})`);
  }
  return round2(amount * rate);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
