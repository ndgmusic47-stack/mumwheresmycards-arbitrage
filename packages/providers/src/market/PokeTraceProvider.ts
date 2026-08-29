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
 * v1.7.0) rather than guessed — replaces the previous best-effort
 * `/v1/cards/lookup` implementation, which queried an endpoint that does
 * not exist in the real API.
 *
 * VERIFIED from the spec: base URL, `X-API-Key` auth header, `GET
 * /cards/{id}` returning a Card with a `prices[source][tier]` map of
 * TierPrice objects (avg/low/high/trend/confidence/saleCount/avg1d/avg7d/
 * avg30d/median3d/median7d/median30d/country/language), and 429 responses
 * carrying `Retry-After`/`X-RateLimit-Reset` (handled by ../http/backoff.ts).
 *
 * NOT VERIFIED (documented gap — do not treat as fact): the exact literal
 * key strings used for the raw/ungraded tier and for each graded PSA tier
 * inside that map. The spec defines `prices` as an open
 * (`additionalProperties`) map with no enum and ships no example response
 * bodies, so there's no primary-source way to confirm exact casing (e.g.
 * "raw" vs "ungraded" vs "NEAR_MINT"; "PSA_10" vs "PSA10") without an
 * authenticated call. Per "do not guess / do not fabricate", this adapter
 * does NOT hardcode a single assumed literal — it searches a short,
 * case-insensitive list of plausible candidates per tier (see
 * RAW_TIER_CANDIDATES / psaTierCandidates below) and simply finds nothing
 * for that tier if none match. SPOT-CHECK THIS against one real response
 * before relying on it, and add the confirmed literal as the first
 * candidate once known.
 *
 * ALSO NOT VERIFIED: whether the Card object exposes a historical PSA
 * gem-rate field at all — none appears in the spec, so `historicalGemRate`
 * is always null from this adapter (never fabricated).
 *
 * Isolated entirely to this file per the provider-abstraction pattern — if
 * PokeTrace's contract turns out to differ once tested against a real key,
 * or the project swaps to PriceCharting/PkmnPrices/Cardmarket, only this
 * file (and PokeTraceCatalogueProvider.ts) changes.
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

    const body = (await response.json()) as PokeTraceCardDetail;
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

    const currency =
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
      priceTimestamp: body.updatedAt ?? new Date().toISOString(),
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
  conditionOptions?: string[];
  gradedOptions?: string[];
  hasGraded?: boolean;
  /** [source][tier] -> TierPrice. Open map per the spec — no enum for either key. */
  prices?: Record<string, Record<string, PokeTraceTierPrice>>;
  updatedAt?: string;
}

/** Preference order when a card has price data from multiple sources. */
const SOURCE_PRIORITY = ["ebay", "tcgplayer", "cardmarket", "cardmarket_unsold"];

/** UNVERIFIED — candidate literals for the raw/ungraded tier, most-likely first. */
const RAW_TIER_CANDIDATES = ["raw", "ungraded", "near_mint", "nm", "loose"];

/** UNVERIFIED — candidate literals per PSA grade, most-likely first. */
const PSA_TIER_CANDIDATES: Record<7 | 8 | 9 | 10, string[]> = {
  7: ["psa_7", "psa7"],
  8: ["psa_8", "psa8"],
  9: ["psa_9", "psa9"],
  10: ["psa_10", "psa10"],
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
