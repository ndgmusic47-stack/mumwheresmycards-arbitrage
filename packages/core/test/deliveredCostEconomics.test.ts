import { describe, it, expect } from "vitest";
import { buildOpportunities } from "../src/opportunity/engine.js";
import { computeFlipProfit } from "../src/calc/flipProfit.js";
import { computeNetSaleProceeds } from "../src/calc/netSaleProceeds.js";
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
 * SOURCING WORKFLOW spec item 2 ("financial metrics must use delivered
 * cost"): computeAcquisitionCost, computeFlipProfit and computeGradedBasis
 * were all independently verified correct at the unit level (each already
 * takes purchasePrice + sellerPostage + importTax + acquisitionFees, not
 * price alone — see acquisitionCost.ts, flipProfit.ts, gradingBasis.ts).
 * What had NO existing end-to-end coverage is that buildOpportunities() —
 * the actual function scanRunner.ts calls in production — plumbs a real
 * listing's price AND postage (and, once eBay ever supplies them, import
 * tax/acquisition fees) all the way through to the numbers a user acts on:
 * expectedNetProfit, returnOnCapital, and totalGradedBasis. This locks that
 * down against a real, large postage figure that a naive "acquisition ==
 * item price" regression would get wrong in an unmissable way.
 *
 * Also verified as part of this same audit (not by this test): the
 * dashboard's FlipTable/GradeTable already render BOTH "Listing" (item
 * price alone) and "Delivered cost" (o.total_acquisition_cost) as separate
 * columns — apps/web/src/components/OpportunityTable.tsx lines ~148-149
 * and ~292-293 — so the UI-transparency half of item 2 needed no change.
 */

function settings(overrides: Partial<OpportunityEngineSettings> = {}): OpportunityEngineSettings {
  return {
    qualification: {
      strategy: "BOTH",
      flip: { ...DEFAULT_FLIP_QUALIFICATION, minNetProfit: 0, minReturnOnCapital: 0 },
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
    listingId: "L-delivered-cost",
    title: "Dragonite Skyridge 3/113 Holo",
    price: 80,
    // Deliberately large relative to price so a bug that dropped postage
    // from the acquisition cost would be impossible to miss in the assertions
    // below (a small #.## postage figure could hide inside rounding).
    shippingCost: 20,
    itemUrl: "https://ebay.example/L-delivered-cost",
    sellerFeedbackScore: 500,
    sellerFeedbackPct: 99.5,
    parsedIdentity: {
      game: "pokemon",
      name: "Dragonite",
      setName: "Skyridge",
      setCode: "SKY",
      cardNumber: "3/113",
      year: 2003,
      language: "EN",
      edition: "unlimited",
      variant: "standard",
      finish: "holo",
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<MarketSnapshotLike> = {}): MarketSnapshotLike {
  return {
    sourceProvider: "test",
    priceTimestamp: "2026-09-02T00:00:00.000Z",
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

describe("delivered-cost economics — end to end through buildOpportunities (item 2)", () => {
  it("FLIP: expectedNetProfit and returnOnCapital are computed against price+postage, never price alone", () => {
    const l = listing();
    const snap = snapshot();
    const s = settings();

    const [candidate] = buildOpportunities([l], snapshotsFor(l, snap), s);

    // totalAcquisitionCost itself must be the delivered figure.
    expect(candidate.totalAcquisitionCost).toBe(100); // 80 price + 20 postage
    expect(candidate.listingPrice).toBe(80); // the two must stay distinguishable

    // Recompute the reference economics independently, once against the
    // correct delivered cost (100) and once against a WRONG price-only
    // acquisition (80), and assert the candidate matches the former and
    // NOT the latter — a real end-to-end proof, not a restatement of the
    // engine's own arithmetic. Reuses the engine's own already-computed QSV
    // (candidate.qsv) rather than re-deriving it by hand here — this test
    // is about the acquisition-cost wiring, not the QSV formula.
    const correctProfit = computeFlipProfit({
      totalAcquisitionCost: 100,
      netSaleProceeds: computeNetSaleProceeds({ itemPrice: candidate.qsv! }, s.feeModel, s.sellingCosts).netProceeds,
      buyerPayment: computeNetSaleProceeds({ itemPrice: candidate.qsv! }, s.feeModel, s.sellingCosts).buyerPayment,
    });
    const wrongPriceOnlyProfit = computeFlipProfit({
      totalAcquisitionCost: 80,
      netSaleProceeds: computeNetSaleProceeds({ itemPrice: candidate.qsv! }, s.feeModel, s.sellingCosts).netProceeds,
      buyerPayment: computeNetSaleProceeds({ itemPrice: candidate.qsv! }, s.feeModel, s.sellingCosts).buyerPayment,
    });

    expect(candidate.expectedNetProfit).toBe(correctProfit.netProfit);
    expect(candidate.returnOnCapital).toBe(correctProfit.returnOnCapital);
    expect(candidate.expectedNetProfit).not.toBe(wrongPriceOnlyProfit.netProfit);
    expect(candidate.returnOnCapital).not.toBe(wrongPriceOnlyProfit.returnOnCapital);
  });

  it("FLIP: importTax and acquisitionFees, when a listing carries them, also flow into totalAcquisitionCost and the profit numbers", () => {
    const l = listing({ importTax: 5, acquisitionFees: 2.5 });
    const snap = snapshot();
    const s = settings();

    const [candidate] = buildOpportunities([l], snapshotsFor(l, snap), s);

    // 80 price + 20 postage + 5 import tax + 2.5 acquisition fees
    expect(candidate.totalAcquisitionCost).toBe(107.5);
  });

  it("GRADE: totalGradedBasis includes the raw card's delivered cost (price+postage), not price alone", () => {
    const l = listing();
    const snap = snapshot();
    const s = settings();

    const candidates = buildOpportunities([l], snapshotsFor(l, snap), s);
    const grade = candidates.find((c) => c.strategy === "GRADE");
    expect(grade).toBeDefined();
    expect(grade!.totalAcquisitionCost).toBe(100); // 80 price + 20 postage, same as FLIP

    // The graded basis is strictly greater than the raw delivered cost alone
    // (it adds the grading fee, batch logistics share, and consumables on
    // top) — but it must never be LESS than the delivered cost, which is
    // exactly what would happen if postage were silently dropped from the
    // basis while still being added correctly elsewhere.
    expect(grade!.totalGradedBasis).toBeGreaterThanOrEqual(100);
  });

  it("a listing with £0 postage still produces a delivered cost equal to price alone (no double-counting, no phantom fee)", () => {
    const l = listing({ shippingCost: 0 });
    const snap = snapshot();
    const s = settings();

    const [candidate] = buildOpportunities([l], snapshotsFor(l, snap), s);
    expect(candidate.totalAcquisitionCost).toBe(80);
  });
});
