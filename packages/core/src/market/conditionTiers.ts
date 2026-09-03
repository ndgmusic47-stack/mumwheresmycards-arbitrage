import { convertToGbp, DEFAULT_FX_RATES, type FxRates } from "./currency.js";

export interface ConditionTierPrices {
  damaged: number | null;
  heavilyPlayed: number | null;
  moderatelyPlayed: number | null;
  lightlyPlayed: number | null;
  nearMint: number | null;
  /** The PokeTrace price source these came from (e.g. "ebay", "tcgplayer")
   *  — surfaced so a human can judge how much to trust a thin comp source,
   *  same spirit as the existing liquidity/sample-size disclosures. */
  source: string | null;
}

const EMPTY_CONDITION_TIER_PRICES: ConditionTierPrices = {
  damaged: null,
  heavilyPlayed: null,
  moderatelyPlayed: null,
  lightlyPlayed: null,
  nearMint: null,
  source: null,
};

/** Preference order when a card has price data from multiple sources —
 *  mirrors PokeTraceProvider.ts's own SOURCE_PRIORITY exactly (kept in
 *  sync manually; see this file's doc comment for why it isn't imported
 *  instead). */
const SOURCE_PRIORITY = ["ebay", "tcgplayer", "cardmarket", "cardmarket_unsold"];

const CONDITION_TIER_CANDIDATES: Record<Exclude<keyof ConditionTierPrices, "source">, string[]> = {
  damaged: ["DAMAGED"],
  heavilyPlayed: ["HEAVILY_PLAYED"],
  moderatelyPlayed: ["MODERATELY_PLAYED"],
  lightlyPlayed: ["LIGHTLY_PLAYED"],
  nearMint: ["NEAR_MINT"],
};

interface RawTierPrice {
  avg?: number | null;
}

interface RawPokeTracePricesBody {
  currency?: string;
  prices?: Record<string, Record<string, RawTierPrice>>;
}

/**
 * SOURCING WORKFLOW item 8 (condition truth layer): extracts PokeTrace's
 * real per-condition raw-card pricing (DAMAGED / HEAVILY_PLAYED /
 * MODERATELY_PLAYED / LIGHTLY_PLAYED / NEAR_MINT) from a market_snapshots
 * row's `raw_payload` column — the FULL PokeTrace card-detail response,
 * stored verbatim on every snapshot since migration 0002, explicitly for
 * audit. PokeTraceProvider.ts's own toSnapshot() only ever reads the
 * NEAR_MINT tier out of this same payload (as "the" raw market price) —
 * confirmed live via a real smoke test
 * (apps/worker/scripts/poketrace-smoke-test.ts, run 2026-09-02) that every
 * sampled card's `prices[source]` object also carries four OTHER raw
 * condition tiers, each with its own real sale data (avg/median/saleCount)
 * behind it, not just NEAR_MINT.
 *
 * This is deliberately a READ-TIME extraction from the already-stored
 * payload, not a new persisted column: every card profiled before this
 * feature shipped already has this data sitting in raw_payload, captured
 * but unused, so pulling it out here means the whole existing catalogue
 * benefits immediately — no migration, no provider change, no re-scan.
 *
 * Mirrors PokeTraceProvider.ts's own pickSource()/findTierPrice() logic
 * (SOURCE_PRIORITY, case-insensitive tier-key lookup) deliberately
 * duplicated rather than imported: packages/core has no dependency on
 * packages/providers anywhere else in this workspace, and this is a small,
 * stable enough contract that inverting the dependency graph for one
 * function isn't worth it.
 *
 * Returns all-null (never a fabricated zero) if raw_payload is missing,
 * unparseable, or has no recognisable `prices` object.
 */
export function extractConditionTierPrices(rawPayload: unknown, fxRates: FxRates = DEFAULT_FX_RATES): ConditionTierPrices {
  if (!rawPayload || typeof rawPayload !== "object") return EMPTY_CONDITION_TIER_PRICES;
  const body = rawPayload as RawPokeTracePricesBody;
  if (!body.prices) return EMPTY_CONDITION_TIER_PRICES;

  let sourceKey: string | null = null;
  let tiers: Record<string, RawTierPrice> | null = null;
  for (const key of SOURCE_PRIORITY) {
    if (body.prices[key] && Object.keys(body.prices[key]).length > 0) {
      sourceKey = key;
      tiers = body.prices[key];
      break;
    }
  }
  if (!tiers) {
    const firstKey = Object.keys(body.prices)[0];
    const firstTiers = firstKey ? body.prices[firstKey] : undefined;
    if (firstKey && firstTiers && Object.keys(firstTiers).length > 0) {
      sourceKey = firstKey;
      tiers = firstTiers;
    }
  }
  if (!tiers) return EMPTY_CONDITION_TIER_PRICES;

  const byLowerKey = new Map(Object.entries(tiers).map(([k, v]) => [k.toLowerCase(), v]));
  // CONFIRMED live (see class doc comment on PokeTraceProvider.ts): every
  // card carries its own `currency` field directly. Same "USD" fallback
  // the provider itself uses.
  const currency = body.currency ?? "USD";

  function findAvg(candidates: string[]): number | null {
    for (const candidate of candidates) {
      const hit = byLowerKey.get(candidate.toLowerCase());
      if (hit && typeof hit.avg === "number") {
        return convertToGbp(hit.avg, currency, fxRates);
      }
    }
    return null;
  }

  return {
    damaged: findAvg(CONDITION_TIER_CANDIDATES.damaged),
    heavilyPlayed: findAvg(CONDITION_TIER_CANDIDATES.heavilyPlayed),
    moderatelyPlayed: findAvg(CONDITION_TIER_CANDIDATES.moderatelyPlayed),
    lightlyPlayed: findAvg(CONDITION_TIER_CANDIDATES.lightlyPlayed),
    nearMint: findAvg(CONDITION_TIER_CANDIDATES.nearMint),
    source: sourceKey,
  };
}
