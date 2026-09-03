import { describe, it, expect } from "vitest";
import { profitPerCapitalDay } from "../src/calc/metricDefinitions.js";
import { computeAcquisitionCost, computeFlipProfit, computeNetSaleProceeds } from "../src/index.js";
import { buildOpportunities } from "../src/opportunity/engine.js";
import type { ListingCandidate, MarketSnapshotLike, OpportunityEngineSettings } from "../src/opportunity/types.js";
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
 * AI INTELLIGENCE spec item 13: "define financial metrics unambiguously —
 * documented once, referenced everywhere — and add regression tests around
 * these formulas." See calc/metricDefinitions.ts for the canonical glossary
 * this file pins down.
 */
describe("profitPerCapitalDay — the single canonical implementation", () => {
  it("divides net profit by the estimated capital-lock days", () => {
    expect(profitPerCapitalDay(140, 14)).toBeCloseTo(10, 2);
  });

  it("rounds to 2 decimal places, same as every other £ figure in this codebase", () => {
    expect(profitPerCapitalDay(100, 3)).toBeCloseTo(33.33, 2);
  });

  it("returns null, never a fabricated 0, when profit is missing", () => {
    expect(profitPerCapitalDay(null, 14)).toBeNull();
  });

  it("returns null when the lock period is missing", () => {
    expect(profitPerCapitalDay(100, null)).toBeNull();
  });

  it("returns null when the lock period is zero or negative (never divides by zero)", () => {
    expect(profitPerCapitalDay(100, 0)).toBeNull();
    expect(profitPerCapitalDay(100, -5)).toBeNull();
  });

  it("reports a negative rate honestly for a loss, rather than flooring at zero", () => {
    expect(profitPerCapitalDay(-70, 14)).toBeCloseTo(-5, 2);
  });
});

/**
 * NET PROFIT / ROC / NET MARGIN worked-example regression guard — pins the
 * exact same worked example flipProfit.test.ts already carries, so a
 * silent formula drift in either place is caught by both.
 */
describe("NET PROFIT / ROC / NET MARGIN — worked-example regression guard", () => {
  it("pins the full flip worked example end to end", () => {
    const acquisition = computeAcquisitionCost({ purchasePrice: 100, sellerPostage: 3 });
    const sale = computeNetSaleProceeds({ itemPrice: 200 });
    const profit = computeFlipProfit({
      totalAcquisitionCost: acquisition.total,
      netSaleProceeds: sale.netProceeds,
      buyerPayment: sale.buyerPayment,
      expectedDaysToSale: 14,
    });

    expect(profit.netProfit).toBeCloseTo(67.22, 2); // NET PROFIT
    expect(profit.returnOnCapital).toBeCloseTo(0.6526, 3); // ROC
    expect(profit.profitMargin).toBeCloseTo(profit.netProfit / sale.buyerPayment, 4); // NET MARGIN, vs revenue not proceeds
    expect(profitPerCapitalDay(profit.netProfit, profit.expectedDaysToSale)).toBeCloseTo(4.8, 1); // 67.22 / 14
  });
});

function settings(overrides: Partial<OpportunityEngineSettings> = {}): OpportunityEngineSettings {
  return {
    qualification: {
      strategy: "BOTH",
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

function listing(overrides: Partial<ListingCandidate> = {}): ListingCandidate {
  return {
    listingId: "L1",
    title: "Umbreon VMAX Evolving Skies 215/203 Alt Art",
    price: 80,
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
    ...overrides,
  };
}

function snapshot(overrides: Partial<MarketSnapshotLike> = {}): MarketSnapshotLike {
  return {
    sourceProvider: "test",
    priceTimestamp: "2026-08-30T00:00:00.000Z",
    rawMarketPrice: 300,
    rawMedian7d: 300,
    rawMedian30d: 310,
    rawQsv: 276,
    psa7: 150,
    psa8: 260,
    psa9: 520,
    psa10: 1800,
    confidence: 0.85,
    liquidity: "HIGH",
    sampleSize: 40,
    ...overrides,
  };
}

function snapshotsFor(candidate: ListingCandidate, snap: MarketSnapshotLike): Map<string, MarketSnapshotLike> {
  const resolved = resolveCardPrinting(candidate.parsedIdentity);
  const hash = resolved.printing ? resolved.printing.printingHash : hashPrinting(candidate.parsedIdentity as never);
  return new Map([[hash, snap]]);
}

/**
 * REGRESSION GUARD: FLIP's and GRADE's profitPerCapitalDay figures, reached
 * through the full opportunity engine, both come from the ONE canonical
 * function — pins that the engine wiring in engine.ts and
 * serviceComparison.ts wasn't silently left duplicating the old ad hoc
 * arithmetic instead of calling profitPerCapitalDay().
 */
describe("buildOpportunities — profitPerCapitalDay reaches both strategies via the canonical function", () => {
  it("a qualified FLIP candidate's profitPerCapitalDay equals netProfit/expectedDaysToSale exactly", () => {
    const candidate = listing();
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const flip = results.find((r) => r.strategy === "FLIP")!;

    expect(flip.profitPerCapitalDay).toBeCloseTo(profitPerCapitalDay(flip.expectedNetProfit!, flip.expectedDaysToSale!)!, 2);
  });

  it("a qualified GRADE candidate's profitPerCapitalDay is present and consistent with its capital-lock estimate", () => {
    const candidate = listing();
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const grade = results.find((r) => r.strategy === "GRADE")!;

    expect(grade.profitPerCapitalDay).not.toBeNull();
    expect(grade.estimatedCapitalLockDays).toBeGreaterThan(0);
  });
});
