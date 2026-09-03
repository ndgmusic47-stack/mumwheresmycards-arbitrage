import { describe, it, expect } from "vitest";
import { Db } from "@mwmc/db";
import { upsertOpportunity } from "../src/repo/opportunitiesRepo.js";
import { upsertFlipProfile, upsertGradeProfile } from "../src/repo/marketProfilesRepo.js";
import type { OpportunityCandidate, FlipProfileResult, GradeProfileResult } from "@mwmc/core";

/**
 * REGRESSION GUARD for the single worst bug this project has had.
 *
 * `upsertGradeProfile` once had 20 `?` placeholders but bound only 19
 * values — it accepted a `rawSampleSize` parameter and never used it. Every
 * unit test passed, because every test used an in-memory fake repo. D1
 * rejects a parameter-count mismatch outright, so in reality grade profiles
 * could never be written at all, and nobody found out until the code was
 * finally run against a real database binding.
 *
 * These tests capture the SQL and arguments each repo function actually
 * emits and assert the counts match. They are cheap, they need no D1, and
 * they fail loudly the moment someone adds a column and forgets its value.
 */

interface CapturedCall {
  sql: string;
  args: unknown[];
}

/**
 * Stands in for Db, recording what would have been sent to D1.
 *
 * `cardIsCatalogued` controls the FK pre-check in upsertOpportunity: an
 * opportunity is only written for a card that exists in `cards`, so the
 * default here says "yes, catalogued" to exercise the INSERT path.
 */
function capturingDb(options: { cardIsCatalogued?: boolean } = {}): { db: Db; calls: CapturedCall[] } {
  const cardIsCatalogued = options.cardIsCatalogued ?? true;
  const calls: CapturedCall[] = [];
  const db = {
    exec: async (sql: string, ...args: unknown[]) => {
      calls.push({ sql, args });
      return { success: true };
    },
    queryFirst: async (sql: string) => {
      if (/FROM cards/i.test(sql)) return cardIsCatalogued ? { id: "hash-1" } : null;
      return null; // no pre-existing opportunity row
    },
    queryAll: async () => [],
  } as unknown as Db;
  return { db, calls };
}

function countPlaceholders(sql: string): number {
  // Only the INSERT's VALUES list uses bound parameters in these statements;
  // ON CONFLICT ... DO UPDATE SET references `excluded.*`, never `?`.
  return (sql.match(/\?/g) ?? []).length;
}

function candidate(overrides: Partial<OpportunityCandidate> = {}): OpportunityCandidate {
  return {
    listingId: "L1",
    cardPrintingHash: "hash-1",
    strategy: "GRADE",
    state: "QUALIFIED_GRADE",
    score: 72.5,
    qualifies: true,
    qualificationFailures: [],
    listingPrice: 120,
    totalAcquisitionCost: 123,
    liquidity: "HIGH",
    confidence: 0.8,
    identityConfidence: 1,
    reasoning: ["because"],
    ...overrides,
  };
}

describe("SQL parameter parity — every ? has exactly one bound value", () => {
  it("upsertOpportunity binds one value per placeholder", async () => {
    const { db, calls } = capturingDb();
    await upsertOpportunity(db, candidate(), "scan-1");

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.args.length).toBe(countPlaceholders(call.sql));
  });

  it("upsertOpportunity keeps parity for a FLIP candidate too", async () => {
    const { db, calls } = capturingDb();
    await upsertOpportunity(
      db,
      candidate({
        strategy: "FLIP",
        state: "QUALIFIED_FLIP",
        qsv: 200,
        expectedNetProfit: 67,
        returnOnCapital: 0.65,
      }),
      "scan-1",
    );

    const call = calls[0]!;
    expect(call.args.length).toBe(countPlaceholders(call.sql));
  });

  it("upsertFlipProfile binds one value per placeholder", async () => {
    const { db, calls } = capturingDb();
    const profile: FlipProfileResult = {
      eligible: true,
      ineligibleReason: null,
      rawMarketValue: 300,
      conservativeQsv: 276,
      qsvBasis: "BOTH_SOLD_MEDIANS",
      isHighConfidenceQsv: true,
      liquidity: "HIGH",
      confidence: 0.85,
      maxProfitableAcquisitionPrice: 150,
      discoveryMaxAcquisitionPrice: 210,
      flipMarketScore: 71,
    };

    await upsertFlipProfile(db, "card-1", null, 40, profile);

    const call = calls[0]!;
    expect(call.args.length).toBe(countPlaceholders(call.sql));
  });

  it("upsertGradeProfile binds one value per placeholder (the original bug)", async () => {
    const { db, calls } = capturingDb();
    const profile: GradeProfileResult = {
      eligible: true,
      ineligibleReason: null,
      rawMarketValue: 300,
      psa7: 150,
      psa8: 260,
      psa9: 520,
      psa10: 1800,
      referenceGradedBasis: 375,
      referenceProfitByGrade: { 7: -240, 8: -140, 9: 60, 10: 1150 },
      breakEvenGrade: 9,
      psa10GrossMultiple: 4.8,
      economicClass: "BALANCED",
      economicClassRationale: "because",
      requiredPsa10RateVsPsa9: 0,
      referenceServiceId: "PSA_REGULAR",
      estimatedCapitalLockDays: 135,
      liquidity: "HIGH",
      confidence: 0.85,
      gradeMarketScore: 64,
    };

    await upsertGradeProfile(db, "card-1", null, 40, profile);

    const call = calls[0]!;
    expect(call.args.length).toBe(countPlaceholders(call.sql));
  });

  it("actually passes rawSampleSize through — the value the old bug dropped", async () => {
    const { db, calls } = capturingDb();
    const profile = {
      eligible: true,
      ineligibleReason: null,
      rawMarketValue: 300,
      psa7: null,
      psa8: null,
      psa9: 520,
      psa10: 1800,
      referenceGradedBasis: 375,
      referenceProfitByGrade: {},
      breakEvenGrade: null,
      psa10GrossMultiple: 4.8,
      economicClass: "ASYMMETRIC" as const,
      economicClassRationale: null,
      requiredPsa10RateVsPsa9: 0.05,
      referenceServiceId: "PSA_VALUE",
      estimatedCapitalLockDays: 254,
      liquidity: "MEDIUM" as const,
      confidence: 0.7,
      gradeMarketScore: 55,
    } satisfies GradeProfileResult;

    await upsertGradeProfile(db, "card-1", null, 4242, profile);

    expect(calls[0]!.args).toContain(4242);
  });

  it("skips persistence entirely for an identity-uncertain candidate", async () => {
    const { db, calls } = capturingDb();
    const outcome = await upsertOpportunity(db, candidate({ cardPrintingHash: null }), "scan-1");

    expect(outcome).toBe("skipped_identity_uncertain");
    expect(calls).toHaveLength(0); // nothing written — and not counted as created
  });
});

/**
 * REGRESSION GUARD for a foreign-key failure found by running the real
 * pipeline against real D1.
 *
 * An eBay search for one card routinely returns others, so a listing can
 * resolve cleanly to a printing that simply isn't in our catalogue.
 * `opportunities.card_id` is a foreign key into `cards`, so writing one of
 * those raised D1_ERROR: FOREIGN KEY constraint failed — which propagated
 * out of the scan loop and failed the ENTIRE scan run on the first such
 * listing. In production that is the normal case, not an edge case.
 */
describe("uncatalogued printings never break a scan", () => {
  it("skips a candidate whose printing is not in the catalogue instead of violating the FK", async () => {
    const { db, calls } = capturingDb({ cardIsCatalogued: false });
    const outcome = await upsertOpportunity(db, candidate({ cardPrintingHash: "not-in-catalogue" }), "scan-1");

    expect(outcome).toBe("skipped_uncatalogued_card");
    expect(calls).toHaveLength(0); // no INSERT attempted, so no FK explosion
  });

  it("still writes normally when the printing IS catalogued", async () => {
    const { db, calls } = capturingDb({ cardIsCatalogued: true });
    const outcome = await upsertOpportunity(db, candidate(), "scan-1");

    expect(outcome).toBe("created");
    expect(calls).toHaveLength(1);
  });
});

/**
 * REGRESSION GUARD for a NOT NULL failure found running the real pipeline
 * against real eBay data (D1_ERROR: NOT NULL constraint failed:
 * opportunities.liquidity).
 *
 * NO_MARKET_DATA and REJECTED_CARD_IDENTITY_UNCERTAIN candidates (see
 * packages/core/src/opportunity/engine.ts) can both carry a resolved,
 * catalogued cardPrintingHash — so neither of the two skip checks above
 * caught them — while setting liquidity: null, because there is no market
 * snapshot (or no trustworthy identity) to compute liquidity from.
 * opportunities.liquidity is NOT NULL, so every one of these used to reach
 * the INSERT and blow up. The per-candidate try/catch in scanRunner.ts kept
 * that from failing the whole scan, but silently dropped the listing with
 * no explanation in the scan summary — a real eBay scan showed hundreds of
 * these, one per listing, with no opportunities created as a result.
 */
describe("candidates with no computed liquidity never hit the NOT NULL constraint", () => {
  it("skips a NO_MARKET_DATA candidate as skipped_no_market_data, not a crash", async () => {
    const { db, calls } = capturingDb();
    const outcome = await upsertOpportunity(
      db,
      candidate({ state: "NO_MARKET_DATA", liquidity: null, qualifies: false, score: null }),
      "scan-1",
    );

    expect(outcome).toBe("skipped_no_market_data");
    expect(calls).toHaveLength(0); // no INSERT attempted, so no NOT NULL explosion
  });

  it("skips a low-confidence-but-resolved REJECTED_CARD_IDENTITY_UNCERTAIN candidate as identity-uncertain", async () => {
    const { db, calls } = capturingDb();
    const outcome = await upsertOpportunity(
      db,
      candidate({
        state: "REJECTED_CARD_IDENTITY_UNCERTAIN",
        liquidity: null,
        qualifies: false,
        score: null,
        cardPrintingHash: "hash-1", // identity DID resolve to a printing — just too low confidence to trust
      }),
      "scan-1",
    );

    expect(outcome).toBe("skipped_identity_uncertain");
    expect(calls).toHaveLength(0);
  });

  it("skips a REJECTED_COMPUTATION_ERROR candidate as its own outcome, not mislabeled identity-uncertain", async () => {
    const { db, calls } = capturingDb();
    const outcome = await upsertOpportunity(
      db,
      candidate({
        state: "REJECTED_COMPUTATION_ERROR",
        liquidity: null,
        qualifies: false,
        score: null,
        cardPrintingHash: "hash-1", // identity resolved fine — the listing's own price/currency was the problem
      }),
      "scan-1",
    );

    expect(outcome).toBe("skipped_computation_error");
    expect(calls).toHaveLength(0);
  });
});
