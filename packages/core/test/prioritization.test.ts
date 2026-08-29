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
