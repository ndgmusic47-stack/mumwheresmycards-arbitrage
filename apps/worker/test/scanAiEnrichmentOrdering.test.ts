import { describe, it, expect } from "vitest";
import { Db } from "@mwmc/db";
import { selectCandidatesForAiReview } from "../src/scan/selectiveAiCandidateReview.js";

/**
 * RELEASE HARDENING 2026-09-03: regression guard for the AI review /
 * enrichment ORDERING bug (as distinct from the "too many SQL variables"
 * bug aiCandidateReview.test.ts already guards).
 *
 * The bug: scanRunner's selective AI candidate review step used to be
 * handed every QUALIFIED_STATES candidate persisted this run
 * (enrichmentEligibleListingIds), regardless of whether stage-two eBay
 * enrichment had actually completed for that listing. Enrichment is itself
 * budget-capped (settings.ebayScanBudget.maxEnrichmentCallsPerRun) and can
 * fail per-listing, so a candidate could get an AI opinion — and have
 * ai_review_status written PERMANENTLY (listOpportunitiesForAiReview only
 * ever selects ai_review_status IS NULL rows) — on bare search-result
 * evidence, before ever being enriched. selectCandidatesForAiReview is the
 * extracted, fixed selection logic (see selectiveAiCandidateReview.ts); this
 * test exercises it directly against a fake Db, at the exact scale named in
 * the spec: 25 qualified candidates, of which only 15 have actually
 * completed enrichment (i.e. the state stage-two enrichment leaves behind
 * once its own cap of 15 has been reached), against an AI review cap of 25
 * (bigger than the enriched count, so it must not be what limits the
 * result).
 */

interface FakeOpportunity {
  id: string;
  listing_id: string;
  card_id: string;
  card_name: string;
  strategy: string;
  state: string;
  listing_price: number;
  total_acquisition_cost: number;
  reasoning: string | null;
  ai_review_status: string | null;
  ai_review_reason: string | null;
  ai_review_confidence: number | null;
  ai_reviewed_at: string | null;
}

/** Builds a fake Db backed by in-memory maps, answering exactly the two
 *  queries selectCandidatesForAiReview's dependencies issue
 *  (getAlreadyEnrichedListingIds's `ebay_listings ... enriched_at IS NOT
 *  NULL` lookup, and listOpportunitiesForAiReview's opportunities/cards
 *  join) — same level of fake as aiCandidateReview.test.ts and
 *  releaseIntegration.test.ts use, not a new database abstraction. */
function makeFakeDb(opportunities: FakeOpportunity[], enrichedListingIds: Set<string>): Db {
  return {
    exec: async () => ({ success: true }),
    queryFirst: async () => null,
    queryAll: async (sql: string, ...args: unknown[]) => {
      if (sql.includes("enriched_at IS NOT NULL")) {
        // args here is exactly one chunk of listing ids (getAlreadyEnrichedListingIds).
        return args.filter((id) => enrichedListingIds.has(id as string)).map((id) => ({ id }));
      }
      if (sql.includes("FROM opportunities o")) {
        // args = [...chunkOfListingIds, ...QUALIFIED_STATES] — QUALIFIED_STATES
        // is a fixed 3-value tail (see packages/core/src/opportunity/states.ts);
        // slicing it off leaves exactly the listing-id chunk being queried.
        const qualifiedStatesTailLength = 3;
        const listingIdChunk = new Set(args.slice(0, args.length - qualifiedStatesTailLength) as string[]);
        return opportunities.filter((o) => listingIdChunk.has(o.listing_id) && o.ai_review_status === null);
      }
      throw new Error(`makeFakeDb: unrecognised query: ${sql}`);
    },
  } as unknown as Db;
}

/** 25 distinct QUALIFIED_FLIP candidates, one listing each. */
function buildQualifiedCandidates(count: number): FakeOpportunity[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `opp-${i}`,
    listing_id: `L${i}`,
    card_id: "card-1",
    card_name: "Charizard ex",
    strategy: "FLIP",
    state: "QUALIFIED_FLIP",
    listing_price: 40,
    total_acquisition_cost: 45,
    reasoning: null,
    ai_review_status: null,
    ai_review_reason: null,
    ai_review_confidence: null,
    ai_reviewed_at: null,
  }));
}

describe("selectCandidatesForAiReview (AI enrichment/review ordering fix)", () => {
  it("with 25 qualified candidates and only 15 successfully enriched (enrichment cap=15), offers AI review ONLY the 15 enriched ones — review cap 25 does not widen it back out", async () => {
    const candidates = buildQualifiedCandidates(25);
    const enrichmentEligibleListingIds = new Set(candidates.map((c) => c.listing_id));
    // Simulates stage-two enrichment having actually completed for only the
    // first 15 (its own maxEnrichmentCallsPerRun cap) — the other 10 were
    // qualified candidates too, but never got enriched this run.
    const enrichedListingIds = new Set(candidates.slice(0, 15).map((c) => c.listing_id));
    const db = makeFakeDb(candidates, enrichedListingIds);

    const toReview = await selectCandidatesForAiReview(db, enrichmentEligibleListingIds, 25);

    expect(toReview).toHaveLength(15);
    expect(new Set(toReview.map((o) => o.listing_id))).toEqual(enrichedListingIds);
    // None of the 10 unenriched candidates' listing ids leaked through.
    for (const c of candidates.slice(15)) {
      expect(toReview.some((o) => o.listing_id === c.listing_id)).toBe(false);
    }
  });

  it("applies the AI-review cap AFTER the enrichment filter, not before", async () => {
    const candidates = buildQualifiedCandidates(25);
    const enrichmentEligibleListingIds = new Set(candidates.map((c) => c.listing_id));
    const enrichedListingIds = new Set(candidates.slice(0, 15).map((c) => c.listing_id));
    const db = makeFakeDb(candidates, enrichedListingIds);

    // Review cap tighter than the enriched count: must return the first 5
    // of the ENRICHED set, never dip into the unenriched 10.
    const toReview = await selectCandidatesForAiReview(db, enrichmentEligibleListingIds, 5);

    expect(toReview).toHaveLength(5);
    for (const o of toReview) {
      expect(enrichedListingIds.has(o.listing_id)).toBe(true);
    }
  });

  it("returns nothing (and never queries opportunities) when NOTHING has been enriched yet — e.g. a provider with no getItemDetail, or enrichment failed for every candidate", async () => {
    const candidates = buildQualifiedCandidates(25);
    const enrichmentEligibleListingIds = new Set(candidates.map((c) => c.listing_id));
    let opportunitiesQueried = false;
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async (sql: string) => {
        if (sql.includes("enriched_at IS NOT NULL")) return []; // nothing enriched
        opportunitiesQueried = true;
        return [];
      },
    } as unknown as Db;

    const toReview = await selectCandidatesForAiReview(db, enrichmentEligibleListingIds, 25);

    expect(toReview).toEqual([]);
    // Never even asks which candidates are otherwise eligible — there's
    // nothing genuinely enriched to review, so no need to query further.
    expect(opportunitiesQueried).toBe(false);
  });

  it("a candidate already AI-reviewed (ai_review_status set) never comes back even if its listing is enriched — the DB query itself excludes it (ai_review_status IS NULL), same contract as before this fix", async () => {
    const candidates = buildQualifiedCandidates(3);
    candidates[0]!.ai_review_status = "PASS_THROUGH";
    const enrichmentEligibleListingIds = new Set(candidates.map((c) => c.listing_id));
    const enrichedListingIds = new Set(candidates.map((c) => c.listing_id)); // all enriched
    const db = makeFakeDb(candidates, enrichedListingIds);

    const toReview = await selectCandidatesForAiReview(db, enrichmentEligibleListingIds, 25);

    expect(toReview.map((o) => o.listing_id)).toEqual(["L1", "L2"]);
  });

  it("returns [] immediately for an empty eligibility set, without querying", async () => {
    let queried = false;
    const db = {
      exec: async () => ({ success: true }),
      queryFirst: async () => null,
      queryAll: async () => {
        queried = true;
        return [];
      },
    } as unknown as Db;

    const toReview = await selectCandidatesForAiReview(db, new Set(), 25);

    expect(toReview).toEqual([]);
    expect(queried).toBe(false);
  });
});
