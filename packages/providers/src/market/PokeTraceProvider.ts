import type { FxRates, QsvSettings } from "@mwmc/core";
import { convertToGbp, DEFAULT_FX_RATES, computeQsv, graderIdForTierKey, normaliseTierKey } from "@mwmc/core";
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
  /** QSV derivation settings (haircut, confidence penalties) — see
   *  @mwmc/core market/qsv.ts. Defaults to DEFAULT_QSV_SETTINGS. */
  qsvSettings?: QsvSettings;
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
    const psa6Tier = findTierPrice(picked.tiers, PSA_TIER_CANDIDATES[6]);
    const psa7Tier = findTierPrice(picked.tiers, PSA_TIER_CANDIDATES[7]);
    const psa8Tier = findTierPrice(picked.tiers, PSA_TIER_CANDIDATES[8]);
    const psa9Tier = findTierPrice(picked.tiers, PSA_TIER_CANDIDATES[9]);
    const psa10Tier = findTierPrice(picked.tiers, PSA_TIER_CANDIDATES[10]);

    // psa6Tier joined this guard on 2026-09-13. It was the only tier read
    // and then excluded from the check, which is what let a card with a
    // PSA 6 price and nothing else fall through as "no data".
    if (!rawTier && !psa6Tier && !psa7Tier && !psa8Tier && !psa9Tier && !psa10Tier) {
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
    const convertTier = (tier: PokeTraceTierPrice | undefined): number | null => convert(tier?.avg ?? null);

    /*
     * EVERY graded tier the provider returned, not just the five above.
     *
     * A live smoke test (2026-09-12) showed PokeTrace returns roughly thirty
     * graded prices for a single card — PSA 3 through 10 including half
     * grades, plus SGC 3-9 and TAG 2-10 — of which this adapter was reading
     * five. Every low grade was discarded, which is why nothing downstream
     * could answer "does this still pay if it comes back a 5".
     *
     * Captured RAW, keyed by the provider's own tier key. Mapping a tier onto
     * a published grade scale is @mwmc/core's job (gradedTierKeys.ts) and is
     * deliberately not done here: storing the observation whole means a tier
     * that maps to no rung today still connects the day a scale is extended,
     * with no re-scan.
     *
     * The five named fields above are kept exactly as they were. Nothing
     * downstream changes behaviour until it opts in to this map.
     */
    const gradedPrices: Record<string, number> = {};
    for (const [tierKey, tier] of Object.entries(picked.tiers)) {
      if (!graderIdForTierKey(tierKey)) continue;
      const gbp = convertTier(tier);
      if (gbp !== null) gradedPrices[normaliseTierKey(tierKey)] = gbp;
    }

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

    /*
     * ─────────────────────────────────────────────────────────────────────
     * HOW MANY SALES ARE BEHIND EACH GRADE — 2026-09-13.
     *
     * Until now exactly one sample size survived this adapter: the RAW
     * tier's. It was then carried downstream and displayed as `slabLiquidity`
     * and tested against the GRADE qualification's confidence bar. A PSA 10
     * price standing on one sale a year was presented with the liquidity of
     * a raw card that sells weekly.
     *
     * That is not a display bug. It is the reason a price guide's
     * extrapolated "PSA 9: £591" — a number its own publisher marks as an
     * estimate — could reach the top of the actionable feed.
     *
     * The provider has the answer per tier and always has. It is now carried
     * whole, so a grade's price and the evidence behind it travel together
     * and downstream code can refuse one without the other.
     * ─────────────────────────────────────────────────────────────────────
     */
    const gradedSaleCounts: Record<string, number> = {};
    for (const [tierKey, tier] of Object.entries(picked.tiers)) {
      if (!graderIdForTierKey(tierKey)) continue;
      if (typeof tier.saleCount === "number" && Number.isFinite(tier.saleCount)) {
        gradedSaleCounts[normaliseTierKey(tierKey)] = tier.saleCount;
      }
    }

    /*
     * SLAB VALUES NOW USE THE SAME STATISTIC AS THE RAW SIDE.
     *
     * The raw price takes the LOWER of the 7-day and 30-day sold medians,
     * for the reason stated below: an average is exactly the statistic one
     * mis-listed bundle distorts. Every slab value took `.avg` anyway — no
     * median, no window, no haircut — so every grade profit in the tool was
     * an optimistic estimate minus a deliberately conservative basis.
     *
     * `gradedValue` applies the raw rule to a graded tier. It falls back to
     * `.avg` only when the provider gives no median at all, and says so via
     * `estimated`, so a value the model had to guess at is never
     * indistinguishable from one it measured.
     *
     * No haircut is applied here. The quick-sale haircut is a QSV concept —
     * it models selling a raw card fast — and applying it to a slab would be
     * inventing a second discount the operator never asked for. What matters
     * is that the STATISTIC is now honest.
     *
     * ------------------------------------------------------------------
     * WIDENED TO EVERY WINDOW, 2026-09-13, against live production data.
     *
     * Taking the lower of the two medians was a real improvement and it was
     * not enough. Measured against PriceCharting on three cards, grades 6-9
     * came out within a few percent — and PSA 10 was 55%, 93% and 345% too
     * high. The cause is visible in the provider's own payload for Pikachu
     * EX XY124:
     *
     *   PSA_10: avg 88988, median7d 88988, median30d 54493.5,
     *           avg1d 19999, saleCount 34, low === high === 88988
     *
     * 19,999 is the true market price. `low === high` on 34 claimed sales is
     * the signature of one freak sale owning the whole aggregate, and it had
     * captured BOTH medians. Sale counts on that card run 149/227/148 at
     * grades 6/7/8 and collapse to 34 at grade 10: the thinnest tier has the
     * fattest tail, and it is the tier every "upside" figure leans on.
     *
     * The adapter cannot trim outliers itself — PokeTrace returns
     * pre-aggregated statistics, not comp lists (see the note further down
     * on `outliersExcluded`). So the only defence available here is WHICH
     * aggregate to believe, and the answer is the lowest one the provider
     * offers across every window it reported. On the payload above that
     * yields 19,999 — the correct figure — and on grades 6-9 it moves each
     * value by only a few percent, all of them towards the market:
     *
     *   PSA 7: 535   -> 469.61  (market 478.50)
     *   PSA 8: 1096  -> 988.89  (market 1012.50)
     *   PSA 9: 5110  -> 3625    (market 3850)
     *
     * THE TRADE-OFF, STATED PLAINLY. This biases low, and a single cheap
     * day can now pull a tier down. That is the direction to be wrong in:
     * an understated slab value costs a trade not taken, an overstated one
     * costs real money on a card that cannot pay it back. It is the same
     * asymmetry the raw side already resolves the same way.
     */
    const gradedValue = (
      tier: PokeTraceTierPrice | null | undefined,
    ): { gbp: number | null; estimated: boolean } => {
      if (!tier) return { gbp: null, estimated: false };
      // Every central estimate the provider gave for this tier. `low`/`high`
      // are deliberately excluded — they are the extremes themselves, not an
      // estimate of the middle, and using `low` would be a discount rather
      // than a measurement.
      const measured = [tier.median3d, tier.median7d, tier.median30d, tier.avg1d, tier.avg7d, tier.avg30d]
        .map((v) => convert(v ?? null))
        .filter((v): v is number => v !== null);
      if (measured.length > 0) return { gbp: Math.min(...measured), estimated: false };
      // Nothing windowed at all: the flat average is the only thing on offer,
      // and it is labelled an estimate exactly as before.
      return { gbp: convert(tier.avg ?? null), estimated: true };
    };

    const psa6Value = gradedValue(psa6Tier);
    const psa7Value = gradedValue(psa7Tier);
    const psa8Value = gradedValue(psa8Tier);
    const psa9Value = gradedValue(psa9Tier);
    const psa10Value = gradedValue(psa10Tier);

    /** Grades whose price is a provider average because no median existed. */
    const estimatedGrades = ([[6, psa6Value], [7, psa7Value], [8, psa8Value], [9, psa9Value], [10, psa10Value]] as const)
      .filter(([, v]) => v.gbp !== null && v.estimated)
      .map(([grade]) => grade);

    /*
     * ─────────────────────────────────────────────────────────────────────
     * A CONFIDENCE THAT IS ABOUT THE SLABS — 2026-09-13.
     *
     * `confidence` above is the RAW tier's, and until now it was the only
     * one. Live, that produced a Pikachu EX XY124 row reading "100%
     * confidence, VERY_HIGH liquidity" — both earned by 110 raw sales — set
     * directly beside a PSA 10 of £65,878 standing on 34. The number was not
     * wrong about anything; it was answering a different question from the
     * one the screen appeared to be asking.
     *
     * A slab price deserves its own answer, and there are two things worth
     * knowing about it:
     *
     *   HOW MUCH evidence — the tier's own sale count, not the raw tier's.
     *   HOW CONSISTENT   — whether the provider's windows agree with each
     *                      other. Measured as min/max across every central
     *                      estimate the tier reported.
     *
     * The second is what actually separates a sound tier from a poisoned one
     * in the real data. On the Pikachu payload the agreement ratios come out
     * PSA 6 0.90, PSA 7 0.85, PSA 8 0.79, PSA 9 0.56 — and PSA 10 0.22,
     * because its windows range from 19,999 to 88,988. Sale count alone
     * cannot see that: 34 sales saturates any count-based scale.
     *
     * The row takes the WEAKEST priced grade, because a ladder is only as
     * trustworthy as the rung you end up selling on, and which rung that
     * will be is not known here. Where a grade has no price at all it is
     * skipped rather than counted as zero — absent evidence is not evidence.
     * ─────────────────────────────────────────────────────────────────────
     */
    const gradedConfidence = weakestGradedConfidence([
      [psa6Tier, psa6Value.gbp],
      [psa7Tier, psa7Value.gbp],
      [psa8Tier, psa8Value.gbp],
      [psa9Tier, psa9Value.gbp],
      [psa10Tier, psa10Value.gbp],
    ], convert);

    // SOLD medians, carried through unconverted-then-converted but never
    // blended here. The QSV rule (lower of the two windows, then a
    // quick-sale haircut) belongs in one place — @mwmc/core's computeQsv —
    // so the adapter's only job is to hand over honest inputs.
    //
    // `avg7d`/`avg30d` are deliberately NOT used as median substitutes: an
    // average is exactly the statistic a single mis-listed bundle or graded
    // card sold as raw distorts, which is why the model asks for medians.
    const rawMedian7d = convert(rawTier?.median7d ?? null);
    const rawMedian30d = convert(rawTier?.median30d ?? null);
    const qsv = computeQsv(
      {
        median7d: rawMedian7d,
        median30d: rawMedian30d,
        // Last-resort reference only — flagged as low-confidence by the
        // model itself, never presented as an executable QSV.
        fallbackReference: convert(rawTier?.avg ?? null),
        baseConfidence: clamp01(confidence),
      },
      this.config.qsvSettings,
    );

    return {
      providerCardId,
      sourceProvider: this.name,
      // CONFIRMED live: the real field is `lastUpdated`, not `updatedAt` —
      // `updatedAt` is kept as a fallback in case an older/alternate
      // response shape still uses it, but is never the primary source now.
      priceTimestamp: body.lastUpdated ?? body.updatedAt ?? new Date().toISOString(),
      rawMarketPrice: convert(rawTier?.avg ?? null),
      rawMedian7d,
      rawMedian30d,
      rawQsv: qsv.qsv,
      qsvBasis: qsv.basis,
      isHighConfidenceQsv: qsv.isHighConfidenceQsv,
      psa6: psa6Value.gbp,
      psa7: psa7Value.gbp,
      psa8: psa8Value.gbp,
      psa9: psa9Value.gbp,
      psa10: psa10Value.gbp,
      gradedPrices,
      gradedSaleCounts,
      estimatedGrades,
      psaSaleCounts: {
        6: psa6Tier?.saleCount ?? null,
        7: psa7Tier?.saleCount ?? null,
        8: psa8Tier?.saleCount ?? null,
        9: psa9Tier?.saleCount ?? null,
        10: psa10Tier?.saleCount ?? null,
      },
      // QSV confidence already carries any single-median / fallback penalty.
      // This one is about the RAW card and is only ever right for the raw
      // side — see gradedConfidence below.
      confidence: qsv.qsv !== null ? qsv.confidence : clamp01(confidence),
      gradedConfidence,
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
const PSA_TIER_CANDIDATES: Record<6 | 7 | 8 | 9 | 10, string[]> = {
  6: ["PSA_6", "psa_6", "psa6"],
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

/**
 * How much the provider's own windows agree with each other for one tier,
 * as min/max across every central estimate it reported: 1.0 is perfect
 * agreement, 0.22 is the Pikachu PSA 10 whose windows ran 19,999 to 88,988.
 *
 * Returns null when there is nothing to compare — one window, or none. A
 * single window is not evidence of agreement OR of disagreement, and
 * scoring it either way would be inventing a reading.
 */
export function tierPriceAgreement(values: number[]): number | null {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  if (positive.length < 2) return null;
  const min = Math.min(...positive);
  const max = Math.max(...positive);
  return max === 0 ? null : min / max;
}

/**
 * The graded side's own confidence: the weakest priced named grade, scored
 * on its evidence count AND on whether its windows agree. See the long note
 * at the call site for why both, and why the weakest rung sets the row.
 *
 * Null when no named grade has a price — the caller then has nothing to say
 * about the slabs and must not borrow the raw tier's answer instead.
 */
function weakestGradedConfidence(
  graded: [PokeTraceTierPrice | null | undefined, number | null][],
  convert: (v: number | null | undefined) => number | null,
): number | null {
  let weakest: number | null = null;
  for (const [tier, price] of graded) {
    if (!tier || price === null) continue;
    const windows = [tier.median3d, tier.median7d, tier.median30d, tier.avg1d, tier.avg7d, tier.avg30d]
      .map((v) => convert(v ?? null))
      .filter((v): v is number => v !== null);
    const agreement = tierPriceAgreement(windows);
    const count = fallbackConfidence(typeof tier.saleCount === "number" ? tier.saleCount : null);
    // A tier with only one window keeps its count-based score untouched
    // rather than being penalised for a comparison that could not be made.
    const score = clamp01(agreement === null ? count : count * agreement);
    if (weakest === null || score < weakest) weakest = score;
  }
  return weakest;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
