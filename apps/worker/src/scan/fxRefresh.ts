import { Db } from "@mwmc/db";
import type { FxRates } from "@mwmc/core";
import { fetchLiveFxRates, isFxRefreshDue, type FxRatesMeta } from "@mwmc/providers";
import { updateSetting } from "../repo/settingsRepo.js";

/**
 * Once-a-day FX refresh, run at the top of a scan.
 *
 * WHY THIS IS ALL IT TAKES. `settings.fxRates` is the single choke point for
 * currency in this system: the market provider, catalogue sync, condition
 * tier extraction, stored-snapshot rehydration, the opportunity detail
 * route, and (inverted, via usdPerGbpFrom) the PSA declared-value cap all
 * read that one table. Keeping that row current is therefore the entire
 * job — no pricing code changes at all.
 *
 * WHY IT LIVES IN THE SCAN. The Worker's only scheduled trigger is the scan
 * cron. A separate schedule would be a second thing to configure and forget.
 * The staleness guard means 47 of the 48 daily runs skip it entirely.
 *
 * FAILURE IS NOT AN ERROR. If the FX API is down, the previous rates keep
 * being used and the run records a NOTE, not an error — a scan must never
 * fail because a currency feed blinked. But the fallback IS recorded, so
 * "the tool has quietly been running on a three-week-old rate" is
 * discoverable rather than invisible.
 */
export const FX_RATES_KEY = "fx_rates";
export const FX_RATES_META_KEY = "fx_rates_meta";

export interface FxRefreshOutcome {
  attempted: boolean;
  source: "LIVE" | "FALLBACK" | "SKIPPED";
  rates: FxRates;
  /** Human-readable line for the scan's notes, or null when nothing happened. */
  note: string | null;
}

export async function refreshFxRatesIfDue(
  db: Db,
  currentRates: FxRates,
  currentMeta: FxRatesMeta | null,
  now: Date = new Date(),
  fetchImpl?: typeof fetch,
): Promise<FxRefreshOutcome> {
  if (!isFxRefreshDue(currentMeta, now)) {
    return { attempted: false, source: "SKIPPED", rates: currentRates, note: null };
  }

  const result = await fetchLiveFxRates(currentRates, { fetchImpl });
  const nowIso = now.toISOString();

  const meta: FxRatesMeta = {
    lastFetchedAt: nowIso,
    lastSuccessAt: result.source === "LIVE" ? nowIso : (currentMeta?.lastSuccessAt ?? null),
    source: result.source,
    ...(result.error ? { error: result.error } : {}),
  };

  // Always record the ATTEMPT, even on failure — otherwise a permanently
  // broken feed retries every 30 minutes forever and nothing says so.
  await updateSetting(db, FX_RATES_META_KEY, meta, "fx-refresh");

  if (result.source === "FALLBACK") {
    return {
      attempted: true,
      source: "FALLBACK",
      rates: currentRates,
      note: `FX rates could not be refreshed (${result.error}) — continuing on the previous table. Prices remain converted at the last known rate.`,
    };
  }

  const changed = describeChange(currentRates, result.rates);
  // Only write the rates themselves on success, so a bad response can never
  // replace a good table.
  await updateSetting(db, FX_RATES_KEY, result.rates, "fx-refresh");

  return {
    attempted: true,
    source: "LIVE",
    rates: result.rates,
    // Deliberately silent when nothing moved. The user asked for the
    // technical noise to be taken off this screen, and "the exchange rate is
    // the same as yesterday" is not news. A real move IS news — it shifts
    // every USD- and EUR-priced card in the tool — and so is a failure.
    note: changed
      ? `FX rates refreshed: ${changed}. Cards re-converted at the new rate as each one next refreshes its market profile.`
      : null,
  };
}

/** "USD 0.7900 -> 0.7412 (-6.2%)" for each currency that actually moved. */
function describeChange(before: FxRates, after: FxRates): string | null {
  const parts: string[] = [];
  for (const currency of Object.keys(after)) {
    if (currency === "GBP") continue;
    const from = before[currency];
    const to = after[currency];
    if (typeof from !== "number" || typeof to !== "number") continue;
    if (Math.abs(to - from) < 0.00005) continue;
    const pct = ((to - from) / from) * 100;
    parts.push(`${currency} ${from.toFixed(4)} -> ${to.toFixed(4)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}
