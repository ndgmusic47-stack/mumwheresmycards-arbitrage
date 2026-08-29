import { describe, it, expect } from "vitest";
import { buildOpportunities } from "../src/opportunity/engine.js";
import type { ListingCandidate, MarketSnapshotLike, OpportunityEngineSettings } from "../src/opportunity/types.js";
import type { FilterSet } from "../src/filters/types.js";

function permissiveFilters(overrides: Partial<FilterSet> = {}): FilterSet {
  return {
    global: {
      strategy: "BOTH",
      minNetProfit: 10,
      minReturnOnCapital: 0.05,
      minProfitMargin: 0.05,
      maxAcquisitionPrice: 5000,
      minLiquidity: "MEDIUM",
      minConfidence: 0.5,
      ...overrides.global,
    },
    flip: { minQsv: 20, maxDaysToSale: 60, ...overrides.flip },
    grade: {
      minPsa10Value: 50,
      minPsa10UpsideMultiple: 1,
      minAcceptableBreakEvenGrade: 9,
      safeZoneOnly: false,
      maxGradedBasis: 5000,
      ...overrides.grade,
    },
  };
}

function umbreonListing(overrides: Partial<ListingCandidate> = {}): ListingCandidate {
  return {
    listingId: "L1",
    title: "Umbreon VMAX Evolving Skies",
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
      edition: "na",
      variant: "holo",
      finish: "na",
      rarity: "Secret Rare",
    },
    ...overrides,
  };
}

function umbreonSnapshot(overrides: Partial<MarketSnapshotLike> = {}): MarketSnapshotLike {
  return {
    sourceProvider: "mock",
    priceTimestamp: new Date().toISOString(),
    rawMarketPrice: 210,
    rawQsv: 185,
    psa7: null,
    psa8: null,
    psa9: null,
    psa10: null,
    confidence: 0.9,
    liquidity: "VERY_HIGH",
    sampleSize: 40,
    ...overrides,
  };
}

function snapshotMap(hash: string, snapshot: MarketSnapshotLike): Map<string, MarketSnapshotLike> {
  return new Map([[hash, snapshot]]);
}

// Resolve a printingHash the same way the engine does, for building the snapshot map in tests.
import { resolveCardPrinting } from "../src/card/resolver.js";

const umbreonHash = resolveCardPrinting(umbreonListing().parsedIdentity).printing!.printingHash;

describe("buildOpportunities — FLIP", () => {
  it("produces HIGH_CONFIDENCE_FLIP for a clean, deeply-underpriced, liquid listing", () => {
    const settings: OpportunityEngineSettings = {
      filters: permissiveFilters({ global: { ...permissiveFilters().global, strategy: "FLIP" } }),
    };
    const results = buildOpportunities([umbreonListing()], snapshotMap(umbreonHash, umbreonSnapshot()), settings);

    expect(results).toHaveLength(1);
    const opp = results[0]!;
    expect(opp.strategy).toBe("FLIP");
    expect(opp.state).toBe("HIGH_CONFIDENCE_FLIP");
    expect(opp.flipScore).toBeGreaterThanOrEqual(70);
    expect(opp.expectedNetProfit).toBeGreaterThan(0);
    expect(opp.cardPrintingHash).toBe(umbreonHash);
  });

  it("produces REJECTED_MARGIN_TOO_LOW when the listing is priced at/above market value", () => {
    const settings: OpportunityEngineSettings = {
      filters: permissiveFilters({ global: { ...permissiveFilters().global, strategy: "FLIP" } }),
    };
    const listing = umbreonListing({ price: 205, shippingCost: 4 });
    const results = buildOpportunities([listing], snapshotMap(umbreonHash, umbreonSnapshot()), settings);

    expect(results[0]!.state).toBe("REJECTED_MARGIN_TOO_LOW");
    expect(results[0]!.expectedNetProfit).toBeLessThan(0);
  });

  it("produces REJECTED_LIQUIDITY_TOO_LOW when liquidity is below the filter minimum but margin/ROC are fine", () => {
    const settings: OpportunityEngineSettings = {
      filters: permissiveFilters({ global: { ...permissiveFilters().global, strategy: "FLIP", minLiquidity: "MEDIUM" } }),
    };
    const results = buildOpportunities(
      [umbreonListing()],
      snapshotMap(umbreonHash, umbreonSnapshot({ liquidity: "LOW" })),
      settings,
    );

    expect(results[0]!.state).toBe("REJECTED_LIQUIDITY_TOO_LOW");
  });

  it("produces WATCH when no market snapshot exists yet for the resolved printing", () => {
    const settings: OpportunityEngineSettings = {
      filters: permissiveFilters({ global: { ...permissiveFilters().global, strategy: "FLIP" } }),
    };
    const results = buildOpportunities([umbreonListing()], new Map(), settings);

    expect(results[0]!.state).toBe("WATCH");
    expect(results[0]!.reasoning.join(" ")).toMatch(/no market snapshot/i);
  });

  it("produces INSPECT_PHOTOS when card identity is plausible but not fully certain", () => {
    const settings: OpportunityEngineSettings = {
      filters: permissiveFilters({ global: { ...permissiveFilters().global, strategy: "FLIP" } }),
    };
    // Stacks two confidence penalties (stamped variant w/o stampType, and a
    // finish implying a specific print run while edition stays 'na') to
    // land between the reject and inspect thresholds (0.5 <= c < 0.85).
    const listing = umbreonListing({
      parsedIdentity: { ...umbreonListing().parsedIdentity, variant: "stamped", finish: "1st_edition_stamp" },
    });
    const hash = resolveCardPrinting(listing.parsedIdentity).printing!.printingHash;
    const results = buildOpportunities([listing], snapshotMap(hash, umbreonSnapshot()), settings);

    expect(results[0]!.state).toBe("INSPECT_PHOTOS");
  });

  it("produces REJECTED_CARD_IDENTITY_UNCERTAIN for an unresolvable listing, once per in-scope strategy", () => {
    const settings: OpportunityEngineSettings = { filters: permissiveFilters() }; // strategy: BOTH
    const listing = umbreonListing({ parsedIdentity: { name: "Unknown" } });
    const results = buildOpportunities([listing], new Map(), settings);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.state === "REJECTED_CARD_IDENTITY_UNCERTAIN")).toBe(true);
    expect(results.map((r) => r.strategy).sort()).toEqual(["FLIP", "GRADE"]);
  });
});

describe("buildOpportunities — GRADE", () => {
  const charizardListing = (): ListingCandidate => ({
    listingId: "L2",
    title: "Charizard Base Set 1st Ed Shadowless Holo",
    price: 1850,
    shippingCost: 12,
    itemUrl: "https://ebay.example/L2",
    sellerFeedbackScore: 4820,
    sellerFeedbackPct: 99.6,
    parsedIdentity: {
      game: "pokemon",
      name: "Charizard",
      setName: "Base Set",
      setCode: "BS",
      cardNumber: "4/102",
      year: 1999,
      language: "EN",
      edition: "1st",
      variant: "holo",
      finish: "shadowless",
      rarity: "Holo Rare",
    },
  });

  const charizardSnapshot = (): MarketSnapshotLike => ({
    sourceProvider: "mock",
    priceTimestamp: new Date().toISOString(),
    rawMarketPrice: 3200,
    rawQsv: 2900,
    psa7: 4200,
    psa8: 6800,
    psa9: 10800,
    psa10: 32000,
    confidence: 0.82,
    liquidity: "MEDIUM",
    sampleSize: 14,
    historicalGemRate: 0.012,
  });

  it("produces GRADE_CANDIDATE for a deeply-discounted raw card with strong PSA9/10 upside", () => {
    const listing = charizardListing();
    const hash = resolveCardPrinting(listing.parsedIdentity).printing!.printingHash;
    const settings: OpportunityEngineSettings = {
      filters: permissiveFilters({ global: { ...permissiveFilters().global, strategy: "GRADE", minLiquidity: "LOW" } }),
    };

    const results = buildOpportunities([listing], snapshotMap(hash, charizardSnapshot()), settings);

    expect(results).toHaveLength(1);
    const opp = results[0]!;
    expect(opp.strategy).toBe("GRADE");
    expect(opp.state).toBe("GRADE_CANDIDATE");
    expect(opp.gradeScore).toBeGreaterThanOrEqual(60);
    expect(opp.breakEvenGrade).not.toBeNull();
    expect(opp.psa10Profit).toBeGreaterThan(opp.psa9Profit ?? 0);
    expect(opp.reasoning.join(" ")).toMatch(/historical gem rate/i);
    expect(opp.reasoning.join(" ")).toMatch(/not a predicted probability/i);
  });

  it("respects a stricter minAcceptableBreakEvenGrade filter", () => {
    const listing = charizardListing();
    const hash = resolveCardPrinting(listing.parsedIdentity).printing!.printingHash;
    const settings: OpportunityEngineSettings = {
      filters: permissiveFilters({
        global: { ...permissiveFilters().global, strategy: "GRADE", minLiquidity: "LOW" },
        grade: { ...permissiveFilters().grade, minAcceptableBreakEvenGrade: 6 }, // only PSA6 break-even accepted
      }),
    };

    const results = buildOpportunities([listing], snapshotMap(hash, charizardSnapshot()), settings);
    // Charizard breaks even at PSA7 in this fixture, which is worse than the PSA6 requirement.
    expect(results[0]!.state).not.toBe("GRADE_CANDIDATE");
  });

  it("produces REJECTED_MARGIN_TOO_LOW for GRADE when graded basis exceeds the cap", () => {
    const listing = charizardListing();
    const hash = resolveCardPrinting(listing.parsedIdentity).printing!.printingHash;
    const settings: OpportunityEngineSettings = {
      filters: permissiveFilters({
        global: { ...permissiveFilters().global, strategy: "GRADE", minLiquidity: "LOW" },
        grade: { ...permissiveFilters().grade, maxGradedBasis: 100 },
      }),
    };

    const results = buildOpportunities([listing], snapshotMap(hash, charizardSnapshot()), settings);
    expect(results[0]!.state).toBe("REJECTED_MARGIN_TOO_LOW");
  });
});
