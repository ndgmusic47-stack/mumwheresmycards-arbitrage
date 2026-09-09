import { describe, it, expect } from "vitest";
import {
  rankForEbaySearch,
  CLOSING_AUCTION_WINDOW_HOURS,
  CLOSING_AUCTION_RESERVE_FRACTION,
  type PrioritizableCard,
} from "../src/market/prioritization.js";

/**
 * REGRESSION GUARD for the 2026-09-09 AUCTION EDGE.
 *
 * THE PROBLEM. The scanner searches ~60 cards per run out of an eligible
 * universe of thousands, ranked by score/profit/liquidity/confidence with a
 * 20% reserve for the stalest. Nothing in that blend knows about deadlines.
 * So a card whose auction closed in ten minutes was no more likely to be
 * re-searched than one whose fixed-price listing would still be sitting
 * there next week — and the user's screen could be showing a current bid
 * several hours old at the exact moment they decided whether to bid.
 *
 * The max-bid CEILING is stale-proof (it derives from sale-side proceeds and
 * fixed costs, neither of which move with the current bid). The HEADROOM is
 * not: it is ceiling minus current bid, and the current bid is the thing
 * going stale. So the number that says "you still have room" was the one
 * that could silently be wrong.
 *
 * THE FIX. A reserved slice of each run's budget, taken before score ranking
 * and before the stale reserve, for cards with an auction closing inside the
 * window — soonest first. A CAP, not a quota: unused slots fall through to
 * normal ranking, so quiet periods cost discovery nothing.
 *
 * The tests below pin down the four properties that make it safe: it fires
 * on deadline rather than merit, it prefers the most urgent, it cannot eat
 * the whole budget, and it wastes nothing when idle.
 */
const now = new Date("2026-09-09T12:00:00.000Z");

function at(hoursFromNow: number): string {
  return new Date(now.getTime() + hoursFromNow * 3600_000).toISOString();
}

function card(overrides: Partial<PrioritizableCard>): PrioritizableCard {
  return {
    cardId: "card",
    score: 50,
    potentialProfit: 100,
    liquidity: "MEDIUM",
    confidence: 0.7,
    lastEbayScannedAt: null,
    maxAcquisitionPrice: null,
    soonestActiveAuctionEndsAt: null,
    ...overrides,
  };
}

/** Enough high-ranking filler to make the budget genuinely scarce. */
function filler(count: number, prefix = "filler"): PrioritizableCard[] {
  return Array.from({ length: count }, (_, i) =>
    card({
      cardId: `${prefix}-${i}`,
      score: 99,
      potentialProfit: 5000,
      liquidity: "VERY_HIGH",
      confidence: 1,
      lastEbayScannedAt: now.toISOString(),
    }),
  );
}

describe("a closing auction is searched on deadline, not on merit", () => {
  it("picks a bottom-ranked card whose auction closes soon, over dominant cards", () => {
    const closing = card({
      cardId: "closing",
      score: 1,
      potentialProfit: 1,
      liquidity: "LOW",
      confidence: 0.1,
      lastEbayScannedAt: now.toISOString(),
      soonestActiveAuctionEndsAt: at(0.5),
    });

    const result = rankForEbaySearch([...filler(200), closing], 10, now);
    expect(result.map((c) => c.cardId)).toContain("closing");
  });

  it("puts it FIRST — a deadline outranks everything else in the run", () => {
    const closing = card({ cardId: "closing", score: 1, soonestActiveAuctionEndsAt: at(0.25) });
    const result = rankForEbaySearch([...filler(200), closing], 10, now);
    expect(result[0]!.cardId).toBe("closing");
  });

  it("without the auction, that same card is not picked at all — proving the reserve is what did it", () => {
    const notClosing = card({
      cardId: "closing",
      score: 1,
      potentialProfit: 1,
      liquidity: "LOW",
      confidence: 0.1,
      lastEbayScannedAt: now.toISOString(),
    });
    const result = rankForEbaySearch([...filler(200), notClosing], 10, now);
    expect(result.map((c) => c.cardId)).not.toContain("closing");
  });
});

describe("the most urgent auctions win the reserved slots", () => {
  it("orders soonest-first, so a 10-minute close beats a 2-hour one", () => {
    const soon = card({ cardId: "soon", soonestActiveAuctionEndsAt: at(1 / 6) });
    const later = card({ cardId: "later", soonestActiveAuctionEndsAt: at(2) });
    const result = rankForEbaySearch([...filler(200), later, soon], 10, now);
    expect(result[0]!.cardId).toBe("soon");
    expect(result[1]!.cardId).toBe("later");
  });

  it("when more auctions are closing than slots, the latest ones are dropped", () => {
    const budget = 10;
    const cap = Math.round(budget * CLOSING_AUCTION_RESERVE_FRACTION); // 4
    // Recently scanned, so the stale reserve has no reason to pick any of
    // them independently — every `close-` in the result got there via the
    // closing reserve.
    const closing = Array.from({ length: 12 }, (_, i) =>
      card({
        cardId: `close-${i}`,
        score: 1,
        lastEbayScannedAt: now.toISOString(),
        soonestActiveAuctionEndsAt: at(0.1 * (i + 1)),
      }),
    );

    const result = rankForEbaySearch([...filler(200), ...closing], budget, now);
    const chosen = result.filter((c) => c.cardId.startsWith("close-")).map((c) => c.cardId);

    expect(chosen).toHaveLength(cap);
    // The four soonest, in order.
    expect(chosen).toEqual(["close-0", "close-1", "close-2", "close-3"]);
  });
});

describe("the reserve is a cap, never a quota", () => {
  it("cannot consume the whole budget — discovery always keeps slots", () => {
    // Recently scanned and low-ranked, so the stale reserve and the score
    // ranking have no independent reason to pick them: whatever appears got
    // there THROUGH the closing reserve, which is what this asserts a cap on.
    const closing = Array.from({ length: 100 }, (_, i) =>
      card({
        cardId: `close-${i}`,
        score: 1,
        potentialProfit: 1,
        liquidity: "LOW",
        confidence: 0.1,
        lastEbayScannedAt: now.toISOString(),
        soonestActiveAuctionEndsAt: at(0.5),
      }),
    );
    const budget = 20;
    const result = rankForEbaySearch([...filler(200), ...closing], budget, now);

    const closingCount = result.filter((c) => c.cardId.startsWith("close-")).length;
    expect(result).toHaveLength(budget);
    expect(closingCount).toBeLessThanOrEqual(Math.round(budget * CLOSING_AUCTION_RESERVE_FRACTION));
    expect(closingCount).toBeLessThan(budget);
  });

  it("wastes nothing when no auction is closing — the full budget goes to ranking", () => {
    const budget = 10;
    const result = rankForEbaySearch(filler(200), budget, now);
    expect(result).toHaveLength(budget);
  });

  it("uses only as many slots as there are closing auctions", () => {
    const budget = 20;
    const oneClosing = card({ cardId: "close-0", score: 1, soonestActiveAuctionEndsAt: at(0.5) });
    const result = rankForEbaySearch([...filler(200), oneClosing], budget, now);
    expect(result).toHaveLength(budget);
    expect(result.filter((c) => c.cardId.startsWith("close-"))).toHaveLength(1);
  });
});

describe("only genuinely-closing auctions qualify", () => {
  it("ignores an auction beyond the window", () => {
    const far = card({
      cardId: "far",
      score: 1,
      lastEbayScannedAt: now.toISOString(),
      soonestActiveAuctionEndsAt: at(CLOSING_AUCTION_WINDOW_HOURS + 1),
    });
    const result = rankForEbaySearch([...filler(200), far], 10, now);
    expect(result.map((c) => c.cardId)).not.toContain("far");
  });

  it("ignores an auction that has already ended — a dead listing needs no refresh", () => {
    const past = card({
      cardId: "past",
      score: 1,
      lastEbayScannedAt: now.toISOString(),
      soonestActiveAuctionEndsAt: at(-1),
    });
    const result = rankForEbaySearch([...filler(200), past], 10, now);
    expect(result.map((c) => c.cardId)).not.toContain("past");
  });

  it("tolerates D1's space-separated datetime format, not just ISO", () => {
    // ebay_listings.end_time can arrive as "2026-09-09 12:30:00" (UTC).
    const stamp = new Date(now.getTime() + 1800_000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
    const closing = card({ cardId: "closing", score: 1, soonestActiveAuctionEndsAt: stamp });
    const result = rankForEbaySearch([...filler(200), closing], 10, now);
    expect(result[0]!.cardId).toBe("closing");
  });

  it("tolerates an unparseable timestamp by ignoring it rather than throwing", () => {
    const broken = card({
      cardId: "broken",
      score: 1,
      lastEbayScannedAt: now.toISOString(),
      soonestActiveAuctionEndsAt: "not-a-date",
    });
    expect(() => rankForEbaySearch([...filler(200), broken], 10, now)).not.toThrow();
    expect(rankForEbaySearch([...filler(200), broken], 10, now).map((c) => c.cardId)).not.toContain("broken");
  });
});

describe("the existing guarantees survive", () => {
  it("a closing auction that also ranks top does not consume two slots", () => {
    const budget = 10;
    const star = card({
      cardId: "star",
      score: 99,
      potentialProfit: 5000,
      liquidity: "VERY_HIGH",
      confidence: 1,
      soonestActiveAuctionEndsAt: at(0.5),
    });
    const result = rankForEbaySearch([...filler(200), star], budget, now);

    expect(result).toHaveLength(budget);
    expect(result.filter((c) => c.cardId === "star")).toHaveLength(1);
    expect(new Set(result.map((c) => c.cardId)).size).toBe(budget);
  });

  it("the stale-rotation reserve still runs, so nothing starves", () => {
    // One never-scanned card among permanently-dominant ones, plus a closing
    // auction eating part of the budget. The stale card must still surface.
    const starved = card({ cardId: "starved", score: 1, potentialProfit: 1, lastEbayScannedAt: null });
    const closing = card({ cardId: "closing", score: 1, soonestActiveAuctionEndsAt: at(0.5) });
    const dominant = filler(50).map((c) => ({ ...c, lastEbayScannedAt: now.toISOString() }));

    const result = rankForEbaySearch([...dominant, starved, closing], 10, now);
    const ids = result.map((c) => c.cardId);
    expect(ids).toContain("closing");
    expect(ids).toContain("starved");
  });

  it("never returns more than the budget, and never a duplicate", () => {
    const closing = Array.from({ length: 30 }, (_, i) =>
      card({ cardId: `close-${i}`, soonestActiveAuctionEndsAt: at(0.1 * (i + 1)) }),
    );
    for (const budget of [1, 3, 10, 25, 60]) {
      const result = rankForEbaySearch([...filler(300), ...closing], budget, now);
      expect(result).toHaveLength(budget);
      expect(new Set(result.map((c) => c.cardId)).size).toBe(budget);
    }
  });
});
