import { describe, it, expect } from "vitest";
import { rankForEbaySearch, type PrioritizableCard } from "../src/market/prioritization.js";

const now = new Date("2026-08-29T12:00:00.000Z");

function card(overrides: Partial<PrioritizableCard>): PrioritizableCard {
  return {
    cardId: "card",
    score: 50,
    potentialProfit: 100,
    liquidity: "MEDIUM",
    confidence: 0.7,
    lastEbayScannedAt: null,
    ...overrides,
  };
}

describe("rankForEbaySearch", () => {
  it("ranks a higher-score card above a lower-score card, all else equal", () => {
    const high = card({ cardId: "high", score: 90 });
    const low = card({ cardId: "low", score: 10 });
    const result = rankForEbaySearch([low, high], 10, now);
    expect(result[0]!.cardId).toBe("high");
  });

  it("ranks a higher absolute-profit card above a lower one, all else equal", () => {
    const bigProfit = card({ cardId: "big", potentialProfit: 500 });
    const smallProfit = card({ cardId: "small", potentialProfit: 5 });
    const result = rankForEbaySearch([smallProfit, bigProfit], 10, now);
    expect(result[0]!.cardId).toBe("big");
  });

  it("prioritises a never-scanned card over one scanned very recently, all else equal", () => {
    const neverScanned = card({ cardId: "never", lastEbayScannedAt: null });
    const justScanned = card({ cardId: "recent", lastEbayScannedAt: now.toISOString() });
    const result = rankForEbaySearch([justScanned, neverScanned], 10, now);
    expect(result[0]!.cardId).toBe("never");
  });

  it("prioritises a card scanned a week ago over one scanned an hour ago, all else equal", () => {
    const weekAgo = card({ cardId: "week", lastEbayScannedAt: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7).toISOString() });
    const hourAgo = card({ cardId: "hour", lastEbayScannedAt: new Date(now.getTime() - 1000 * 60 * 60).toISOString() });
    const result = rankForEbaySearch([hourAgo, weekAgo], 10, now);
    expect(result[0]!.cardId).toBe("week");
  });

  it("caps results at the given budget (API quota protection)", () => {
    const cards = Array.from({ length: 50 }, (_, i) => card({ cardId: `c${i}`, score: i }));
    const result = rankForEbaySearch(cards, 10, now);
    expect(result).toHaveLength(10);
  });

  it("returns an empty array for a zero budget", () => {
    expect(rankForEbaySearch([card({})], 0, now)).toHaveLength(0);
  });
});

describe("rankForEbaySearch — rotation guarantee (STABILISATION item 3)", () => {
  /**
   * The weighted blend alone lets a permanently strong subset of cards
   * (high score/profit/liquidity/confidence) outrank every other card on
   * every single run — resetting `lastEbayScannedAt` only costs them the
   * staleness term (15% of the blend), nowhere near enough to fall behind
   * a maximally-stale but otherwise average or weak card. Without a
   * separate guarantee, the rest of the eligible universe could be
   * searched NEVER, no matter how many scan runs go by. This test
   * simulates exactly that adversarial case across many successive runs
   * (mirroring how apps/worker/src/scan/scanRunner.ts actually calls this
   * function every scan, re-ranking against updated `lastEbayScannedAt`
   * values) and asserts every card is searched at least once anyway.
   */
  it("eventually searches every eligible card at least once, even against a permanently dominant subset", () => {
    const DOMINANT_COUNT = 4;
    const WEAK_COUNT = 16;
    const BUDGET = 5; // normalSlots=4 exactly matches DOMINANT_COUNT — the adversarial case

    const dominant: PrioritizableCard[] = Array.from({ length: DOMINANT_COUNT }, (_, i) =>
      card({
        cardId: `dominant-${i}`,
        score: 100,
        potentialProfit: 1000,
        liquidity: "VERY_HIGH",
        confidence: 1,
        lastEbayScannedAt: null,
      }),
    );
    const weak: PrioritizableCard[] = Array.from({ length: WEAK_COUNT }, (_, i) =>
      card({ cardId: `weak-${i}`, score: 1, potentialProfit: 1, liquidity: "LOW", confidence: 0.1, lastEbayScannedAt: null }),
    );

    let universe = [...dominant, ...weak];
    const everSearched = new Set<string>();
    let clock = now;

    for (let round = 0; round < 20; round++) {
      const picked = rankForEbaySearch(universe, BUDGET, clock);
      const pickedIds = new Set(picked.map((c) => c.cardId));
      for (const id of pickedIds) everSearched.add(id);

      // Mirror scanRunner.ts: a searched card's last_ebay_scanned_at updates
      // to "now" for the next run.
      universe = universe.map((c) => (pickedIds.has(c.cardId) ? { ...c, lastEbayScannedAt: clock.toISOString() } : c));
      clock = new Date(clock.getTime() + 1000 * 60 * 60); // next run, 1 hour later
    }

    for (const w of weak) {
      expect(everSearched.has(w.cardId)).toBe(true);
    }
    for (const d of dominant) {
      expect(everSearched.has(d.cardId)).toBe(true);
    }
  });

  it("still returns exactly `budget` cards once the rotation reserve is applied", () => {
    const cards = Array.from({ length: 50 }, (_, i) => card({ cardId: `c${i}`, score: i }));
    const result = rankForEbaySearch(cards, 10, now);
    expect(result).toHaveLength(10);
    // No duplicates between the normally-ranked slice and the stale reserve.
    expect(new Set(result.map((c) => c.cardId)).size).toBe(10);
  });

  it("guaranteed-stale slots go to the most-stale remaining cards, not arbitrary ones", () => {
    const rankedOutOfReserve = Array.from({ length: 8 }, (_, i) =>
      card({ cardId: `ranked-${i}`, score: 90, potentialProfit: 400, liquidity: "HIGH", confidence: 0.9, lastEbayScannedAt: now.toISOString() }),
    );
    const veryStale = card({
      cardId: "very-stale",
      score: 1,
      potentialProfit: 1,
      liquidity: "LOW",
      confidence: 0.1,
      lastEbayScannedAt: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 30).toISOString(), // 30 days — well past the 1-week cap
    });
    const mildlyStale = card({
      cardId: "mildly-stale",
      score: 1,
      potentialProfit: 1,
      liquidity: "LOW",
      confidence: 0.1,
      lastEbayScannedAt: new Date(now.getTime() - 1000 * 60 * 60 * 2).toISOString(), // 2 hours
    });

    // budget=10: 8 normal slots go to rankedOutOfReserve, 2 reserved slots
    // should go to the two weak cards, and between them the MORE stale one
    // (very-stale) must not be skipped in favour of the less-stale one.
    const result = rankForEbaySearch([...rankedOutOfReserve, veryStale, mildlyStale], 10, now);
    const resultIds = result.map((c) => c.cardId);
    expect(resultIds).toContain("very-stale");
    expect(resultIds).toContain("mildly-stale");
  });
});
