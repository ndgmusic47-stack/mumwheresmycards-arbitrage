import { describe, it, expect } from "vitest";
import {
  assessPricePlausibility,
  DEFAULT_PRICE_PLAUSIBILITY_FLOOR_RATIO,
} from "../src/opportunity/pricePlausibility.js";

/**
 * Every case below is a real listing or a real threshold, not an invented
 * one. The three flagged cases were all sitting in production on
 * 2026-09-13, and one of them had already cost money.
 */
describe("price plausibility — the listings that prompted it", () => {
  it("flags the £55 Lugia ex against its own £1,522.93 conservative raw value", () => {
    // Top result of the operator's own strategy search, presented as
    // DOWNSIDE PROTECTED with an £879.17 profit at PSA 6, while the tool's
    // own record for that card held a raw value of £1,522.93.
    const result = assessPricePlausibility({ deliveredCost: 55, rawReference: 1522.93 });

    expect(result.implausible).toBe(true);
    expect(result.ratio).toBeCloseTo(0.0361, 4);
    expect(result.reason).toMatch(/PRICE TOO GOOD TO BE TRUE/);
    expect(result.reason).toMatch(/£55\.00 delivered/);
    expect(result.reason).toMatch(/£1522\.93/);
  });

  it("flags a £1 opening auction bid, and explains it as an unfinished auction rather than a suspect card", () => {
    // Same rule, different story. Telling someone to inspect a card for
    // damage when the real answer is "the bidding has not finished" would
    // waste the one thing this is meant to save.
    const result = assessPricePlausibility({ deliveredCost: 1, rawReference: 1132.33, isAuction: true });

    expect(result.implausible).toBe(true);
    expect(result.reason).toMatch(/BID TOO LOW TO BE A REAL PRICE YET/);
    expect(result.reason).not.toMatch(/PRICE TOO GOOD TO BE TRUE/);
  });

  it("flags the Blastoise bought by mistake at £30 against a £147.48 raw value", () => {
    const result = assessPricePlausibility({ deliveredCost: 30, rawReference: 147.48 });

    expect(result.implausible).toBe(true);
    expect(result.ratio).toBeCloseTo(0.2034, 4);
  });

  it("leaves a genuine half-price find alone — a cheap listing is the whole business", () => {
    const result = assessPricePlausibility({ deliveredCost: 138, rawReference: 276 });

    expect(result.implausible).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.ratio).toBeCloseTo(0.5, 6);
  });

  it("leaves a strong-but-believable 30% find alone", () => {
    const result = assessPricePlausibility({ deliveredCost: 82, rawReference: 276 });
    expect(result.implausible).toBe(false);
  });
});

describe("price plausibility — the boundary", () => {
  it("passes exactly at the floor, so the floor is inclusive", () => {
    const result = assessPricePlausibility({ deliveredCost: 25, rawReference: 100 }, 0.25);
    expect(result.implausible).toBe(false);
  });

  it("flags a penny under the floor", () => {
    const result = assessPricePlausibility({ deliveredCost: 24.99, rawReference: 100 }, 0.25);
    expect(result.implausible).toBe(true);
  });

  it("honours a floor the operator has tuned", () => {
    const at40 = assessPricePlausibility({ deliveredCost: 82, rawReference: 276 }, 0.4);
    expect(at40.implausible).toBe(true);
    expect(at40.reason).toMatch(/below the 40% floor/);
  });

  it("defaults to a quarter of the card's own value", () => {
    expect(DEFAULT_PRICE_PLAUSIBILITY_FLOOR_RATIO).toBe(0.25);
  });
});

describe("price plausibility — when it must say nothing", () => {
  /**
   * Absent evidence is not evidence. A card with no sold-median history has
   * no reference to be suspicious against, and a rule that treated "unknown"
   * as "suspicious" would route the entire thin end of the catalogue into
   * review for no reason at all.
   */
  it("says nothing when the card has no raw reference", () => {
    const result = assessPricePlausibility({ deliveredCost: 5, rawReference: null });
    expect(result).toEqual({ implausible: false, ratio: null, reason: null });
  });

  it("says nothing when the reference is zero or negative", () => {
    expect(assessPricePlausibility({ deliveredCost: 5, rawReference: 0 }).implausible).toBe(false);
    expect(assessPricePlausibility({ deliveredCost: 5, rawReference: -10 }).implausible).toBe(false);
  });

  it("says nothing about a £0 listing — REJECTED_COMPUTATION_ERROR already owns that", () => {
    // One failure, one rule. A malformed listing reported twice in two
    // different vocabularies is harder to act on, not easier.
    const result = assessPricePlausibility({ deliveredCost: 0, rawReference: 276 });
    expect(result).toEqual({ implausible: false, ratio: null, reason: null });
  });

  it("says nothing when the numbers are not numbers", () => {
    expect(assessPricePlausibility({ deliveredCost: NaN, rawReference: 276 }).implausible).toBe(false);
    expect(assessPricePlausibility({ deliveredCost: 50, rawReference: NaN }).implausible).toBe(false);
  });
});
