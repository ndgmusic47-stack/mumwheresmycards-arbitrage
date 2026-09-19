import { describe, it, expect } from "vitest";
import { assessListingClose } from "../src/market/listingClose.js";

/**
 * WHAT COUNTS AS PROOF THAT SOMETHING SOLD.
 *
 * The operator's correction, 2026-09-19: "listing counts measure available
 * listings, not completed purchases or selling speed. They cannot justify
 * 'nobody to sell to'." He was right, and this is the first thing in the
 * tool that measures a sale at all.
 *
 * eBay will not simply tell us — Marketplace Insights is closed to new
 * applicants and PokeTrace's sold endpoint returns 403 without a paid plan.
 * So exactly one case is provable from the searches already being run, and
 * the whole value of this file is holding the line between that case and
 * the ones that merely look like it. Every test below is about refusing to
 * call something a sale.
 */
const NOW = new Date("2026-09-19T12:00:00Z");
const ENDED = "2026-09-19T09:00:00Z";
const NOT_YET = "2026-09-20T09:00:00Z";

describe("the one case that is proof", () => {
  it("an auction past its end with bids on it sold, at the final bid", () => {
    const result = assessListingClose({ listingType: "AUCTION", endTime: ENDED, bids: 7, price: 84.5 }, NOW);

    expect(result.kind).toBe("AUCTION_SOLD");
    expect(result.salePrice).toBe(84.5);
    expect(result.reason).toContain("Somebody paid this");
  });

  it("one bid is still a sale", () => {
    const result = assessListingClose({ listingType: "AUCTION", endTime: ENDED, bids: 1, price: 12 }, NOW);

    expect(result.kind).toBe("AUCTION_SOLD");
    expect(result.reason).toContain("1 bid");
    expect(result.reason).not.toContain("1 bids");
  });

  /**
   * A proven sale with no price is real evidence for sell-through and
   * useless as a comp. Recording £0 would put a card that "sold for nothing"
   * into the price record.
   */
  it("keeps the sale but not a price when the final figure was never captured", () => {
    for (const price of [null, undefined, 0, -5, Number.NaN]) {
      const result = assessListingClose({ listingType: "AUCTION", endTime: ENDED, bids: 3, price }, NOW);

      expect(result.kind).toBe("AUCTION_SOLD");
      expect(result.salePrice).toBeNull();
    }
  });
});

describe("what must never be called a sale", () => {
  it("a fixed-price listing that simply stopped appearing", () => {
    const result = assessListingClose({ listingType: "FIXED", price: 40 }, NOW);

    expect(result.kind).toBe("VANISHED");
    expect(result.salePrice).toBeNull();
  });

  it("a best-offer listing that stopped appearing", () => {
    expect(assessListingClose({ listingType: "BEST_OFFER", price: 40 }, NOW).kind).toBe("VANISHED");
  });

  /**
   * Gone before its own deadline. Whatever happened, nobody won it — and
   * counting it would file a phantom comp at whatever the bidding had
   * reached when the seller pulled it.
   */
  it("an auction that disappeared BEFORE its end time", () => {
    const result = assessListingClose({ listingType: "AUCTION", endTime: NOT_YET, bids: 9, price: 300 }, NOW);

    expect(result.kind).toBe("VANISHED");
    expect(result.salePrice).toBeNull();
    expect(result.reason).toContain("before its end time");
  });

  it("an auction with no end time on record", () => {
    expect(assessListingClose({ listingType: "AUCTION", endTime: null, bids: 4, price: 50 }, NOW).kind).toBe("VANISHED");
  });

  it("an auction whose end time is unreadable, rather than throwing on it", () => {
    const result = assessListingClose({ listingType: "AUCTION", endTime: "not a date", bids: 4, price: 50 }, NOW);

    expect(result.kind).toBe("VANISHED");
  });

  /**
   * BLANK IS NOT ZERO, in the place it matters most. An unknown bid count
   * can neither prove a sale nor prove a no-sale. Read as zero it would
   * silently become "the market declined this", which is a claim about
   * demand that nobody measured.
   */
  it("an auction whose bid count was never captured", () => {
    for (const bids of [null, undefined]) {
      const result = assessListingClose({ listingType: "AUCTION", endTime: ENDED, bids, price: 50 }, NOW);

      expect(result.kind).toBe("VANISHED");
      expect(result.reason).toContain("cannot tell a sale from a no-sale");
    }
  });
});

describe("a no-sale is recorded as a no-sale, not as silence", () => {
  it("an auction that ran its course with nobody bidding", () => {
    const result = assessListingClose({ listingType: "AUCTION", endTime: ENDED, bids: 0, price: 120 }, NOW);

    expect(result.kind).toBe("AUCTION_UNSOLD");
    expect(result.salePrice).toBeNull();
    // This is genuine information about demand — the market saw the opening
    // price and declined it — and is worth keeping distinct from "we have no
    // idea what happened".
    expect(result.reason).toContain("no bids");
  });
});

describe("the boundary", () => {
  it("an auction ending exactly now counts as ended", () => {
    const result = assessListingClose(
      { listingType: "AUCTION", endTime: NOW.toISOString(), bids: 2, price: 30 },
      NOW,
    );

    expect(result.kind).toBe("AUCTION_SOLD");
  });

  it("is judged against the time passed in, not the wall clock", () => {
    // The same listing, assessed before and after its close. A scan must be
    // able to judge against the moment its results were fetched.
    const facts = { listingType: "AUCTION", endTime: ENDED, bids: 2, price: 30 } as const;

    expect(assessListingClose(facts, new Date("2026-09-19T08:00:00Z")).kind).toBe("VANISHED");
    expect(assessListingClose(facts, new Date("2026-09-19T10:00:00Z")).kind).toBe("AUCTION_SOLD");
  });
});
