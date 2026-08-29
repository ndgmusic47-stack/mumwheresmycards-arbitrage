import { resolveCardPrinting } from "@mwmc/core";
import type { RawCardIdentity } from "@mwmc/core";
import type { MarketSnapshotResult } from "../market/MarketDataProvider.js";

interface FixtureEntry {
  identity: RawCardIdentity;
  snapshot: Omit<MarketSnapshotResult, "cardId" | "sourceProvider">;
}

const RAW_FIXTURES: FixtureEntry[] = [
  {
    // Grading-arbitrage archetype: high PSA10 upside, deep raw discount available on eBay.
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
      rawQsv: 2900,
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
      rawQsv: 185,
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
      rawQsv: 52,
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

function buildFixtureMap(): Map<string, Omit<MarketSnapshotResult, "cardId" | "sourceProvider">> {
  const map = new Map<string, Omit<MarketSnapshotResult, "cardId" | "sourceProvider">>();
  for (const entry of RAW_FIXTURES) {
    const resolved = resolveCardPrinting(entry.identity);
    if (!resolved.ok || !resolved.printing) {
      throw new Error(`Invalid fixture identity: ${JSON.stringify(entry.identity)}`);
    }
    map.set(resolved.printing.printingHash, entry.snapshot);
  }
  return map;
}

/** Keyed by printingHash — computed once at module load. */
export const MARKET_FIXTURES: Map<string, Omit<MarketSnapshotResult, "cardId" | "sourceProvider">> = buildFixtureMap();

/** Convenience export of the raw identities, e.g. for eBay listing fixtures that need to reference the same cards. */
export const MARKET_FIXTURE_IDENTITIES: RawCardIdentity[] = RAW_FIXTURES.map((f) => f.identity);
