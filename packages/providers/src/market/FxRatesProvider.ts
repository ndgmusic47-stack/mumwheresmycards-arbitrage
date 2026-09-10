import type { FxRates } from "@mwmc/core";
import { DEFAULT_FX_RATES } from "@mwmc/core";

/**
 * LIVE FX RATES (2026-09-10).
 *
 * `DEFAULT_FX_RATES` is a hardcoded table — USD 0.79, EUR 0.86 — written
 * once and never revisited. Every PokeTrace price this system stores is
 * denominated in USD or EUR and converted through that table, so a drifted
 * rate silently mis-states every raw price, every PSA slab value, every
 * QSV and every grading profit in the tool, in the same direction, forever.
 *
 * Source: Frankfurter (frankfurter.dev) — published central-bank reference
 * rates, no API key, no daily quota. One call per day.
 *
 * WHAT THIS DOES NOT FIX. FX is the SMALLEST of the three things wrong with
 * our prices, and saying otherwise would be misleading:
 *   1. Market mismatch — PokeTrace tags each card US or EU and nothing in
 *      this codebase selects a market. A UK seller may be pricing against
 *      US sold data. That error is per-card and can dwarf FX.
 *   2. Graded values are unhaircut plain AVERAGES, while raw values get a
 *      conservative median-then-8%-haircut. The two sides of every grading
 *      trade are computed to different standards.
 *   3. FX itself — a few percent, uniform, and what this file addresses.
 *
 * DEFENSIVE BY DESIGN. This code was written against Frankfurter's
 * documentation, NOT against a verified live response — the sandbox it was
 * developed in cannot reach the API. So it accepts either documented
 * response shape, validates every rate before use, and returns null rather
 * than a half-parsed table on anything unexpected. A failed refresh must
 * leave the existing rates untouched: a stale rate is a small error, a
 * corrupted one is a wrong number presented with confidence.
 */

/** Currencies PokeTrace actually prices in — see PokeTraceProvider. */
export const FX_CURRENCIES = ["USD", "EUR"] as const;

export const FRANKFURTER_BASE_URL = "https://api.frankfurter.app";

/**
 * A rate is only plausible within a wide sanity band. This is NOT an
 * attempt to predict the market — it is a guard against parsing something
 * that isn't a rate at all (a status code, a timestamp, a count) and
 * writing it into the table that prices every card. USD/GBP has not left
 * 0.4-1.2 in decades; the band is deliberately far wider than any credible
 * move so it only ever catches nonsense.
 */
const MIN_PLAUSIBLE_RATE = 0.2;
const MAX_PLAUSIBLE_RATE = 5;

export function isPlausibleRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_PLAUSIBLE_RATE && value <= MAX_PLAUSIBLE_RATE;
}

/**
 * Normalises either documented Frankfurter response into our table shape.
 *
 * Both shapes carry `rates` as `{ CURRENCY: number }`; they differ in the
 * wrapper. We query with GBP as the base, so `rates.USD` reads "1 GBP buys
 * N dollars" — the INVERSE of what FxRates stores ("1 dollar is worth N
 * pounds"). Getting that backwards would flip every price in the tool by a
 * factor of ~1.6, so it is inverted explicitly here and asserted in tests.
 *
 * Returns null — never a partial table — if anything is missing or
 * implausible. A caller that gets null keeps the rates it already had.
 */
export function parseGbpBasedRates(body: unknown): FxRates | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;

  const base = typeof record.base === "string" ? record.base.toUpperCase() : null;
  // We always ask for GBP as the base. A response based on anything else
  // means the request didn't do what we think, so refuse rather than
  // silently mis-converting.
  if (base !== null && base !== "GBP") return null;

  const rates = record.rates;
  if (!rates || typeof rates !== "object") return null;
  const rateRecord = rates as Record<string, unknown>;

  const table: FxRates = { GBP: 1 };
  for (const currency of FX_CURRENCIES) {
    const gbpBuys = rateRecord[currency];
    // "1 GBP buys N units" -> "1 unit is worth 1/N GBP".
    if (!isPlausibleRate(gbpBuys)) return null;
    const asGbp = 1 / gbpBuys;
    if (!isPlausibleRate(asGbp)) return null;
    table[currency] = Math.round(asGbp * 10000) / 10000;
  }
  return table;
}

export interface FxFetchResult {
  rates: FxRates;
  /** Which table the caller is holding: fresh from the API, or the previous
   *  one because the call failed. Surfaced so a scan can say so honestly
   *  rather than implying every price was freshly converted. */
  source: "LIVE" | "FALLBACK";
  /** Present only when source is FALLBACK — why the refresh didn't happen. */
  error?: string;
}

/**
 * Fetches today's rates. NEVER throws and NEVER returns a partial table:
 * on any failure the caller gets `previous` back, flagged FALLBACK.
 */
export async function fetchLiveFxRates(
  previous: FxRates = DEFAULT_FX_RATES,
  options: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FxFetchResult> {
  const baseUrl = options.baseUrl ?? FRANKFURTER_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const url = `${baseUrl}/latest?from=GBP&to=${FX_CURRENCIES.join(",")}`;

  try {
    const response = await doFetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      return { rates: previous, source: "FALLBACK", error: `FX provider returned HTTP ${response.status}` };
    }
    const body = await response.json();
    const parsed = parseGbpBasedRates(body);
    if (!parsed) {
      return { rates: previous, source: "FALLBACK", error: "FX provider response did not contain usable GBP-based rates" };
    }
    return { rates: parsed, source: "LIVE" };
  } catch (err) {
    return { rates: previous, source: "FALLBACK", error: `FX provider unreachable: ${String(err)}` };
  }
}

/** Metadata stored alongside the rates so a human can see when they last
 *  moved, and whether the tool has been quietly running on fallbacks. */
export interface FxRatesMeta {
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  source: "LIVE" | "FALLBACK";
  error?: string;
}

/**
 * True when the rates are old enough to be worth a call.
 *
 * 20 hours, not 24: the scan runs every 30 minutes, and a hard 24-hour gate
 * would drift a little later each day until it skipped one entirely. 20
 * hours guarantees exactly one refresh per calendar day with room to spare,
 * and still costs one subrequest out of a 9,000 daily budget.
 */
export const FX_REFRESH_AFTER_HOURS = 20;

export function isFxRefreshDue(meta: FxRatesMeta | null, now: Date = new Date()): boolean {
  if (!meta?.lastFetchedAt) return true;
  const last = new Date(meta.lastFetchedAt.includes("T") ? meta.lastFetchedAt : `${meta.lastFetchedAt.replace(" ", "T")}Z`);
  if (Number.isNaN(last.getTime())) return true;
  return now.getTime() - last.getTime() >= FX_REFRESH_AFTER_HOURS * 3600_000;
}
