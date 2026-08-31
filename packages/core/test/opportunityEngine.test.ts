import { describe, it, expect } from "vitest";
import { buildOpportunities } from "../src/opportunity/engine.js";
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

/** Snapshot map keyed the way the engine looks it up — by printing hash. */
function snapshotsFor(candidate: ListingCandidate, snap: MarketSnapshotLike): Map<string, MarketSnapshotLike> {
  const resolved = resolveCardPrinting(candidate.parsedIdentity);
  const hash = resolved.printing ? resolved.printing.printingHash : hashPrinting(candidate.parsedIdentity as never);
  return new Map([[hash, snap]]);
}

describe("buildOpportunities — qualification, then ranking", () => {
  it("qualifies a genuinely profitable flip", () => {
    const candidate = listing();
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const flip = results.find((r) => r.strategy === "FLIP")!;

    expect(flip.state).toBe("QUALIFIED_FLIP");
    expect(flip.qualifies).toBe(true);
    expect(flip.expectedNetProfit!).toBeGreaterThanOrEqual(40);
    expect(flip.returnOnCapital!).toBeGreaterThanOrEqual(0.4);
  });

  it("SCORE NEVER GATES: a low-scoring but economically qualifying trade still qualifies", () => {
    const candidate = listing();
    const results = buildOpportunities(
      [candidate],
      snapshotsFor(candidate, snapshot()),
      // Weight the score entirely on listing quality, then give the listing
      // an awful seller — the score collapses while economics are untouched.
      settings({
        flipScoreWeights: {
          returnOnCapital: 0,
          netProfit: 0,
          liquidity: 0,
          confidence: 0,
          listingQuality: 1,
        },
      }),
    );

    const flip = results.find((r) => r.strategy === "FLIP")!;
    expect(flip.qualifies).toBe(true);
    expect(flip.state).toBe("QUALIFIED_FLIP");
    // Qualification stands regardless of where the score landed.
    expect(flip.score).not.toBeNull();
  });

  it("does not qualify a trade purely because it scores well", () => {
    const candidate = listing({ price: 280 }); // barely underpriced -> thin economics
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const flip = results.find((r) => r.strategy === "FLIP")!;

    expect(flip.qualifies).toBe(false);
    expect(flip.state).toBe("WATCH");
    expect(flip.score).not.toBeNull(); // still scored, still shown
  });

  it("keeps non-qualifying candidates visible with their failure reasons", () => {
    const candidate = listing({ price: 280 });
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const flip = results.find((r) => r.strategy === "FLIP")!;

    expect(flip.qualificationFailures.length).toBeGreaterThan(0);
    expect(flip.expectedNetProfit).not.toBeNull(); // economics still computed and shown
  });

  it("prices flips off sold medians, never off the headline market average", () => {
    const candidate = listing();
    const results = buildOpportunities(
      [candidate],
      // Market "average" is wildly above the sold medians.
      snapshotsFor(candidate, snapshot({ rawMarketPrice: 5000, rawMedian7d: 300, rawMedian30d: 310 })),
      settings(),
    );

    const flip = results.find((r) => r.strategy === "FLIP")!;
    expect(flip.qsv).toBeCloseTo(276, 0); // 300 * 0.92
    expect(flip.qsv!).toBeLessThan(500);
  });

  it("refuses to qualify a flip priced off a fallback reference", () => {
    const candidate = listing();
    const results = buildOpportunities(
      [candidate],
      snapshotsFor(candidate, snapshot({ rawMedian7d: null, rawMedian30d: null })),
      settings(),
    );

    const flip = results.find((r) => r.strategy === "FLIP")!;
    expect(flip.isHighConfidenceQsv).toBe(false);
    expect(flip.qualifies).toBe(false);
    expect(flip.qualificationFailures.map((f) => f.rule)).toContain("qsvBasis");
  });

  it("qualifies a grading candidate and reports its economic class", () => {
    const candidate = listing();
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const grade = results.find((r) => r.strategy === "GRADE")!;

    expect(grade.economicClass).toBeDefined();
    expect(grade.gradeRungs!.length).toBe(5);
    expect(grade.totalGradedBasis!).toBeGreaterThan(candidate.price);
    expect(grade.gradingServiceId).toBeTruthy();
  });

  it("surfaces required PSA10 hit rates on every grading candidate", () => {
    const candidate = listing();
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const grade = results.find((r) => r.strategy === "GRADE")!;

    expect(grade.requiredPsa10RateVsPsa9).toBeDefined();
    expect(grade.requiredPsa10RateVsPsa8).toBeDefined();
  });

  it("surfaces an asymmetric candidate rather than discarding it for losing at PSA8", () => {
    const candidate = listing({ price: 200 });
    const results = buildOpportunities(
      [candidate],
      snapshotsFor(
        candidate,
        snapshot({ psa7: 40, psa8: 90, psa9: 200, psa10: 6000, rawMedian7d: 250, rawMedian30d: 250 }),
      ),
      settings(),
    );

    const grade = results.find((r) => r.strategy === "GRADE")!;
    expect(grade.economicClass).toBe("ASYMMETRIC");
    expect(grade.psa8Profit!).toBeLessThan(0);
    expect(grade.qualifies).toBe(true); // discovered, not thrown away
  });

  it("reports capital lock and velocity on grading candidates", () => {
    const candidate = listing();
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const grade = results.find((r) => r.strategy === "GRADE")!;

    expect(grade.estimatedGradingDays!).toBeGreaterThan(0);
    expect(grade.estimatedCapitalLockDays!).toBeGreaterThan(grade.estimatedGradingDays!);
    expect(grade.annualisedRocIndicator).toBeDefined();
  });

  it("marks NO_MARKET_DATA when there is no snapshot for the printing", () => {
    const candidate = listing();
    const results = buildOpportunities([candidate], new Map(), settings());
    expect(results.every((r) => r.state === "NO_MARKET_DATA")).toBe(true);
  });

  it("rejects a listing whose identity cannot be resolved", () => {
    const candidate = listing({
      parsedIdentity: { game: "pokemon", name: "Mystery Card" } as never,
    });
    const results = buildOpportunities([candidate], new Map(), settings());

    expect(results.every((r) => r.state === "REJECTED_CARD_IDENTITY_UNCERTAIN")).toBe(true);
    expect(results.every((r) => r.qualifies === false)).toBe(true);
  });

  it("downgrades a qualifying trade to INSPECT_PHOTOS when identity is uncertain", () => {
    const candidate = listing({
      // 1st Edition on a modern year: resolver lowers confidence below the
      // inspect threshold but stays above the reject threshold.
      parsedIdentity: { ...listing().parsedIdentity, edition: "1st", year: 2021 },
    });
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const flip = results.find((r) => r.strategy === "FLIP")!;

    expect(flip.identityConfidence).toBeLessThan(0.85);
    expect(flip.state).toBe("INSPECT_PHOTOS");
    expect(flip.qualifies).toBe(true); // economics unchanged
  });

  it("honours the strategy filter", () => {
    const candidate = listing();
    const results = buildOpportunities(
      [candidate],
      snapshotsFor(candidate, snapshot()),
      settings({
        qualification: {
          strategy: "FLIP",
          flip: { ...DEFAULT_FLIP_QUALIFICATION },
          grade: { ...DEFAULT_GRADE_QUALIFICATION },
        },
      }),
    );

    expect(results.every((r) => r.strategy === "FLIP")).toBe(true);
  });

  it("respects edited qualification thresholds with no code change", () => {
    const candidate = listing();
    const snaps = snapshotsFor(candidate, snapshot());

    const permissive = buildOpportunities([candidate], snaps, settings());
    const strict = buildOpportunities(
      [candidate],
      snaps,
      settings({
        qualification: {
          strategy: "BOTH",
          flip: { ...DEFAULT_FLIP_QUALIFICATION, minNetProfit: 100_000 },
          grade: { ...DEFAULT_GRADE_QUALIFICATION },
        },
      }),
    );

    expect(permissive.find((r) => r.strategy === "FLIP")!.qualifies).toBe(true);
    expect(strict.find((r) => r.strategy === "FLIP")!.qualifies).toBe(false);
  });
});
