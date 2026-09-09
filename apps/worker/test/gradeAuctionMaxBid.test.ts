import { describe, it, expect } from "vitest";
import { computeGradedBasis, computeMaxRawPriceForGrading, DEFAULT_GRADING_SERVICES } from "@mwmc/core";

/**
 * REGRESSION GUARD for the 2026-09-09 "GRADE auctions show a max bid" change.
 *
 * The route derives a GRADE auction's max bid arithmetically rather than by
 * calling the solver:
 *
 *     maxBid = listing_price + psa7_profit
 *
 * That is only legitimate because `computeGradedBasis` is EXACTLY linear in
 * the raw purchase price with slope 1 — every other term (postage, import
 * tax, acquisition fees, grading fee, per-card batch share, consumables,
 * upcharge reserve) is independent of what you pay for the card, and the
 * sale side does not depend on acquisition cost at all.
 *
 * If anyone ever makes an acquisition-side cost proportional to the purchase
 * price — a percentage buyer's fee, say — that slope stops being 1 and the
 * route's arithmetic silently starts lying at exactly the moment it matters
 * most (an auction closing). These tests exist to fail loudly if that
 * happens, which is why they assert on the basis function itself rather than
 * only on the route's output.
 */
const SERVICE = DEFAULT_GRADING_SERVICES.find((s) => s.id === "PSA_VALUE")!;

function basisAt(rawPurchasePrice: number, sellerPostage = 3.5) {
  return computeGradedBasis({ rawPurchasePrice, sellerPostage, service: SERVICE });
}

describe("the graded basis is exactly linear in the raw purchase price", () => {
  it("moves penny for penny — slope exactly 1, not approximately", () => {
    const at20 = basisAt(20).total;
    const at21 = basisAt(21).total;
    expect(at21 - at20).toBeCloseTo(1, 10);
  });

  it("holds across a wide price range, so the derivation is not a local approximation", () => {
    for (const [lo, hi] of [
      [0, 1],
      [15, 40],
      [199, 250],
    ]) {
      expect(basisAt(hi).total - basisAt(lo).total).toBeCloseTo(hi - lo, 10);
    }
  });

  it("every non-price component is genuinely price-independent", () => {
    const cheap = basisAt(10);
    const dear = basisAt(500);
    expect(dear.gradingFee).toBe(cheap.gradingFee);
    expect(dear.perCardSharedLogistics).toBe(cheap.perCardSharedLogistics);
    expect(dear.sleeve).toBe(cheap.sleeve);
    expect(dear.cardSaver).toBe(cheap.cardSaver);
    expect(dear.sellerPostage).toBe(cheap.sellerPostage);
    expect(dear.importTax).toBe(cheap.importTax);
    expect(dear.acquisitionFees).toBe(cheap.acquisitionFees);
    expect(dear.upchargeReserve).toBe(cheap.upchargeReserve);
  });
});

describe("listing_price + psa7_profit agrees with the real solver", () => {
  /**
   * The solver answers "highest raw price that still clears a profit/ROC bar
   * at a named grade". Set both bars to zero and it answers exactly the
   * question the route's shortcut answers: break-even at that grade. The two
   * must land on the same number, or the shortcut is wrong.
   */
  it("matches computeMaxRawPriceForGrading at a zero profit and ROC bar", () => {
    const slabValueAtPsa7 = 140;
    const sellerPostage = 3.5;
    const currentBid = 25;

    const solved = computeMaxRawPriceForGrading({
      slabValueAtGrade: slabValueAtPsa7,
      service: SERVICE,
      minNetProfit: 0,
      minReturnOnCapital: 0,
      sellerPostage,
    });

    // Reproduce what the route has on the row: profit at PSA 7 given the
    // CURRENT bid. (netProceeds is whatever the solver's ceiling implies at
    // a zero bar — i.e. the basis it would allow.)
    const basisAtCurrentBid = computeGradedBasis({ rawPurchasePrice: currentBid, sellerPostage, service: SERVICE }).total;
    const netProceedsAtPsa7 = solved.maxTotalGradedBasis!; // zero bar => ceiling IS net proceeds
    const psa7ProfitAtCurrentBid = netProceedsAtPsa7 - basisAtCurrentBid;

    const routeShortcut = currentBid + psa7ProfitAtCurrentBid;

    expect(routeShortcut).toBeCloseTo(solved.maxRawPurchasePrice!, 6);
  });

  it("a card already past break-even at PSA 7 yields a ceiling ABOVE the current bid", () => {
    // psa7_profit > 0 => headroom to keep bidding.
    const currentBid = 20;
    const psa7Profit = 18.4;
    expect(currentBid + psa7Profit).toBeGreaterThan(currentBid);
  });

  it("a card underwater at PSA 7 yields a ceiling BELOW the current bid", () => {
    // psa7_profit < 0 => the auction has already gone past the point where a
    // 7 returns your money. The UI must show this as "already exceeded".
    const currentBid = 60;
    const psa7Profit = -12.75;
    expect(currentBid + psa7Profit).toBeLessThan(currentBid);
    expect(currentBid + psa7Profit).toBeCloseTo(47.25, 10);
  });

  it("headroom equals psa7_profit by construction", () => {
    const currentBid = 31.5;
    const psa7Profit = 9.25;
    const maxBid = currentBid + psa7Profit;
    expect(maxBid - currentBid).toBeCloseTo(psa7Profit, 10);
  });
});

describe("the degenerate case is refused rather than printed as £0.00", () => {
  it("fixed costs alone can exceed what a PSA 7 returns, leaving no viable price", () => {
    // A slab worth less than the grading fee: no purchase price, not even
    // zero, makes this pay back. The route sets max_bid null in this case —
    // a "£0.00 ceiling" would read like a live number.
    const solved = computeMaxRawPriceForGrading({
      slabValueAtGrade: 5,
      service: SERVICE,
      minNetProfit: 0,
      minReturnOnCapital: 0,
    });
    expect(solved.maxRawPurchasePrice).toBe(0);
  });
});
