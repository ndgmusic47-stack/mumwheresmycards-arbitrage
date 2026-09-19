import { describe, it, expect } from "vitest";
import { buildOpportunities } from "../src/opportunity/engine.js";
import { computeGradeLadder } from "../src/calc/gradeLadder.js";
import { PSA_GRADES } from "../src/calc/types.js";
import type {
  ListingCandidate,
  MarketSnapshotLike,
  OpportunityEngineSettings,
} from "../src/opportunity/types.js";
import {
  DEFAULT_CLASSIFICATION_SETTINGS,
  DEFAULT_EXIT_MARKET_FEE_MODEL,
  DEFAULT_FLIP_QUALIFICATION,
  DEFAULT_GRADE_QUALIFICATION,
  DEFAULT_GRADING_BATCH,
  DEFAULT_GRADING_CONSUMABLES,
  DEFAULT_GRADING_SERVICES,
  DEFAULT_QSV_SETTINGS,
  DEFAULT_SELLING_COSTS,
  hashPrinting,
  resolveCardPrinting,
} from "../src/index.js";

/**
 * THE SENTENCE THE TOOL COULD NOT SAY.
 *
 * Stated by the operator on 2026-09-19: "I want money all through the
 * grading scale. I want to buy at £200 raw and sell at £500 PSA 5. I don't
 * care what the raw price is, under £1,000 raw I'm interested. I'm not going
 * to aim for gems."
 *
 * Before this change the grade ladder ran PSA 6 to 10. His trade was not
 * rejected, not scored badly, not filtered out — it was INEXPRESSIBLE, in
 * the way that a form with no box for something cannot record it. The
 * cheapest possible mistake to miss, because nothing anywhere reported an
 * error.
 *
 * The prices were never missing. Migration 0026 had been storing the
 * provider's whole graded spectrum since 12 September; on the live database
 * the day this was written, 20,150 snapshots carried a PSA 5 and 12,736 a
 * PSA 1, read by nothing on the scan path.
 *
 * These tests are written against the trade as he described it, in his
 * numbers, and they are the ones that fail if the scale is ever narrowed
 * back.
 */
function settings(overrides: Partial<OpportunityEngineSettings> = {}): OpportunityEngineSettings {
  return {
    qualification: {
      strategy: "GRADE",
      flip: { ...DEFAULT_FLIP_QUALIFICATION },
      grade: { ...DEFAULT_GRADE_QUALIFICATION },
    },
    qsvSettings: DEFAULT_QSV_SETTINGS,
    feeModel: DEFAULT_EXIT_MARKET_FEE_MODEL,
    sellingCosts: DEFAULT_SELLING_COSTS,
    gradingServices: DEFAULT_GRADING_SERVICES,
    gradingBatch: DEFAULT_GRADING_BATCH,
    gradingConsumables: DEFAULT_GRADING_CONSUMABLES,
    classificationSettings: DEFAULT_CLASSIFICATION_SETTINGS,
    usdPerGbp: 1 / 0.79,
    ...overrides,
  };
}

function listing(price: number): ListingCandidate {
  return {
    listingId: "L1",
    title: "Umbreon VMAX Evolving Skies 215/203 Alt Art",
    price,
    shippingCost: 2,
    itemUrl: "https://ebay.example/L1",
    sellerFeedbackScore: 9120,
    sellerFeedbackPct: 99.9,
    parsedIdentity: {
      game: "pokemon",
      name: "Umbreon VMAX",
      setName: "Evolving Skies",
      setCode: "EVS",
      cardNumber: "215/203",
      year: 2021,
      language: "EN",
      edition: "unlimited",
      variant: "alt_art",
      finish: "holo",
    },
  };
}

/** His card, in his numbers: £200 raw, £500 at PSA 5, rising from there. */
function snapshot(over: Partial<MarketSnapshotLike> = {}): MarketSnapshotLike {
  return {
    sourceProvider: "test",
    priceTimestamp: "2026-09-19T00:00:00.000Z",
    rawMarketPrice: 200,
    rawMedian7d: 200,
    rawMedian30d: 205,
    rawQsv: 184,
    psa1: 210,
    psa2: 260,
    psa3: 330,
    psa4: 410,
    psa5: 500,
    psa6: 620,
    psa7: 780,
    psa8: 1100,
    psa9: 1900,
    psa10: 4200,
    confidence: 0.85,
    liquidity: "HIGH",
    sampleSize: 40,
    ...over,
  };
}

function gradeFor(price: number, snap: MarketSnapshotLike = snapshot()) {
  const candidate = listing(price);
  const resolved = resolveCardPrinting(candidate.parsedIdentity);
  const hash = resolved.printing ? resolved.printing.printingHash : hashPrinting(candidate.parsedIdentity as never);
  const results = buildOpportunities([candidate], new Map([[hash, snap]]), settings());
  return results.find((r) => r.strategy === "GRADE")!;
}

describe("buy at £200, sell at £500 as a PSA 5", () => {
  it("prices the trade at PSA 5 at all — the thing that was impossible", () => {
    const grade = gradeFor(200);

    expect(grade.psa5Profit).not.toBeNull();
    expect(typeof grade.psa5Profit).toBe("number");
  });

  it("finds it profitable at PSA 5, and says so in the persisted figure", () => {
    const grade = gradeFor(200);

    // £500 slab less eBay's cut and postage, against £200 + £2 postage + the
    // grading fee. The exact figure is the fee model's business; what this
    // pins is that it is computed, positive, and stored where the dashboard's
    // "must make at least £X at PSA 5" filter reads it.
    expect(grade.psa5Profit!).toBeGreaterThan(0);
  });

  it("reports the break-even BELOW 6, which no five-rung ladder could", () => {
    const grade = gradeFor(200);

    expect(grade.breakEvenGrade).not.toBeNull();
    expect(grade.breakEvenGrade!).toBeLessThan(6);
  });

  it("carries the whole scale to the dashboard, not just the top half", () => {
    const grade = gradeFor(200);

    expect(grade.gradeRungs!.map((r) => r.grade)).toEqual([...PSA_GRADES]);
  });

  it("qualifies, so it reaches the feed rather than being computed and hidden", () => {
    expect(gradeFor(200).state).toBe("QUALIFIED_GRADE");
  });
});

/**
 * The other half of "I don't care what the raw price is under £1,000". A £60
 * card and a £600 card are the same trade at different sizes, and the engine
 * must not treat them differently.
 */
describe("the same trade at a different size behaves the same way", () => {
  it("prices a cheap card and an expensive one on the same rungs", () => {
    const cheap = gradeFor(
      60,
      snapshot({ rawMarketPrice: 60, rawQsv: 55, psa1: 65, psa2: 78, psa3: 99, psa4: 123, psa5: 150, psa6: 186, psa7: 234, psa8: 330, psa9: 570, psa10: 1260 }),
    );
    const dear = gradeFor(600, snapshot({ rawMarketPrice: 600, rawQsv: 552, psa1: 630, psa2: 780, psa3: 990, psa4: 1230, psa5: 1500, psa6: 1860, psa7: 2340, psa8: 3300, psa9: 5700, psa10: 12600 }));

    expect(cheap.gradeRungs!.map((r) => r.grade)).toEqual(dear.gradeRungs!.map((r) => r.grade));
    expect(cheap.psa5Profit).not.toBeNull();
    expect(dear.psa5Profit).not.toBeNull();
  });
});

/**
 * BLANK IS NOT ZERO, on the half of the scale where blanks are commonest.
 * Low grades have the thinnest sales, so a card with no PSA 2 price is the
 * normal case, not the edge case. Reading that as £0 would report every such
 * card as guaranteed to lose money at PSA 2 — a claim nobody measured.
 */
describe("a grade with no price is untested, not worthless", () => {
  it("leaves the rung null rather than pricing it at zero", () => {
    const grade = gradeFor(200, snapshot({ psa1: null, psa2: null, psa3: null }));

    for (const g of [1, 2, 3] as const) {
      const rung = grade.gradeRungs!.find((r) => r.grade === g)!;
      expect(rung.grossSlabValue).toBeNull();
      expect(rung.profit).toBeNull();
    }
  });

  it("persists those grades as null, so a profit floor can never be satisfied by a blank", () => {
    const grade = gradeFor(200, snapshot({ psa1: null, psa2: null, psa3: null }));

    expect(grade.psa1Profit).toBeNull();
    expect(grade.psa2Profit).toBeNull();
    expect(grade.psa3Profit).toBeNull();
    // The grades that DO have prices are unaffected.
    expect(grade.psa5Profit).not.toBeNull();
  });

  it("names the untested grades beneath the break-even instead of staying quiet", () => {
    const ladder = computeGradeLadder({
      totalGradedBasis: 230,
      slabValues: { 5: 500, 6: 620, 7: 780, 8: 1100, 9: 1900, 10: 4200 },
    });

    // "Breaks even at 5" is only half the story if 1 to 4 were never checked.
    expect(ladder.breakEvenGrade).toBe(5);
    expect(ladder.breakEvenUntestedBelow).toEqual([1, 2, 3, 4]);
  });
});
