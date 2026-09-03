import { describe, expect, it } from "vitest";
import { extractConditionTierPrices } from "../src/market/conditionTiers.js";

const DEFAULT_FX_USD = 0.79;

// Shape trimmed from a REAL apps/worker/scripts/poketrace-smoke-test.ts run
// against the live PokeTrace API (2026-09-02, Charizard #146/144 Skyridge
// reverse holo) — this is genuinely what raw_payload holds on a real
// market_snapshots row, not a guessed shape.
const REAL_SAMPLE_PAYLOAD = {
  id: "019bff79-8e0f-74bf-99c4-0ffe56d20834",
  name: "Charizard",
  market: "US",
  currency: "USD",
  prices: {
    ebay: {
      DAMAGED: { avg: 267.69, saleCount: 5 },
      HEAVILY_PLAYED: { avg: 770, saleCount: 3 },
      LIGHTLY_PLAYED: { avg: 2195.69, saleCount: 3 },
      NEAR_MINT: { avg: 2668.2, saleCount: 9 },
      PSA_10: { avg: 16100, saleCount: 32 },
    },
    tcgplayer: {
      DAMAGED: { avg: 799.99, saleCount: 1 },
      LIGHTLY_PLAYED: { avg: 2400, saleCount: 4 },
      NEAR_MINT: { avg: 4499.99, saleCount: 6 },
      PSA_8: { avg: 1599.99, saleCount: 25 },
    },
  },
};

describe("extractConditionTierPrices (SOURCING WORKFLOW item 8)", () => {
  it("extracts all five raw-card condition tiers from the preferred (ebay) source, converted to GBP", () => {
    const fxRates = { GBP: 1, USD: 0.8, EUR: 0.86 };
    const result = extractConditionTierPrices(REAL_SAMPLE_PAYLOAD, fxRates);
    expect(result.source).toBe("ebay");
    expect(result.damaged).toBeCloseTo(267.69 * 0.8, 2);
    expect(result.heavilyPlayed).toBeCloseTo(770 * 0.8, 2);
    expect(result.lightlyPlayed).toBeCloseTo(2195.69 * 0.8, 2);
    expect(result.nearMint).toBeCloseTo(2668.2 * 0.8, 2);
    // MODERATELY_PLAYED genuinely wasn't present in the "ebay" source for
    // this real sample — must be null, never fabricated from another tier.
    expect(result.moderatelyPlayed).toBeNull();
  });

  it("prefers ebay over tcgplayer per SOURCE_PRIORITY, never blending the two sources' tiers", () => {
    const result = extractConditionTierPrices(REAL_SAMPLE_PAYLOAD);
    // tcgplayer's own NEAR_MINT (4499.99) must NOT leak in just because
    // it's also present there — the whole tier set comes from one source.
    expect(result.source).toBe("ebay");
    expect(result.nearMint).not.toBeNull();
    expect(result.nearMint).not.toBeCloseTo(4499.99, 0);
  });

  it("falls back to whatever source IS present when the preferred ones are absent", () => {
    const onlyCardmarket = {
      currency: "EUR",
      prices: { cardmarket: { NEAR_MINT: { avg: 100 }, DAMAGED: { avg: 20 } } },
    };
    const result = extractConditionTierPrices(onlyCardmarket, { GBP: 1, USD: 0.8, EUR: 0.86 });
    expect(result.source).toBe("cardmarket");
    expect(result.nearMint).toBeCloseTo(86, 2);
    expect(result.damaged).toBeCloseTo(17.2, 2);
  });

  it("returns all-null, not a fabricated zero, when raw_payload has no prices object", () => {
    const result = extractConditionTierPrices({ id: "x", currency: "USD" });
    expect(result).toEqual({
      damaged: null,
      heavilyPlayed: null,
      moderatelyPlayed: null,
      lightlyPlayed: null,
      nearMint: null,
      source: null,
    });
  });

  it("returns all-null for null/non-object/unparseable input, never throwing", () => {
    expect(extractConditionTierPrices(null).source).toBeNull();
    expect(extractConditionTierPrices(undefined).source).toBeNull();
    expect(extractConditionTierPrices("not json").source).toBeNull();
    expect(extractConditionTierPrices(42).source).toBeNull();
  });

  it("skips an empty source object rather than treating it as the picked source", () => {
    const result = extractConditionTierPrices({
      currency: "USD",
      prices: { ebay: {}, tcgplayer: { NEAR_MINT: { avg: 50 } } },
    });
    expect(result.source).toBe("tcgplayer");
    expect(result.nearMint).toBeCloseTo(50 * DEFAULT_FX_USD, 2);
  });

  it("defaults to USD when the payload carries no currency field", () => {
    const result = extractConditionTierPrices({ prices: { ebay: { NEAR_MINT: { avg: 10 } } } }, { GBP: 1, USD: 0.5, EUR: 0.86 });
    expect(result.nearMint).toBeCloseTo(5, 2);
  });
});
