import { describe, it, expect } from "vitest";
import { PokeTraceProvider, tierPriceAgreement } from "../src/market/PokeTraceProvider.js";

/**
 * Built from the REAL PokeTrace payload for Pikachu EX - XY124, read out of
 * production on 2026-09-13. The PSA_10 tier below is copied field for field
 * from what the provider actually returned, including `low === high === 88988`
 * on 34 claimed sales, which is the signature of one freak sale owning the
 * entire aggregate.
 *
 * PriceCharting had that card's PSA 10 at $19,999 the same day — and the
 * provider's own `avg1d` says 19999 too. Every wider window is poisoned.
 */
const PIKACHU_XY124_EBAY_TIERS = {
  NEAR_MINT: { avg: 850, low: 850, high: 850, avg1d: 350, avg7d: 428.618, avg30d: 428.618, median3d: 850, median7d: 850, median30d: 374, saleCount: 110 },
  PSA_6: { avg: 405, low: 405, high: 405, avg1d: 385.21, avg7d: 418.3157, avg30d: 393.1318, median3d: 395.105, median7d: 430, median30d: 395.105, saleCount: 149 },
  PSA_7: { avg: 535, low: 535, high: 535, avg1d: 553.18, avg7d: 494.38284, avg30d: 469.61002, median3d: 535, median7d: 544.09, median30d: 470, saleCount: 227 },
  PSA_8: { avg: 1096.725, low: 1016.45, high: 1177, avg1d: 1255, avg7d: 1025.7136, avg30d: 988.8883, median3d: 1096.725, median7d: 1096.725, median30d: 1000, saleCount: 148 },
  PSA_9: { avg: 5110, low: 5110, high: 5110, avg1d: 6500, avg7d: 4372, avg30d: 4372, median3d: 5805, median7d: 5805, median30d: 3625, saleCount: 93 },
  PSA_10: { avg: 88988, low: 88988, high: 88988, avg1d: 19999, avg7d: 54493.5, avg30d: 54493.5, median3d: 88988, median7d: 88988, median30d: 54493.5, saleCount: 34 },
};

/** GBP per USD, matching the rate the live snapshot was converted at. */
const FX = { USD: 0.7403 };

async function snapshotFromTiers(tiers: Record<string, unknown>) {
  const provider = new PokeTraceProvider({
    apiKey: "test",
    baseUrl: "https://api.poketrace.com",
    fxRates: FX,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          data: {
            id: "test-card",
            name: "Pikachu EX - XY124",
            market: "US",
            currency: "USD",
            lastUpdated: "2026-09-12T08:24:57.247Z",
            prices: { ebay: tiers },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  });
  return provider.getSnapshotByProviderId("test-card");
}

const usd = (gbp: number) => gbp / FX.USD;

describe("slab pricing is resistant to a single freak sale", () => {
  it("prices PSA 10 from the lowest window rather than the poisoned median", async () => {
    const snapshot = await snapshotFromTiers(PIKACHU_XY124_EBAY_TIERS);

    // The whole point: 88,988 was what shipped, 54,493.5 was what taking the
    // lower of the two medians would have given, and 19,999 is the truth.
    expect(usd(snapshot!.psa10!)).toBeCloseTo(19999, 0);
  });

  it("moves grades 6 to 9 only slightly, and towards the market", async () => {
    const snapshot = await snapshotFromTiers(PIKACHU_XY124_EBAY_TIERS);

    // Market figures from PriceCharting, same day: PSA 7 $478.50,
    // PSA 8 $1,012.50, PSA 9 $3,850.00. These land within a few percent,
    // slightly under — which is the direction to be wrong in.
    expect(usd(snapshot!.psa6!)).toBeCloseTo(385.21, 1);
    expect(usd(snapshot!.psa7!)).toBeCloseTo(469.61, 1);
    expect(usd(snapshot!.psa8!)).toBeCloseTo(988.89, 1);
    expect(usd(snapshot!.psa9!)).toBeCloseTo(3625, 0);
  });

  it("still falls back to the flat average when a tier has no windows at all, and says so", async () => {
    const snapshot = await snapshotFromTiers({
      NEAR_MINT: PIKACHU_XY124_EBAY_TIERS.NEAR_MINT,
      PSA_9: { avg: 400, low: 400, high: 400, saleCount: 3 },
    });

    expect(usd(snapshot!.psa9!)).toBeCloseTo(400, 1);
    expect(snapshot!.estimatedGrades).toContain(9);
  });

  it("does not treat the tier's own low as a price — that would be a discount, not a measurement", async () => {
    const snapshot = await snapshotFromTiers({
      NEAR_MINT: PIKACHU_XY124_EBAY_TIERS.NEAR_MINT,
      // low is far under every window; it must be ignored.
      PSA_8: { avg: 1000, low: 5, high: 1200, median7d: 1000, median30d: 950, saleCount: 40 },
    });

    expect(usd(snapshot!.psa8!)).toBeCloseTo(950, 1);
  });
});

describe("the graded side gets its own confidence", () => {
  it("does not report the raw tier's confidence against the slabs", async () => {
    const snapshot = await snapshotFromTiers(PIKACHU_XY124_EBAY_TIERS);

    // Live, this row displayed 100% — earned by 110 RAW sales — beside a
    // PSA 10 standing on 34 whose windows ran from 19,999 to 88,988.
    expect(snapshot!.gradedConfidence).not.toBeNull();
    expect(snapshot!.gradedConfidence!).toBeLessThan(0.5);
    expect(snapshot!.gradedConfidence!).toBeLessThan(snapshot!.confidence);
  });

  it("is set by the weakest priced grade, because a ladder is only as good as the rung you sell on", async () => {
    const sound = await snapshotFromTiers({
      NEAR_MINT: PIKACHU_XY124_EBAY_TIERS.NEAR_MINT,
      PSA_7: PIKACHU_XY124_EBAY_TIERS.PSA_7,
      PSA_8: PIKACHU_XY124_EBAY_TIERS.PSA_8,
    });
    const withOnePoisonedRung = await snapshotFromTiers({
      NEAR_MINT: PIKACHU_XY124_EBAY_TIERS.NEAR_MINT,
      PSA_7: PIKACHU_XY124_EBAY_TIERS.PSA_7,
      PSA_8: PIKACHU_XY124_EBAY_TIERS.PSA_8,
      PSA_10: PIKACHU_XY124_EBAY_TIERS.PSA_10,
    });

    expect(withOnePoisonedRung!.gradedConfidence!).toBeLessThan(sound!.gradedConfidence!);
  });

  it("is null when the provider priced no named grade, rather than borrowing the raw answer", async () => {
    const snapshot = await snapshotFromTiers({ NEAR_MINT: PIKACHU_XY124_EBAY_TIERS.NEAR_MINT });
    expect(snapshot!.gradedConfidence).toBeNull();
  });
});

describe("tierPriceAgreement", () => {
  it("scores perfect agreement as 1", () => {
    expect(tierPriceAgreement([100, 100, 100])).toBe(1);
  });

  it("scores the Pikachu PSA 10 spread at about 0.22", () => {
    expect(tierPriceAgreement([88988, 54493.5, 19999])!).toBeCloseTo(0.2247, 3);
  });

  it("returns null with fewer than two values — one window is not evidence either way", () => {
    expect(tierPriceAgreement([100])).toBeNull();
    expect(tierPriceAgreement([])).toBeNull();
  });

  it("ignores non-positive values rather than dividing by them", () => {
    expect(tierPriceAgreement([0, 100])).toBeNull();
    expect(tierPriceAgreement([-5, 100, 50])).toBeCloseTo(0.5, 6);
  });
});
