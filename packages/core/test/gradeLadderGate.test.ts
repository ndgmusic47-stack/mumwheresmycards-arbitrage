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

/**
 * THE WIRING, not the rule. gradeLadderPlausibility.test.ts proves the
 * function; this proves it is actually reached by a real candidate and
 * actually changes what the operator is shown.
 *
 * That distinction is the whole point here. The four REVIEW states added
 * before this one were each computed correctly, stored correctly, and
 * unreachable from the dashboard for weeks, because passing unit tests was
 * mistaken for the feature working.
 */
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

function gradeFor(snap: MarketSnapshotLike, over: Partial<OpportunityEngineSettings> = {}) {
  const candidate = listing();
  const results = buildOpportunities([candidate], snapshotsFor(candidate, snap), settings(over));
  return results.find((r) => r.strategy === "GRADE")!;
}

describe("a contradicting ladder is pulled out of the actionable feed", () => {
  it("leaves an ordinary ladder qualified — the control", () => {
    const grade = gradeFor(snapshot());

    expect(grade.state).toBe("QUALIFIED_GRADE");
  });

  it("moves a backwards ladder to review instead of showing it as a buy", () => {
    // PSA 9 dearer than the PSA 10 of the same card.
    const grade = gradeFor(snapshot({ psa9: 2400, psa10: 1800 }));

    expect(grade.state).toBe("REVIEW_SLAB_DATA_IMPLAUSIBLE");
    expect(grade.reasoning[0]).toContain("CONTRADICT THEMSELVES");
  });

  it("moves the thin-top-tier shape to review — the one that filled the feed", () => {
    // 100x, on a ladder that is otherwise perfectly well behaved — so this
    // can only be failing on the jump, not on an inversion smuggled in by
    // the fixture. The live feed's worst band averaged a £31,922 PSA 10 on a
    // £19.55 card; this is the same fault at a testable scale.
    const grade = gradeFor(snapshot({ psa7: 40, psa8: 60, psa9: 100, psa10: 10000 }));

    expect(grade.state).toBe("REVIEW_SLAB_DATA_IMPLAUSIBLE");
    expect(grade.reasoning[0]).toContain("100.0x");
  });

  it("leaves every computed figure exactly as computed", () => {
    const clean = gradeFor(snapshot({ psa9: 2400, psa10: 1800 }));

    // Reviewing is a statement about the EVIDENCE. Quietly zeroing or
    // re-deriving the economics would be inventing a number to replace one
    // we have merely stopped trusting.
    expect(clean.psa10Value).toBe(1800);
    expect(clean.gradeRungs?.length).toBeGreaterThan(0);
    expect(clean.totalGradedBasis).not.toBeNull();
  });

  it("is still counted as qualifying, so nothing vanishes from the totals", () => {
    const grade = gradeFor(snapshot({ psa9: 2400, psa10: 1800 }));

    // Same contract as the other REVIEW states: the economics cleared the
    // bar, and a human has to settle something before it is actionable.
    expect(grade.qualifies).toBe(true);
  });
});

describe("it does not overrule a sharper finding about the listing itself", () => {
  it("keeps REVIEW_PRICE_IMPLAUSIBLE, and still says the ladder is broken", () => {
    // £3 delivered against a card worth hundreds raw: price plausibility
    // owns this row, because whether the card is the card comes first.
    const candidate = listing({ price: 1, shippingCost: 2 });
    const results = buildOpportunities(
      [candidate],
      snapshotsFor(candidate, snapshot({ psa9: 2400, psa10: 1800 })),
      settings(),
    );
    const grade = results.find((r) => r.strategy === "GRADE")!;

    expect(grade.state).toBe("REVIEW_PRICE_IMPLAUSIBLE");
    // Both facts survive — one of them being more urgent does not make the
    // other one stop being true.
    expect(grade.reasoning.some((r) => r.includes("CONTRADICT THEMSELVES"))).toBe(true);
  });
});

describe("the threshold is the operator's, not the engine's", () => {
  it("honours a raised limit", () => {
    // 15x, on an otherwise rising ladder — the only thing either run can be
    // deciding on is where the limit sits.
    const snap = snapshot({ psa7: 40, psa8: 60, psa9: 100, psa10: 1500 });

    expect(gradeFor(snap).state).toBe("REVIEW_SLAB_DATA_IMPLAUSIBLE");
    expect(gradeFor(snap, { maxPsa10OverPsa9: 20 }).state).toBe("QUALIFIED_GRADE");
  });
});
