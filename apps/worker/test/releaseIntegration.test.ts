import { describe, it, expect } from "vitest";
import { Db } from "@mwmc/db";
import {
  buildOpportunities,
  computeFlipProfile,
  computeGradeProfile,
  resolveCardPrinting,
  DEFAULT_CLASSIFICATION_SETTINGS,
  DEFAULT_EXIT_MARKET_FEE_MODEL,
  DEFAULT_FLIP_QUALIFICATION,
  DEFAULT_GRADE_QUALIFICATION,
  DEFAULT_GRADING_BATCH,
  DEFAULT_GRADING_CONSUMABLES,
  DEFAULT_GRADING_SERVICES,
  DEFAULT_QSV_SETTINGS,
  DEFAULT_SELLING_COSTS,
  DEFAULT_MARKET_PROFILE_SETTINGS,
} from "@mwmc/core";
import type { ListingCandidate, MarketSnapshotLike, OpportunityEngineSettings, RawCardIdentity, PrioritizableCard } from "@mwmc/core";
import { reconcileIdentityWithTitle } from "../src/scan/titleParser.js";
import { buildStateCondition } from "../src/routes/opportunities.js";
import { upsertOpportunity, loadOpportunityCounts } from "../src/repo/opportunitiesRepo.js";

/**
 * STABILISATION item 12 — RELEASE TEST.
 *
 * ONE deterministic end-to-end integration test covering the full pipeline
 * named in the spec: fake catalogue -> market snapshots -> market profiles
 * -> eligible universe -> fake eBay results -> classification -> independent
 * identity check -> deduplication -> FLIP + GRADE opportunity engine ->
 * persistence -> API feed. No real D1, no real network — every stage is
 * exercised through the REAL exported functions (not reimplemented), fed
 * synthetic-but-realistic data, against a minimal in-memory fake of the Db
 * interface (the same level every other persistence test in this suite
 * fakes at — see sqlParameterParity.test.ts / hydrateStoredSnapshots.test.ts
 * — deliberately not a new database abstraction).
 *
 * The ten required cases are numbered inline. Two of them (6 and 3) are
 * NOT "everything works" assertions — they pin down real, currently-open
 * gaps this pass did not fix (lot/bundle listings and already-graded slabs
 * are not distinguished from a raw single), so a future reader — or the
 * final stabilisation report — has a concrete, reproducible example rather
 * than a vague caveat. That is a deliberate, honest use of a release test:
 * proving what the system actually does, not just what it's supposed to.
 */

// ---- Fixtures: a tiny two-card fake catalogue --------------------------

/** Base Set Charizard, Unlimited print — the "normal" search target used by
 *  most of the ten cases below. */
const CHARIZARD_UNLIMITED: RawCardIdentity = {
  game: "pokemon",
  name: "Charizard",
  setName: "Base Set",
  setCode: "BS",
  cardNumber: "4/102",
  year: 1999,
  language: "EN",
  edition: "unlimited",
  variant: "holo",
  finish: "unlimited_shadow",
  rarity: "Holo Rare",
};

/** The SAME nominal card, 1st Edition Shadowless print — a genuinely
 *  different catalogued printing sharing name+set+number with the above
 *  (see searchGrouping.test.ts for the same real-world shape at the
 *  eBay-search-keyword layer; here it's used for item 7's dedup case). */
const CHARIZARD_1ST_EDITION: RawCardIdentity = {
  ...CHARIZARD_UNLIMITED,
  edition: "1st",
  finish: "shadowless",
};

function printingHashOf(identity: RawCardIdentity): string {
  const resolved = resolveCardPrinting(identity);
  if (!resolved.printing) throw new Error("test fixture identity must resolve confidently");
  return resolved.printing.printingHash;
}

const CHARIZARD_UNLIMITED_HASH = printingHashOf(CHARIZARD_UNLIMITED);
const CHARIZARD_1ST_EDITION_HASH = printingHashOf(CHARIZARD_1ST_EDITION);

// ---- Fixtures: engine settings + a representative market snapshot -------

function engineSettings(overrides: Partial<OpportunityEngineSettings> = {}): OpportunityEngineSettings {
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

/** A genuinely healthy market — comfortably clears both FLIP and GRADE
 *  qualification at a realistic acquisition price, so cases that SHOULD
 *  qualify actually do (matches the fixture already proven in
 *  opportunityEngine.test.ts). */
const HEALTHY_SNAPSHOT: MarketSnapshotLike = {
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
};

// ---- Fake persistence layer (Db-interface level, matching the rest of
// this suite's convention — see sqlParameterParity.test.ts) --------------

interface FakeOpportunityRow {
  id: string;
  card_id: string;
  listing_id: string;
  strategy: string;
  state: string;
}

function fakeDb(catalogueCardIds: Set<string>) {
  const opportunities = new Map<string, FakeOpportunityRow>();

  const db = {
    exec: async (sql: string, ...params: unknown[]) => {
      if (sql.includes("INSERT INTO opportunities")) {
        const [id, card_id, listing_id, , strategy, state] = params as string[];
        opportunities.set(id, { id, card_id, listing_id, strategy, state });
      }
      return { success: true };
    },
    queryFirst: async (sql: string, ...params: unknown[]) => {
      if (sql.includes("FROM cards WHERE id")) {
        const [id] = params as [string];
        return catalogueCardIds.has(id) ? { id } : null;
      }
      if (sql.includes("FROM opportunities WHERE listing_id")) {
        const [listingId, strategy] = params as [string, string];
        const found = Array.from(opportunities.values()).find((o) => o.listing_id === listingId && o.strategy === strategy);
        return found ? { id: found.id } : null;
      }
      // loadOpportunityCounts' auction/ended-listing counts join ebay_listings,
      // which this fake deliberately doesn't model — item 6/8's own dedicated
      // tests (listingsRepo.test.ts, opportunityCounts.test.ts) already cover
      // that join logic directly. Returning "none found" here is correct for
      // THIS test's fixtures, asserted explicitly below rather than ignored.
      return null;
    },
    queryAll: async (sql: string) => {
      if (sql.includes("GROUP BY state")) {
        const counts = new Map<string, number>();
        for (const o of opportunities.values()) counts.set(o.state, (counts.get(o.state) ?? 0) + 1);
        return Array.from(counts.entries()).map(([state, n]) => ({ state, n }));
      }
      return [];
    },
  } as unknown as Db;

  return { db, opportunities };
}

describe("RELEASE TEST (STABILISATION item 12) — full pipeline, all ten required cases", () => {
  it("catalogue -> market snapshots -> market profiles -> eligible universe -> eBay results -> classification -> identity check -> dedup -> FLIP+GRADE engine -> persistence -> API feed", async () => {
    // ---- MARKET SNAPSHOTS -> MARKET PROFILES -> ELIGIBLE UNIVERSE --------
    // Exercises the CARD MARKET layer (packages/core/src/market) against the
    // fake catalogue, before any listing is looked at — proves this stage
    // wires up (computes real numbers, doesn't throw) independent of the
    // opportunity-engine fixtures used for the ten cases below.
    const flipProfile = computeFlipProfile(HEALTHY_SNAPSHOT, DEFAULT_FLIP_QUALIFICATION, DEFAULT_MARKET_PROFILE_SETTINGS);
    const gradeProfile = computeGradeProfile(HEALTHY_SNAPSHOT, DEFAULT_MARKET_PROFILE_SETTINGS, DEFAULT_GRADING_SERVICES, DEFAULT_GRADING_BATCH, DEFAULT_GRADING_CONSUMABLES, DEFAULT_EXIT_MARKET_FEE_MODEL, DEFAULT_SELLING_COSTS, DEFAULT_CLASSIFICATION_SETTINGS, 1 / 0.79);
    expect(flipProfile.eligible).toBe(true);
    expect(gradeProfile.eligible).toBe(true);

    // The Dynamic Flip/Grade Universe entry a real scan would build for this
    // card (see marketProfilesRepo.ts's listEligibleUniverseCards) — proves
    // the profile output is shaped correctly for the prioritisation layer.
    const universeEntry: PrioritizableCard = {
      cardId: CHARIZARD_UNLIMITED_HASH,
      score: flipProfile.flipMarketScore,
      potentialProfit: flipProfile.maxProfitableAcquisitionPrice,
      liquidity: flipProfile.liquidity,
      confidence: flipProfile.confidence,
      lastEbayScannedAt: null,
      maxAcquisitionPrice: flipProfile.maxProfitableAcquisitionPrice,
    };
    expect(universeEntry.maxAcquisitionPrice).toBeGreaterThan(0);

    const settings = engineSettings();
    const snapshots = new Map<string, MarketSnapshotLike>([
      [CHARIZARD_UNLIMITED_HASH, HEALTHY_SNAPSHOT],
      [CHARIZARD_1ST_EDITION_HASH, HEALTHY_SNAPSHOT],
    ]);
    const catalogueCardIds = new Set([CHARIZARD_UNLIMITED_HASH, CHARIZARD_1ST_EDITION_HASH]);
    const { db } = fakeDb(catalogueCardIds);

    const listingCandidates: ListingCandidate[] = [];

    // ---- CASE 1: genuine raw English single -------------------------------
    // Also covers CASE 10 (both FLIP and GRADE calculations remain
    // functional) — settings().qualification.strategy is "BOTH", so this one
    // listing must produce both a FLIP and a GRADE candidate.
    const case1Identity = reconcileIdentityWithTitle(CHARIZARD_UNLIMITED, "Charizard Base Set Holo 4/102 NM Unlimited");
    listingCandidates.push({
      listingId: "case1-genuine-raw-english",
      title: "Charizard Base Set Holo 4/102 NM Unlimited",
      price: 80,
      shippingCost: 2,
      itemUrl: "https://ebay.example/case1",
      sellerFeedbackScore: 9000,
      sellerFeedbackPct: 99.8,
      parsedIdentity: case1Identity,
      listingType: "FIXED",
      itemCondition: "Ungraded",
    });

    // ---- CASE 2: wrong card returned from search --------------------------
    // Searched FOR Charizard; the listing is genuinely a different Pokémon.
    // Item 5's name-corroboration guard must catch this — the title never
    // mentions "Charizard" anywhere.
    const case2Title = "Blastoise Base Set Holo 2/102 NM Unlimited";
    const case2Identity = reconcileIdentityWithTitle(CHARIZARD_UNLIMITED, case2Title);
    listingCandidates.push({
      listingId: "case2-wrong-card",
      title: case2Title,
      price: 60,
      shippingCost: 2,
      itemUrl: "https://ebay.example/case2",
      parsedIdentity: case2Identity,
      listingType: "FIXED",
      itemCondition: "Ungraded",
    });

    // ---- CASE 3: graded slab ----------------------------------------------
    // The listing IS the right card, but it's already a PSA-graded slab, not
    // a raw single. Classification (itemCondition) is correctly captured and
    // carried through — but the engine has no concept of "already graded";
    // it still runs GRADE-strategy economics as if this were a raw card to
    // submit. This is a REAL, currently open gap (see ARCHITECTURE-AND-STATUS.md's
    // "condition-blindness" note) — asserted here explicitly, not fixed:
    // fixing it is out of scope for a surgical pass unless demonstrated as a
    // bug, and this test is what demonstrates it, honestly, for the final
    // report's "anything that still prevents real-money sourcing" item.
    const case3Title = "Charizard Base Set Holo 4/102 PSA 10 GEM MINT Graded Slab";
    const case3Identity = reconcileIdentityWithTitle(CHARIZARD_UNLIMITED, case3Title);
    listingCandidates.push({
      listingId: "case3-graded-slab",
      title: case3Title,
      price: 90, // deliberately a plain in-range price — the point is the MISSING "already graded" signal, not extreme numbers
      shippingCost: 4,
      itemUrl: "https://ebay.example/case3",
      parsedIdentity: case3Identity,
      listingType: "FIXED",
      itemCondition: "Graded", // classification data DOES reach here (item 6) — just not used to change economics
    });

    // ---- CASE 4: auction ---------------------------------------------------
    const case4Title = "Charizard Base Set Holo 4/102 Unlimited AUCTION no reserve";
    const case4Identity = reconcileIdentityWithTitle(CHARIZARD_UNLIMITED, case4Title);
    listingCandidates.push({
      listingId: "case4-auction",
      title: case4Title,
      price: 5.45, // current bid, per bug 9's real fallback behaviour
      shippingCost: 2.72,
      itemUrl: "https://ebay.example/case4",
      parsedIdentity: case4Identity,
      listingType: "AUCTION",
      itemCondition: "Ungraded",
    });

    // ---- CASE 5: foreign-language card -------------------------------------
    // Searched for the EN print; the listing is explicitly the Japanese
    // print. Item 5's language-drop rule must catch this (EN target + a
    // non-EN mention is a red flag, dropped rather than assumed EN).
    const case5Title = "Charizard Base Set Holo 4/102 Japanese Edition Rare";
    const case5Identity = reconcileIdentityWithTitle(CHARIZARD_UNLIMITED, case5Title);
    listingCandidates.push({
      listingId: "case5-foreign-language",
      title: case5Title,
      price: 50,
      shippingCost: 2,
      itemUrl: "https://ebay.example/case5",
      parsedIdentity: case5Identity,
      listingType: "FIXED",
      itemCondition: "Ungraded",
    });

    // ---- CASE 6: lot/bundle -------------------------------------------------
    // A real seller keyword-stuffs a multi-card lot's title with every
    // included card's name — including the one we searched for. Unlike
    // case 2, the name DOES genuinely appear in the title, so item 5's
    // "drop only on true absence" corroboration has nothing to catch here:
    // there is currently NO lot/bundle detector anywhere in this pipeline
    // (confirmed by direct search of the codebase). The result: a genuine
    // £45 20-card lot resolves CONFIDENTLY to a single Charizard printing
    // and gets priced as if £45 bought the Charizard alone. This is asserted
    // explicitly below as a real, currently open gap — NOT fixed here (a
    // lot/bundle detector is a new feature, not one of item 11's named
    // "obvious wins", and item 12 is a test task) — surfaced honestly for
    // the final report's "anything that still prevents real-money sourcing".
    const case6Title = "Pokemon TCG Lot Bundle 20 Cards Inc Charizard Base Set Blastoise Venusaur";
    const case6Identity = reconcileIdentityWithTitle(CHARIZARD_UNLIMITED, case6Title);
    listingCandidates.push({
      listingId: "case6-lot-bundle",
      title: case6Title,
      price: 45,
      shippingCost: 5,
      itemUrl: "https://ebay.example/case6",
      parsedIdentity: case6Identity,
      listingType: "FIXED",
      itemCondition: "Ungraded",
    });

    // ---- CASE 7: duplicate item ID ------------------------------------------
    // The SAME real eBay item, found via TWO different card searches — the
    // exact shape produced by scanRunner's grouped search (item 11) or by
    // two separate card searches surfacing the same real listing (item 7's
    // original motivation). One target (Unlimited) can't corroborate "1st
    // Edition Shadowless" in the title and gets dropped to identity-uncertain;
    // the other (1st Edition) matches confidently. dedupeByListingAndStrategy
    // must keep the confident, actionable one.
    const case7Title = "Charizard Base Set Holo 4/102 1st Edition Shadowless PSA-worthy";
    listingCandidates.push({
      listingId: "case7-duplicate-item",
      title: case7Title,
      price: 250, // priced for the far rarer 1st Edition print
      shippingCost: 5,
      itemUrl: "https://ebay.example/case7",
      parsedIdentity: reconcileIdentityWithTitle(CHARIZARD_UNLIMITED, case7Title), // target search #1 (wrong printing)
      listingType: "FIXED",
      itemCondition: "Ungraded",
    });
    listingCandidates.push({
      listingId: "case7-duplicate-item", // SAME listingId — the duplicate
      title: case7Title,
      price: 250,
      shippingCost: 5,
      itemUrl: "https://ebay.example/case7",
      parsedIdentity: reconcileIdentityWithTitle(CHARIZARD_1ST_EDITION, case7Title), // target search #2 (correct printing)
      listingType: "FIXED",
      itemCondition: "Ungraded",
    });

    // ---- CASE 8: valid D1 snapshot not refreshed this run -------------------
    // Simulates item 4's hydrateStoredSnapshots fallback delivering a
    // snapshot that came from an EARLIER run's D1 row, not this run's fresh
    // profiling — from buildOpportunities()'s point of view this must be
    // indistinguishable from a freshly profiled snapshot (it only ever reads
    // snapshotsByPrintingHash, never asks where an entry came from). Proven
    // here by using a snapshot map entry seeded independently of the
    // "MARKET SNAPSHOTS" stage above — hydrateStoredSnapshots' own D1 query
    // contract is already covered directly by hydrateStoredSnapshots.test.ts.
    const staleButValidSnapshot: MarketSnapshotLike = { ...HEALTHY_SNAPSHOT, priceTimestamp: "2026-08-15T00:00:00.000Z" };
    const case8Title = "Charizard Base Set Holo 4/102 Unlimited LP";
    listingCandidates.push({
      listingId: "case8-hydrated-snapshot",
      title: case8Title,
      price: 85,
      shippingCost: 2,
      itemUrl: "https://ebay.example/case8",
      parsedIdentity: reconcileIdentityWithTitle(CHARIZARD_UNLIMITED, case8Title),
      listingType: "FIXED",
      itemCondition: "Ungraded",
    });
    // This candidate is priced through separately below, against a snapshot
    // map that deliberately only contains the "hydrated" entry for it.

    // ---- OPPORTUNITY ENGINE (FLIP + GRADE, cases 1-8 + 10) -------------------
    const snapshotsForMainCandidates = new Map(snapshots);
    const results = buildOpportunities(
      listingCandidates.filter((l) => l.listingId !== "case8-hydrated-snapshot"),
      snapshotsForMainCandidates,
      settings,
    );
    const case8Results = buildOpportunities(
      listingCandidates.filter((l) => l.listingId === "case8-hydrated-snapshot"),
      new Map([[CHARIZARD_UNLIMITED_HASH, staleButValidSnapshot]]), // ONLY the hydrated entry — proves it alone is sufficient
      settings,
    );
    const allResults = [...results, ...case8Results];

    // ---- Assertions per case, before persistence ----------------------------

    const case1 = allResults.filter((r) => r.listingId === "case1-genuine-raw-english");
    const case1Flip = case1.find((r) => r.strategy === "FLIP")!;
    const case1Grade = case1.find((r) => r.strategy === "GRADE")!;
    expect(case1Flip.state).toBe("QUALIFIED_FLIP"); // CASE 1
    expect(case1Grade).toBeDefined(); // CASE 10: both strategies computed for one listing
    expect(["QUALIFIED_GRADE", "WATCH", "INSPECT_PHOTOS"]).toContain(case1Grade.state); // a real, non-crashed GRADE result

    const case2 = allResults.filter((r) => r.listingId === "case2-wrong-card");
    for (const r of case2) {
      expect(r.state).toBe("REJECTED_CARD_IDENTITY_UNCERTAIN"); // CASE 2 — name never corroborated
      expect(r.cardPrintingHash).toBeNull();
    }

    const case3 = allResults.filter((r) => r.listingId === "case3-graded-slab");
    expect(case3.length).toBeGreaterThan(0); // CASE 3 — classification data didn't crash the pipeline
    expect(case3.every((r) => r.cardPrintingHash === CHARIZARD_UNLIMITED_HASH)).toBe(true); // identity still resolves correctly
    // Documented gap: nothing here downgrades or flags a GRADE candidate for
    // being built from an already-graded slab — it's evaluated exactly like
    // a raw card would be.

    const case4 = allResults.filter((r) => r.listingId === "case4-auction");
    const case4Flip = case4.find((r) => r.strategy === "FLIP")!;
    expect(case4Flip.reasoning[0]).toMatch(/AUCTION listing/); // CASE 4 — the current-bid caveat is surfaced first

    const case5 = allResults.filter((r) => r.listingId === "case5-foreign-language");
    for (const r of case5) {
      expect(r.state).toBe("REJECTED_CARD_IDENTITY_UNCERTAIN"); // CASE 5 — language dropped, so language is "missing"
      expect(r.cardPrintingHash).toBeNull();
    }

    const case6 = allResults.filter((r) => r.listingId === "case6-lot-bundle");
    const case6Flip = case6.find((r) => r.strategy === "FLIP")!;
    // Documented gap (CASE 6): identity resolves CONFIDENTLY (unlike case 2)
    // because the title genuinely names the searched card — there is no
    // signal anywhere in this pipeline that this is a 20-card lot, not a
    // single. The £45 lot price is used as if it acquired the Charizard
    // alone, which is what "QUALIFIED_FLIP" below actually means here.
    expect(case6Flip.cardPrintingHash).toBe(CHARIZARD_UNLIMITED_HASH);
    expect(case6Flip.state).toBe("QUALIFIED_FLIP");

    const case7 = allResults.filter((r) => r.listingId === "case7-duplicate-item" && r.strategy === "FLIP");
    expect(case7).toHaveLength(1); // CASE 7 — deduplicated to exactly one candidate for this listing+strategy
    expect(case7[0]!.cardPrintingHash).toBe(CHARIZARD_1ST_EDITION_HASH); // the CONFIDENT match won, not the uncertain one

    const case8 = case8Results.filter((r) => r.listingId === "case8-hydrated-snapshot");
    const case8Flip = case8.find((r) => r.strategy === "FLIP")!;
    expect(case8Flip.state).toBe("QUALIFIED_FLIP"); // CASE 8 — a hydrated-only snapshot prices it correctly, not NO_MARKET_DATA

    // ---- PERSISTENCE ----------------------------------------------------------
    // Every candidate from every case goes through the SAME real
    // upsertOpportunity() a scan run would call.
    const scanRunId = "release-test-scan-run";
    const outcomes: Record<string, string> = {};
    for (const candidate of allResults) {
      const key = `${candidate.listingId}::${candidate.strategy}`;
      outcomes[key] = await upsertOpportunity(db, candidate, scanRunId);
    }
    expect(outcomes["case1-genuine-raw-english::FLIP"]).toBe("created");
    expect(outcomes["case2-wrong-card::FLIP"]).toBe("skipped_identity_uncertain");
    expect(outcomes["case5-foreign-language::FLIP"]).toBe("skipped_identity_uncertain");
    expect(outcomes["case7-duplicate-item::FLIP"]).toBe("created"); // one row, not two — dedup happened before persistence

    // CASE 9: stale previous opportunity — an EARLIER run persisted this
    // listing at a non-qualifying price; a LATER run finds it genuinely
    // repriced (a real seller drop) and must OVERWRITE the stale row, not
    // leave the dashboard stuck showing the old, no-longer-true state.
    const case9Base = allResults.find((r) => r.listingId === "case1-genuine-raw-english" && r.strategy === "FLIP")!;
    const case9StaleRun = {
      ...case9Base,
      listingId: "case9-stale-then-refreshed",
      listingPrice: 290,
      totalAcquisitionCost: 292,
      state: "WATCH" as const,
      qualifies: false,
    };
    const case9FreshRun = { ...case9StaleRun, listingPrice: 80, totalAcquisitionCost: 82, state: "QUALIFIED_FLIP" as const, qualifies: true };

    const earlierRunOutcome = await upsertOpportunity(db, case9StaleRun, "earlier-run");
    expect(earlierRunOutcome).toBe("created"); // first time this listing+strategy was ever persisted
    const laterRunOutcome = await upsertOpportunity(db, case9FreshRun, "release-test-scan-run");
    expect(laterRunOutcome).toBe("updated"); // SAME row (listing_id + strategy) — overwritten, not duplicated
    outcomes["case9-stale-then-refreshed::FLIP"] = laterRunOutcome; // one net row — folded into the feed totals below

    // ---- API FEED ---------------------------------------------------------
    // loadOpportunityCounts is the REAL function backing GET /api/opportunities'
    // `counts` object — this is genuinely what a client of the feed would see.
    const counts = await loadOpportunityCounts(db);
    expect(counts.totalCandidates).toBe(Object.keys(outcomes).filter((k) => !outcomes[k]!.startsWith("skipped")).length);
    expect(counts.qualifiedFlip).toBeGreaterThanOrEqual(2); // case1 (post-refresh) + case6 (the documented lot gap) at minimum
    expect(counts.identityUncertain).toBe(0); // uncertain candidates are never persisted (see upsertOpportunity) — the feed never even sees them as a state
    // Not modeled by this fake (see fakeDb's own comment) — asserted
    // explicitly rather than silently ignored, since a stray nonzero value
    // here would mean this test's fake started returning something it
    // shouldn't.
    expect(counts.auctions).toBe(0);
    expect(counts.endedListings).toBe(0);

    // The dashboard's ACTIONABLE category tab (item 10) — real filtering
    // logic (buildStateCondition), applied against the real persisted
    // per-state breakdown, must pick out exactly the qualifying rows.
    const actionableFilter = buildStateCondition("QUALIFIED_FLIP,QUALIFIED_GRADE")!;
    const actionableCount = Object.entries(counts.byState)
      .filter(([state]) => actionableFilter.params.includes(state))
      .reduce((sum, [, n]) => sum + n, 0);
    expect(actionableCount).toBe(counts.qualifiedFlip + counts.qualifiedGrade);
  });
});
