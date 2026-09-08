import { describe, it, expect } from "vitest";
import { buildOpportunities } from "../src/opportunity/engine.js";
import { computeFlipProfile } from "../src/market/flipProfile.js";
import { computeQsv } from "../src/market/qsv.js";
import type { ListingCandidate, MarketSnapshotLike, OpportunityEngineSettings } from "../src/opportunity/types.js";
import type { ProfileSnapshotInput } from "../src/market/types.js";
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
 * REGRESSION GUARD, fixed 2026-09-08: QSV was being discounted TWICE.
 *
 * The PokeTrace adapter (packages/providers/src/market/PokeTraceProvider.ts)
 * runs computeQsv() once and stores its OUTPUT on the snapshot — `rawQsv`
 * (already haircut) and `confidence` (already carrying the single-median
 * multiplier / fallback ceiling). The engine (engine.ts) and the market
 * profiler (flipProfile.ts) then ran computeQsv() AGAIN on that stored
 * output, treating it as raw input:
 *
 *  - No sold medians, provider avg £100: provider stores rawQsv = £92.
 *    Engine then used rawQsv as the "fallback reference" and haircut it
 *    again -> £84.64. Fix: the fallback reference is the UN-haircut
 *    rawMarketPrice (the provider average), which is what that parameter
 *    is documented to be.
 *  - Exactly one sold median, provider base confidence 0.8: provider
 *    stores confidence = 0.8 x 0.75 = 0.6. Engine then applied the 0.75
 *    single-median multiplier to that -> 0.45. Fix: the consumers tell
 *    computeQsv the confidence they're handing over is already penalised.
 *
 * Both errors ran CONSERVATIVE (a lower QSV and a lower confidence than
 * the model actually specifies), so nothing was ever inflated by this —
 * but they silently hid real candidates and skewed every ranking built on
 * those two numbers. Every fixture below is shaped exactly as the real
 * adapter would produce it (post-first-pass values), not as raw inputs.
 */

const HAIRCUT = 1 - DEFAULT_QSV_SETTINGS.quickSaleHaircutPct; // 0.92
const SINGLE_MEDIAN_MULT = DEFAULT_QSV_SETTINGS.singleMedianConfidenceMultiplier; // 0.75

/** What PokeTraceProvider.toSnapshot() stores for a card with NO sold
 *  medians, only an average — exactly the fallback shape. */
function providerFallbackSnapshot(avg: number, baseConfidence: number): MarketSnapshotLike {
  const first = computeQsv({ median7d: null, median30d: null, fallbackReference: avg, baseConfidence }, DEFAULT_QSV_SETTINGS);
  return {
    sourceProvider: "poketrace",
    priceTimestamp: "2026-09-08T00:00:00.000Z",
    rawMarketPrice: avg,
    rawMedian7d: null,
    rawMedian30d: null,
    rawQsv: first.qsv, // already haircut once
    psa7: 150,
    psa8: 260,
    psa9: 520,
    psa10: 1800,
    confidence: first.confidence, // already capped once
    liquidity: "MEDIUM",
    sampleSize: 6,
  };
}

/** What the adapter stores for a card with ONE sold median. */
function providerSingleMedianSnapshot(median7d: number, avg: number, baseConfidence: number): MarketSnapshotLike {
  const first = computeQsv({ median7d, median30d: null, fallbackReference: avg, baseConfidence }, DEFAULT_QSV_SETTINGS);
  return {
    sourceProvider: "poketrace",
    priceTimestamp: "2026-09-08T00:00:00.000Z",
    rawMarketPrice: avg,
    rawMedian7d: median7d,
    rawMedian30d: null,
    rawQsv: first.qsv,
    psa7: 150,
    psa8: 260,
    psa9: 520,
    psa10: 1800,
    confidence: first.confidence, // already multiplied once
    liquidity: "MEDIUM",
    sampleSize: 12,
  };
}

function engineSettings(): OpportunityEngineSettings {
  return {
    qualification: { strategy: "BOTH", flip: { ...DEFAULT_FLIP_QUALIFICATION }, grade: { ...DEFAULT_GRADE_QUALIFICATION } },
    qsvSettings: DEFAULT_QSV_SETTINGS,
    feeModel: DEFAULT_EXIT_MARKET_FEE_MODEL,
    sellingCosts: DEFAULT_SELLING_COSTS,
    gradingServices: DEFAULT_GRADING_SERVICES,
    gradingBatch: DEFAULT_GRADING_BATCH,
    gradingConsumables: DEFAULT_GRADING_CONSUMABLES,
    classificationSettings: DEFAULT_CLASSIFICATION_SETTINGS,
    usdPerGbp: 1 / 0.79,
  };
}

function listing(): ListingCandidate {
  return {
    listingId: "L1",
    title: "Umbreon VMAX Evolving Skies 215/203 Alt Art",
    price: 50,
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

function flipFor(snap: MarketSnapshotLike) {
  const candidate = listing();
  const resolved = resolveCardPrinting(candidate.parsedIdentity);
  const hash = resolved.printing ? resolved.printing.printingHash : hashPrinting(candidate.parsedIdentity as never);
  const results = buildOpportunities([candidate], new Map([[hash, snap]]), engineSettings());
  return results.find((r) => r.strategy === "FLIP")!;
}

function asProfileInput(snap: MarketSnapshotLike): ProfileSnapshotInput {
  return {
    rawMarketPrice: snap.rawMarketPrice,
    rawMedian7d: snap.rawMedian7d,
    rawMedian30d: snap.rawMedian30d,
    rawQsv: snap.rawQsv,
    psa6: null,
    psa7: snap.psa7,
    psa8: snap.psa8,
    psa9: snap.psa9,
    psa10: snap.psa10,
    confidence: snap.confidence,
    liquidity: snap.liquidity,
    sampleSize: snap.sampleSize,
  };
}

describe("QSV is discounted exactly once — fallback (no sold medians) path", () => {
  const snap = providerFallbackSnapshot(100, 0.9);

  it("provider-side fixture sanity: rawQsv is the avg haircut once", () => {
    expect(snap.rawQsv).toBeCloseTo(100 * HAIRCUT, 2); // 92
  });

  it("engine: QSV equals the avg haircut ONCE (£92), not twice (£84.64)", () => {
    const flip = flipFor(snap);
    expect(flip.qsv).toBeCloseTo(100 * HAIRCUT, 2);
    expect(flip.qsv).not.toBeCloseTo(100 * HAIRCUT * HAIRCUT, 2);
  });

  it("market profiler: conservativeQsv equals the avg haircut ONCE", () => {
    const profile = computeFlipProfile(asProfileInput(snap));
    expect(profile.conservativeQsv).toBeCloseTo(100 * HAIRCUT, 2);
  });

  it("engine and profiler agree with each other on the fallback QSV", () => {
    expect(flipFor(snap).qsv).toBeCloseTo(computeFlipProfile(asProfileInput(snap)).conservativeQsv!, 6);
  });
});

describe("confidence is penalised exactly once — single-sold-median path", () => {
  const snap = providerSingleMedianSnapshot(100, 110, 0.8);

  it("provider-side fixture sanity: confidence carries the single-median multiplier once", () => {
    expect(snap.confidence).toBeCloseTo(0.8 * SINGLE_MEDIAN_MULT, 4); // 0.6
  });

  it("engine: confidence stays at the provider's once-penalised value, not multiplied again", () => {
    const flip = flipFor(snap);
    expect(flip.confidence).toBeCloseTo(0.8 * SINGLE_MEDIAN_MULT, 4);
    expect(flip.confidence).not.toBeCloseTo(0.8 * SINGLE_MEDIAN_MULT * SINGLE_MEDIAN_MULT, 4);
    // And the QSV itself was never wrong on this path — pinned so a fix
    // for the confidence can't regress it.
    expect(flip.qsv).toBeCloseTo(100 * HAIRCUT, 2);
  });

  it("market profiler: same — penalised once", () => {
    const profile = computeFlipProfile(asProfileInput(snap));
    expect(profile.confidence).toBeCloseTo(0.8 * SINGLE_MEDIAN_MULT, 4);
  });
});

describe("computeQsv confidenceAlreadyPenalised flag", () => {
  it("skips the single-median multiplier when told the input confidence already carries it", () => {
    const fresh = computeQsv({ median7d: 100, median30d: null, baseConfidence: 0.8 });
    const passthrough = computeQsv({ median7d: 100, median30d: null, baseConfidence: fresh.confidence, confidenceAlreadyPenalised: true });
    expect(passthrough.confidence).toBeCloseTo(fresh.confidence, 6);
    expect(passthrough.qsv).toBeCloseTo(fresh.qsv!, 6);
  });

  it("is a no-op on the both-medians path (no penalty exists there to skip)", () => {
    const a = computeQsv({ median7d: 100, median30d: 120, baseConfidence: 0.8 });
    const b = computeQsv({ median7d: 100, median30d: 120, baseConfidence: 0.8, confidenceAlreadyPenalised: true });
    expect(b).toEqual(a);
  });

  it("still applies the fallback ceiling (min is idempotent, so this is safe either way)", () => {
    const b = computeQsv({ median7d: null, median30d: null, fallbackReference: 100, baseConfidence: 0.9, confidenceAlreadyPenalised: true });
    expect(b.confidence).toBeCloseTo(DEFAULT_QSV_SETTINGS.fallbackConfidenceCeiling, 6);
  });
});
