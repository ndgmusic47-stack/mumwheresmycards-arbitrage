import type { RawCardIdentity } from "@mwmc/core";
import type { MarketSnapshotResult } from "../market/MarketDataProvider.js";

/**
 * Mock market-data fixtures, keyed by PROVIDER card ID — matching the real
 * PokeTrace contract's lookup key (GET /cards/{id}), not our internal
 * printingHash. `identity` is kept alongside each entry so tests/dev can
 * still resolve a full CardPrinting when they need one (e.g. to exercise
 * the opportunity engine), and so packages/providers/src/fixtures/catalogue.fixtures.ts
 * can share the same provider-card-id space for an end-to-end mock flow
 * (catalogue sync -> external_card_refs -> market lookup).
 */
export interface MarketFixtureEntry {
  providerCardId: string;
  identity: RawCardIdentity;
  snapshot: Omit<MarketSnapshotResult, "providerCardId" | "sourceProvider">;
}

export const MARKET_FIXTURES: MarketFixtureEntry[] = [
  {
    // Grading-arbitrage archetype: high PSA10 upside, deep raw discount available on eBay.
    providerCardId: "pt_charizard_bs_4_102_1st_holo",
    identity: {
      game: "pokemon",
      name: "Charizard",
      setName: "Base Set",
      setCode: "BS",
      cardNumber: "4/102",
      year: 1999,
      language: "EN",
      edition: "1st",
      variant: "holo",
      finish: "shadowless",
      rarity: "Holo Rare",
    },
    snapshot: {
      priceTimestamp: "2026-08-20T00:00:00.000Z",
      rawMarketPrice: 3200,
      // Sold medians drive QSV: min(7d, 30d) less the 8% quick-sale haircut.
      rawMedian7d: 3100,
      rawMedian30d: 3000,
      rawQsv: 2760,
      qsvBasis: "BOTH_SOLD_MEDIANS",
      isHighConfidenceQsv: true,
      psa7: 4200,
      psa8: 6800,
      psa9: 10800,
      psa10: 32000,
      confidence: 0.82,
      liquidity: "MEDIUM",
      sampleSize: 14,
      psaPopulation: { 7: 812, 8: 2140, 9: 3670, 10: 121 },
      historicalGemRate: 0.012,
      outliersExcluded: 2,
    },
  },
  {
    // Underpriced-flip archetype: modern, liquid, thin margins unless bought right.
    providerCardId: "pt_umbreon_vmax_evs_215_203_holo",
    identity: {
      game: "pokemon",
      name: "Umbreon VMAX",
      setName: "Evolving Skies",
      setCode: "EVS",
      cardNumber: "215/203",
      year: 2021,
      language: "EN",
      edition: "na",
      variant: "holo",
      finish: "na",
      rarity: "Secret Rare",
    },
    snapshot: {
      priceTimestamp: "2026-08-27T00:00:00.000Z",
      rawMarketPrice: 210,
      rawMedian7d: 200,
      rawMedian30d: 205,
      rawQsv: 184,
      qsvBasis: "BOTH_SOLD_MEDIANS",
      isHighConfidenceQsv: true,
      psa7: 220,
      psa8: 260,
      psa9: 340,
      psa10: 620,
      confidence: 0.91,
      liquidity: "VERY_HIGH",
      sampleSize: 63,
      psaPopulation: { 7: 940, 8: 3820, 9: 9210, 10: 4310 },
      historicalGemRate: 0.19,
      outliersExcluded: 5,
    },
  },
  {
    // Low-liquidity / low-confidence archetype: should mostly get filtered out by defaults.
    providerCardId: "pt_mewtwo_bs_10_102_unl_holo",
    identity: {
      game: "pokemon",
      name: "Mewtwo",
      setName: "Base Set",
      setCode: "BS",
      cardNumber: "10/102",
      year: 1999,
      language: "EN",
      edition: "unlimited",
      variant: "holo",
      finish: "unlimited_shadow",
      rarity: "Holo Rare",
    },
    snapshot: {
      priceTimestamp: "2026-08-10T00:00:00.000Z",
      rawMarketPrice: 65,
      // Only a 30-day median available — single-median path, reduced confidence.
      rawMedian7d: null,
      rawMedian30d: 60,
      rawQsv: 55.2,
      qsvBasis: "THIRTY_DAY_SOLD_MEDIAN_ONLY",
      isHighConfidenceQsv: true,
      psa7: 70,
      psa8: 95,
      psa9: 140,
      psa10: 410,
      confidence: 0.45,
      liquidity: "LOW",
      sampleSize: 3,
      psaPopulation: { 7: 2100, 8: 5400, 9: 8600, 10: 640 },
      historicalGemRate: 0.041,
      outliersExcluded: 0,
    },
  },
];

const BY_PROVIDER_ID = new Map(MARKET_FIXTURES.map((f) => [f.providerCardId, f.snapshot]));
const BY_PROVIDER_ID_IDENTITY = new Map(MARKET_FIXTURES.map((f) => [f.providerCardId, f.identity]));

/** Keyed by provider card ID — used by MockMarketProvider. */
export const MARKET_FIXTURES_BY_PROVIDER_ID: Map<string, Omit<MarketSnapshotResult, "providerCardId" | "sourceProvider">> =
  BY_PROVIDER_ID;

/** Convenience lookup from provider card ID back to its identity, e.g. for building the mock catalogue provider. */
export const MARKET_FIXTURE_IDENTITY_BY_PROVIDER_ID: Map<string, RawCardIdentity> = BY_PROVIDER_ID_IDENTITY;

/** Convenience export of just the identities — retained for any test that only needs a resolvable RawCardIdentity[]. */
export const MARKET_FIXTURE_IDENTITIES: RawCardIdentity[] = MARKET_FIXTURES.map((f) => f.identity);
