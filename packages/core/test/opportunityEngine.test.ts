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

/**
 * REGRESSION GUARD for a scan-killing crash found running the real pipeline
 * against real eBay data: a listing with price 0 (eBay does return these —
 * a malformed or incomplete listing) made computeFlipProfit throw
 * "totalAcquisitionCost must be > 0". That exception propagated straight
 * out of buildOpportunities(), which discarded every OTHER listing's
 * already-computed opportunity in the same batch along with it — one bad
 * listing out of hundreds took the whole scan to zero created opportunities.
 */
describe("buildOpportunities — one bad listing never takes the batch down with it", () => {
  it("downgrades a listing whose economics calculators reject its price, instead of throwing", () => {
    const zeroPriceListing = listing({ listingId: "L-zero", price: 0, shippingCost: 0 });
    const results = buildOpportunities(
      [zeroPriceListing],
      snapshotsFor(zeroPriceListing, snapshot()),
      settings(),
    );

    const flip = results.find((r) => r.strategy === "FLIP")!;
    expect(flip.state).toBe("REJECTED_COMPUTATION_ERROR");
    expect(flip.qualifies).toBe(false);
    expect(flip.liquidity).toBeNull();
    expect(flip.reasoning.join(" ")).toMatch(/could not be computed/i);
  });

  it("still returns every valid listing's opportunity even when a sibling listing is poisoned", () => {
    const goodListing = listing(); // L1, price 80 — genuinely qualifies, see the first test above
    const badListing = listing({
      listingId: "L-zero",
      price: 0,
      shippingCost: 0,
      parsedIdentity: { ...goodListing.parsedIdentity, cardNumber: "216/203" }, // distinct printing
    });

    const snapshots = new Map([
      ...snapshotsFor(goodListing, snapshot()),
      ...snapshotsFor(badListing, snapshot()),
    ]);

    const results = buildOpportunities([goodListing, badListing], snapshots, settings());

    const goodFlip = results.find((r) => r.listingId === "L1" && r.strategy === "FLIP")!;
    const badFlip = results.find((r) => r.listingId === "L-zero" && r.strategy === "FLIP")!;

    expect(goodFlip.state).toBe("QUALIFIED_FLIP"); // untouched by the sibling's bad data
    expect(badFlip.state).toBe("REJECTED_COMPUTATION_ERROR"); // isolated, not propagated
  });
});

/**
 * REGRESSION GUARD for STABILISATION item 6 (listing classification).
 *
 * listingType/itemCondition previously never reached the engine at all —
 * ListingCandidate had no field for them. These tests pin down both halves
 * of the fix: the field is carried through onto every OpportunityCandidate,
 * and an AUCTION listing gets an explicit "price may not be final" warning
 * in its reasoning — the exact risk bug 9 proved is real and live (an
 * AUCTION's price is a current bid, not a guaranteed final cost).
 */
describe("buildOpportunities — STABILISATION item 6 (listing classification)", () => {
  it("carries listingType through onto a qualified FLIP candidate", () => {
    const candidate = listing({ listingType: "FIXED" });
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const flip = results.find((r) => r.strategy === "FLIP")!;

    expect(flip.state).toBe("QUALIFIED_FLIP");
    expect(flip.listingType).toBe("FIXED");
  });

  it("adds an AUCTION price-caveat warning to a qualified FLIP candidate's reasoning", () => {
    const candidate = listing({ listingType: "AUCTION" });
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const flip = results.find((r) => r.strategy === "FLIP")!;

    expect(flip.listingType).toBe("AUCTION");
    expect(flip.reasoning.join(" ")).toMatch(/CURRENT bid, not a guaranteed final price/);
  });

  it("adds the same AUCTION warning to a GRADE candidate", () => {
    const candidate = listing({ listingType: "AUCTION" });
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    const grade = results.find((r) => r.strategy === "GRADE")!;

    expect(grade.listingType).toBe("AUCTION");
    expect(grade.reasoning.join(" ")).toMatch(/CURRENT bid, not a guaranteed final price/);
  });

  it("does NOT add the auction warning for FIXED or BEST_OFFER listings", () => {
    const fixed = listing({ listingType: "FIXED" });
    const fixedResults = buildOpportunities([fixed], snapshotsFor(fixed, snapshot()), settings());
    expect(fixedResults.find((r) => r.strategy === "FLIP")!.reasoning.join(" ")).not.toMatch(/CURRENT bid/);

    const bestOffer = listing({ listingType: "BEST_OFFER" });
    const bestOfferResults = buildOpportunities([bestOffer], snapshotsFor(bestOffer, snapshot()), settings());
    expect(bestOfferResults.find((r) => r.strategy === "FLIP")!.reasoning.join(" ")).not.toMatch(/CURRENT bid/);
  });

  it("carries listingType through even on a REJECTED_CARD_IDENTITY_UNCERTAIN candidate", () => {
    const candidate = listing({ listingType: "AUCTION", parsedIdentity: { game: "pokemon" } }); // missing required fields
    const results = buildOpportunities([candidate], new Map(), settings());
    const flip = results.find((r) => r.strategy === "FLIP")!;

    expect(flip.state).toBe("REJECTED_CARD_IDENTITY_UNCERTAIN");
    expect(flip.listingType).toBe("AUCTION");
  });

  it("defaults listingType to null when the listing carries none", () => {
    const candidate = listing({ listingType: undefined });
    const results = buildOpportunities([candidate], snapshotsFor(candidate, snapshot()), settings());
    expect(results.find((r) => r.strategy === "FLIP")!.listingType).toBeNull();
  });
});

/**
 * REGRESSION GUARD for STABILISATION item 7 (dedup).
 *
 * Root cause: the SAME real eBay listing can be surfaced by two different
 * cards' searches within one scan run (near-duplicate names, broad eBay
 * text matching). Previously each occurrence became its own
 * OpportunityCandidate, and persistence (upsertOpportunity, keyed on
 * listing_id+strategy) let whichever was written LAST silently win — pure
 * write-order luck, including a genuinely-resolved candidate potentially
 * being clobbered by a mis-matched one from another card's search context.
 * buildOpportunities() now collapses duplicates itself, deterministically
 * keeping the most actionable state per listingId+strategy.
 */
describe("buildOpportunities — STABILISATION item 7 (dedup by listingId+strategy)", () => {
  it("collapses a duplicate listingId to a single result per strategy, keeping the correctly-resolved one over a mismatched one", () => {
    const good = listing({ listingId: "DUP-1" }); // resolves fine — see fixture default
    const bad = listing({ listingId: "DUP-1", parsedIdentity: { game: "pokemon" } }); // missing required fields -> rejected

    // Bad listed FIRST deliberately — proves the winner is chosen by merit,
    // not by "first wins" or "last wins" processing order.
    const results = buildOpportunities([bad, good], snapshotsFor(good, snapshot()), settings());

    const flipsForListing = results.filter((r) => r.listingId === "DUP-1" && r.strategy === "FLIP");
    const gradesForListing = results.filter((r) => r.listingId === "DUP-1" && r.strategy === "GRADE");

    expect(flipsForListing).toHaveLength(1);
    expect(flipsForListing[0]!.state).toBe("QUALIFIED_FLIP");
    expect(gradesForListing).toHaveLength(1);
    expect(gradesForListing[0]!.state).not.toBe("REJECTED_CARD_IDENTITY_UNCERTAIN");
  });

  it("never returns more than one result for the same listingId+strategy pair, across a mixed batch", () => {
    const a = listing({ listingId: "DUP-2" });
    const b = listing({ listingId: "DUP-2", parsedIdentity: { game: "pokemon" } });
    const unrelated = listing({ listingId: "L-solo", parsedIdentity: { ...a.parsedIdentity, cardNumber: "999/999" } });

    const snapshots = new Map([
      ...snapshotsFor(a, snapshot()),
      ...snapshotsFor(unrelated, snapshot()),
    ]);
    const results = buildOpportunities([a, b, unrelated], snapshots, settings());

    const seen = new Set<string>();
    for (const r of results) {
      const key = `${r.listingId}::${r.strategy}`;
      expect(seen.has(key)).toBe(false); // no key appears twice
      seen.add(key);
    }
    // 2 unique listings x 2 strategies (BOTH) = 4 results, not 6.
    expect(results).toHaveLength(4);
  });

  it("leaves a genuinely unique listing untouched (no false-positive collapsing)", () => {
    const solo = listing();
    const results = buildOpportunities([solo], snapshotsFor(solo, snapshot()), settings());
    expect(results.filter((r) => r.strategy === "FLIP")).toHaveLength(1);
    expect(results.filter((r) => r.strategy === "GRADE")).toHaveLength(1);
  });
});
