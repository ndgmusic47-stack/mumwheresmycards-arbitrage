import type { FxRates } from "@mwmc/core";
import { convertToGbp, DEFAULT_FX_RATES } from "@mwmc/core";
import type { MarketDataProvider, MarketSnapshotResult } from "./MarketDataProvider.js";
import { classifyLiquidity } from "./liquidity.js";
import { fetchWithBackoff } from "../http/backoff.js";

export interface PokeTraceConfig {
  apiKey: string;
  baseUrl: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Static FX table used to convert PokeTrace's USD/EUR prices to GBP —
   *  see @mwmc/core market/currency.ts. Defaults to DEFAULT_FX_RATES. */
  fxRates?: FxRates;
  /** PokeTrace's `market` field is 'US' | 'EU', not a currency code — this
   *  maps each to the currency its prices are actually denominated in.
   *  Overridable in case PokeTrace documents additional markets later. */
  marketCurrencyMap?: Record<string, string>;
  /** Used only if `market` is missing/unrecognized on a given card. */
  defaultCurrency?: string;
}

const DEFAULT_MARKET_CURRENCY_MAP: Record<string, string> = { US: "USD", EU: "EUR" };

/**
 * Real PokeTrace API adapter (api.poketrace.com/v1), verified against the
 * published OpenAPI spec (https://api.poketrace.com/v1/openapi.json,
 * v1.7.0) — replaces the previous best-effort `/v1/cards/lookup`
 * implementation, which queried an endpoint that does not exist in the
 * real API.
 *
 * CONFIRMED against a live authenticated call (PHASE 1 smoke test, see
 * apps/worker/scripts/poketrace-smoke-test.ts), not just the spec:
 *
 * - `GET /cards/{id}` wraps its payload as `{ data: {...} }` — a single
 *   envelope layer the spec didn't make obvious. `unwrapEnvelope()` below
 *   strips it before any field is read. (The list endpoint, `GET /cards`,
 *   does NOT have this problem — it returns `{ data: [...cards], pagination
 *   }` where `data` is already the array PokeTraceCatalogueProvider.ts
 *   expects.)
 * - The raw/ungraded tier's real key is `"NEAR_MINT"`, and the four PSA
 *   tiers this project uses are `"PSA_7"`, `"PSA_8"`, `"PSA_9"`, `"PSA_10"`
 *   — confirmed by inspecting a live Charizard response's full tier list
 *   (which also included many tiers this project doesn't use yet: BGS/CGC/
 *   SGC/TAG grading companies, half-point PSA grades, and condition tiers
 *   like DAMAGED/LIGHTLY_PLAYED). The candidate lists below already matched
 *   these correctly (case-insensitively) even before this was confirmed —
 *   the real literals are now listed first, explicitly, for clarity.
 * - Each card carries its own `currency` field directly (e.g. `"USD"`) —
 *   no need to derive it from the `market` ('US'/'EU') field via a lookup
 *   table. `marketCurrencyMap`/`defaultCurrency` are kept as a fallback
 *   only, for the case a future response is missing `currency`.
 * - The real per-card timestamp field is `lastUpdated`, not `updatedAt`
 *   (the previous code read `updatedAt`, which doesn't exist on the real
 *   response, so `priceTimestamp` was always silently falling back to
 *   "now" instead of the real value).
 *
 * STILL NOT VERIFIED: whether the Card object exposes a historical PSA
 * gem-rate field at all — none appeared in the sampled response, so
 * `historicalGemRate` stays null rather than fabricated. Also not
 * exercised by the live smoke test: `GET /sets` (see
 * PokeTraceCatalogueProvider.ts, still on the spec-only candidate-list
 * approach) and the exact `pagination` object field names for cursor-based
 * paging (not needed for this smoke test's tiny single-page sample).
 *
 * Isolated entirely to this file per the provider-abstraction pattern — if
 * PokeTrace's contract turns out to differ further, or the project swaps to
 * PriceCharting/PkmnPrices/Cardmarket, only this file (and
 * PokeTraceCatalogueProvider.ts) changes.
 */
export class PokeTraceProvider implements MarketDataProvider {
  readonly name = "poketrace";

  constructor(private readonly config: PokeTraceConfig) {}

  async getSnapshotByProviderId(providerCardId: string): Promise<MarketSnapshotResult | null> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const url = new URL(`/v1/cards/${encodeURIComponent(providerCardId)}`, this.config.baseUrl);

    const response = await fetchWithBackoff(() =>
      doFetch(url.toString(), {
        headers: { "X-API-Key": this.config.apiKey, Accept: "application/json" },
      }),
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`PokeTrace GET /cards/${providerCardId} failed: ${response.status} ${response.statusText}`);
    }

    const rawBody = (await response.json()) as Record<string, unknown>;
    const body = unwrapEnvelope(rawBody) as unknown as PokeTraceCardDetail;
    return this.toSnapshot(providerCardId, body);
  }

  /**
   * PokeTrace's documented contract has no batch-by-ID endpoint (only
   * batch LOOKUP via tcgplayer_ids/cardmarket_ids on GET /cards, which
   * doesn't help once we already hold PokeTrace's own IDs) — sequential
   * fallback, same as the interface default, kept explicit here so the
   * gap is visible rather than silently inherited.
   */
  async getSnapshotsBatch(providerCardIds: string[]): Promise<Map<string, MarketSnapshotResult>> {
    const results = new Map<string, MarketSnapshotResult>();
    for (const id of providerCardIds) {
      const snapshot = await this.getSnapshotByProviderId(id);
      if (snapshot) results.set(id, snapshot);
    }
    return results;
  }

  private toSnapshot(providerCardId: string, body: PokeTraceCardDetail): MarketSnapshotResult | null {
    const picked = pickSource(body.prices);
    if (!picked) return null;

    const rawTier = findTierPrice(picked.tiers, RAW_TIER_CANDIDATES);
    const psa7Tier = findTierPrice(picked.tiers, PSA_TIER_CANDIDATES[7]);
    const psa8Tier = findTierPrice(picked.tiers, PSA_TIER_CANDIDATES[8]);
    const psa9Tier = findTierPrice(picked.tiers, PSA_TIER_CANDIDATES[9]);
    const psa10Tier = findTierPrice(picked.tiers, PSA_TIER_CANDIDATES[10]);

    if (!rawTier && !psa7Tier && !psa8Tier && !psa9Tier && !psa10Tier) {
      // Nothing recognizable in any candidate tier key — rather than
      // fabricate a snapshot from zero data, treat this like "no data".
      return null;
    }

    // CONFIRMED live: the card carries its own `currency` field directly —
    // prefer it over deriving from `market`, which is now only a fallback
    // for the case a future response omits `currency`.
    const currency =
      body.currency ??
      this.config.marketCurrencyMap?.[body.market ?? ""] ??
      DEFAULT_MARKET_CURRENCY_MAP[body.market ?? ""] ??
      this.config.defaultCurrency ??
      "USD";
    const fxRates = this.config.fxRates ?? DEFAULT_FX_RATES;
    const convert = (v: number | null | undefined): number | null =>
      v === null || v === undefined ? null : convertToGbp(v, currency, fxRates);

    // GET /cards/{id} returns provider-side AGGREGATED stats (avg/median
    // over windows), not a raw list of individual sold comps — unlike the
    // old fabricated /lookup contract, there is nothing here for this
    // project's own IQR outlier trimming (../market/outliers.ts) to run
    // against, so `outliersExcluded` is always 0 from this adapter. That
    // utility remains available/tested for any future provider that does
    // return raw comp lists (or for GET /cards/{id}/listings, which is
    // gated to PokeTrace's Scale plan and not wired in here).
    const sampleSize = rawTier?.saleCount ?? maxSaleCount(psa7Tier, psa8Tier, psa9Tier, psa10Tier);
    const confidence = rawTier?.confidence ?? fallbackConfidence(sampleSize);

    return {
      providerCardId,
      sourceProvider: this.name,
      // CONFIRMED live: the real field is `lastUpdated`, not `updatedAt` —
      // `updatedAt` is kept as a fallback in case an older/alternate
      // response shape still uses it, but is never the primary source now.
      priceTimestamp: body.lastUpdated ?? body.updatedAt ?? new Date().toISOString(),
      rawMarketPrice: convert(rawTier?.avg ?? null),
      // "Quick sale value" ~ a faster-moving, more conservative figure than
      // the headline average — prefer a short trailing median, falling
      // back sensibly as fewer window stats are populated.
      rawQsv: convert(rawTier?.median7d ?? rawTier?.avg7d ?? rawTier?.low ?? rawTier?.avg ?? null),
      psa7: convert(psa7Tier?.avg ?? null),
      psa8: convert(psa8Tier?.avg ?? null),
      psa9: convert(psa9Tier?.avg ?? null),
      psa10: convert(psa10Tier?.avg ?? null),
      confidence: clamp01(confidence),
      liquidity: classifyLiquidity(sampleSize ?? 0),
      sampleSize: sampleSize ?? null,
      // Not present anywhere in the documented Card schema — left null
      // rather than fabricated.
      historicalGemRate: null,
      outliersExcluded: 0,
      sourceCurrency: currency,
      rawPayload: body,
    };
  }
}

// ---------------------------------------------------------------------------
// Verified-shape types (per the OpenAPI spec) + the defensive tier lookup
// for the one unverified leaf (exact tier key literals). See the class
// doc-comment above for what is/isn't confirmed.
// ---------------------------------------------------------------------------

interface PokeTraceTierPrice {
  avg?: number | null;
  low?: number | null;
  high?: number | null;
  trend?: string | null;
  confidence?: number | null;
  saleCount?: number | null;
  avg1d?: number | null;
  avg7d?: number | null;
  avg30d?: number | null;
  median3d?: number | null;
  median7d?: number | null;
  median30d?: number | null;
  country?: string | null;
  language?: string | null;
}

interface PokeTraceCardDetail {
  id: string;
  name?: string;
  market?: string; // 'US' | 'EU'
  /** CONFIRMED live (e.g. "USD") — see class doc-comment. */
  currency?: string;
  conditionOptions?: string[];
  gradedOptions?: string[];
  hasGraded?: boolean;
  /** [source][tier] -> TierPrice. Open map per the spec — no enum for either key. */
  prices?: Record<string, Record<string, PokeTraceTierPrice>>;
  /** CONFIRMED live — the real per-card timestamp field. */
  lastUpdated?: string;
  /** Not present on the real response — kept only as a defensive fallback. */
  updatedAt?: string;
}

/**
 * PokeTrace wraps a single-object response (e.g. `GET /cards/{id}`) as
 * `{ data: {...} }` — CONFIRMED live, see class doc-comment. The list
 * endpoint (`GET /cards`) does not have this problem: it returns `data` as
 * the array directly, no extra unwrap needed there.
 */
function unwrapEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "data" && typeof body.data === "object" && body.data !== null && !Array.isArray(body.data)) {
    return body.data as Record<string, unknown>;
  }
  return body;
}

/** Preference order when a card has price data from multiple sources. */
const SOURCE_PRIORITY = ["ebay", "tcgplayer", "cardmarket", "cardmarket_unsold"];

/** CONFIRMED live literal is "NEAR_MINT" (listed first); older guesses kept as a defensive fallback. */
const RAW_TIER_CANDIDATES = ["NEAR_MINT", "raw", "ungraded", "near_mint", "nm", "loose"];

/** CONFIRMED live literals are "PSA_7"/"PSA_8"/"PSA_9"/"PSA_10" (listed first); older guesses kept as a defensive fallback. */
const PSA_TIER_CANDIDATES: Record<7 | 8 | 9 | 10, string[]> = {
  7: ["PSA_7", "psa_7", "psa7"],
  8: ["PSA_8", "psa_8", "psa8"],
  9: ["PSA_9", "psa_9", "psa9"],
  10: ["PSA_10", "psa_10", "psa10"],
};

function pickSource(
  prices: Record<string, Record<string, PokeTraceTierPrice>> | undefined,
): { sourceKey: string; tiers: Record<string, PokeTraceTierPrice> } | null {
  if (!prices) return null;
  for (const key of SOURCE_PRIORITY) {
    if (prices[key] && Object.keys(prices[key]).length > 0) {
      return { sourceKey: key, tiers: prices[key] };
    }
  }
  const firstKey = Object.keys(prices)[0];
  return firstKey ? { sourceKey: firstKey, tiers: prices[firstKey]! } : null;
}

function findTierPrice(tiers: Record<string, PokeTraceTierPrice>, candidates: string[]): PokeTraceTierPrice | null {
  const byLowerKey = new Map(Object.entries(tiers).map(([k, v]) => [k.toLowerCase(), v]));
  for (const candidate of candidates) {
    const hit = byLowerKey.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

function maxSaleCount(...tiers: (PokeTraceTierPrice | null)[]): number | null {
  const counts = tiers.map((t) => t?.saleCount).filter((n): n is number => typeof n === "number");
  return counts.length ? Math.max(...counts) : null;
}

/** Used only when a tier has no `confidence` field of its own. */
function fallbackConfidence(sampleSize: number | null): number {
  if (sampleSize === null) return 0.3; // some price data exists but no sample-size signal — low-moderate trust
  return Math.min(1, sampleSize / 20);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
