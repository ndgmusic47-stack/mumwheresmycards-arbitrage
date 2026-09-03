import { describe, it, expect } from "vitest";
import { Db } from "@mwmc/db";
import {
  upsertOpportunity,
  updateOpportunityReview,
  REVIEW_STATUSES,
  REVIEW_REASON_CODES,
} from "../src/repo/opportunitiesRepo.js";
import type { OpportunityCandidate } from "@mwmc/core";

/**
 * REGRESSION GUARD for SOURCING WORKFLOW item 17 (review-status workflow)
 * and AI INTELLIGENCE spec items 19-20 (learning database / reason codes).
 *
 * Contracts covered here:
 * (1) a brand-new opportunity starts life at 'UNREVIEWED', never null/blank;
 * (2) upsertOpportunity's ON CONFLICT branch — which fires on every re-scan
 *     of a listing that's still live — must NEVER touch review_status/
 *     review_notes/reviewed_at, or a human's manual sourcing decision would
 *     be silently wiped the next time the scanner happens to see the same
 *     listing;
 * (3) every updateOpportunityReview call that actually changes something
 *     ALSO writes an immutable learning_review_snapshots row, captured from
 *     the opportunity's state BEFORE this update — see
 *     captureLearningReviewSnapshot's doc comment.
 */

interface CapturedCall {
  sql: string;
  args: unknown[];
}

/** existingOpportunityRow simulates the pre-update opportunities row that
 *  updateOpportunityReview reads before writing (needed for the learning
 *  snapshot) — defaults to a plausible row so most tests don't need to
 *  think about it. Pass null to simulate "no such opportunity". */
function capturingDb(
  existingOpportunityRow: Record<string, unknown> | null = { id: "opp-1", review_status: "UNREVIEWED", review_notes: null, review_reason_code: null },
): { db: Db; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const db = {
    exec: async (sql: string, ...args: unknown[]) => {
      calls.push({ sql, args });
      return { success: true };
    },
    queryFirst: async (sql: string) => {
      if (/FROM cards/i.test(sql)) return { id: "hash-1" };
      if (/FROM opportunities/i.test(sql)) return existingOpportunityRow;
      return null;
    },
    queryAll: async () => [],
  } as unknown as Db;
  return { db, calls };
}

function candidate(overrides: Partial<OpportunityCandidate> = {}): OpportunityCandidate {
  return {
    listingId: "L1",
    cardPrintingHash: "hash-1",
    strategy: "FLIP",
    state: "QUALIFIED_FLIP",
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

describe("upsertOpportunity — review_status (SOURCING WORKFLOW item 17)", () => {
  it("binds 'UNREVIEWED' for a new row's review_status", async () => {
    const { db, calls } = capturingDb();
    await upsertOpportunity(db, candidate(), "scan-1");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/review_status/);
    expect(calls[0]!.args).toContain("UNREVIEWED");
  });

  it("never references review_status/review_notes/reviewed_at in the ON CONFLICT UPDATE SET clause", async () => {
    const { db, calls } = capturingDb();
    await upsertOpportunity(db, candidate(), "scan-1");

    const sql = calls[0]!.sql;
    const updateSetClause = sql.slice(sql.indexOf("DO UPDATE SET"));
    expect(updateSetClause).not.toMatch(/review_status\s*=/);
    expect(updateSetClause).not.toMatch(/review_notes\s*=/);
    expect(updateSetClause).not.toMatch(/reviewed_at\s*=/);
  });
});

describe("updateOpportunityReview", () => {
  it("updates only reviewStatus when reviewNotes is omitted", async () => {
    const { db, calls } = capturingDb();
    const ok = await updateOpportunityReview(db, "opp-1", { reviewStatus: "INTERESTED" });

    expect(ok).toBe(true);
    const updateCall = calls.find((c) => c.sql.startsWith("UPDATE opportunities"))!;
    expect(updateCall.sql).toMatch(/review_status = \?/);
    expect(updateCall.sql).not.toMatch(/review_notes = \?/);
    expect(updateCall.args).toEqual(["INTERESTED", "opp-1"]);
  });

  it("updates only reviewNotes when reviewStatus is omitted", async () => {
    const { db, calls } = capturingDb();
    await updateOpportunityReview(db, "opp-1", { reviewNotes: "Looks like a clean scan" });

    const updateCall = calls.find((c) => c.sql.startsWith("UPDATE opportunities"))!;
    expect(updateCall.sql).not.toMatch(/review_status = \?/);
    expect(updateCall.sql).toMatch(/review_notes = \?/);
    expect(updateCall.args).toEqual(["Looks like a clean scan", "opp-1"]);
  });

  it("treats an empty-string note as clearing it (stored as null, not '')", async () => {
    const { db, calls } = capturingDb();
    await updateOpportunityReview(db, "opp-1", { reviewNotes: "" });

    const updateCall = calls.find((c) => c.sql.startsWith("UPDATE opportunities"))!;
    expect(updateCall.args).toEqual([null, "opp-1"]);
  });

  it("always stamps reviewed_at when anything changes", async () => {
    const { db, calls } = capturingDb();
    await updateOpportunityReview(db, "opp-1", { reviewStatus: "PASS" });

    const updateCall = calls.find((c) => c.sql.startsWith("UPDATE opportunities"))!;
    expect(updateCall.sql).toMatch(/reviewed_at = datetime\('now'\)/);
  });

  it("does nothing and returns false when both fields are omitted", async () => {
    const { db, calls } = capturingDb();
    const ok = await updateOpportunityReview(db, "opp-1", {});

    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("returns false without writing anything when the opportunity doesn't exist", async () => {
    const { db, calls } = capturingDb(null);
    const ok = await updateOpportunityReview(db, "opp-missing", { reviewStatus: "PASS" });

    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("REVIEW_STATUSES lists exactly the five statuses the spec names, UNREVIEWED first", () => {
    expect(REVIEW_STATUSES).toEqual(["UNREVIEWED", "CHECKED", "INTERESTED", "PASS", "BOUGHT"]);
  });

  it("can set a review reason code alongside the status", async () => {
    const { db, calls } = capturingDb();
    await updateOpportunityReview(db, "opp-1", { reviewStatus: "PASS", reviewReasonCode: "CONDITION_CONCERN" });

    const updateCall = calls.find((c) => c.sql.startsWith("UPDATE opportunities"))!;
    expect(updateCall.sql).toMatch(/review_reason_code = \?/);
    expect(updateCall.args).toContain("CONDITION_CONCERN");
  });

  it("REVIEW_REASON_CODES includes OTHER as an escape hatch, and stays a closed, deduplicated list", () => {
    expect(REVIEW_REASON_CODES).toContain("OTHER");
    expect(new Set(REVIEW_REASON_CODES).size).toBe(REVIEW_REASON_CODES.length);
  });
});

/**
 * AI INTELLIGENCE spec items 19-20 (learning database): every review
 * decision that actually changes something writes an immutable
 * learning_review_snapshots row, captured from the opportunity's state
 * BEFORE the update — never the state after, and never skipped just
 * because a similar snapshot already exists.
 */
describe("updateOpportunityReview — learning snapshot capture", () => {
  it("writes a learning_review_snapshots row alongside the opportunities UPDATE", async () => {
    const { db, calls } = capturingDb();
    await updateOpportunityReview(db, "opp-1", { reviewStatus: "PASS", reviewReasonCode: "PRICE_TOO_HIGH_VS_COMPS" });

    const snapshotCall = calls.find((c) => c.sql.includes("INSERT INTO learning_review_snapshots"));
    expect(snapshotCall).toBeDefined();
    expect(snapshotCall!.args).toContain("PASS");
    expect(snapshotCall!.args).toContain("PRICE_TOO_HIGH_VS_COMPS");
  });

  it("captures the PRE-update opportunity state in the snapshot, not the new decision's own fields overwriting it", async () => {
    const { db, calls } = capturingDb({
      id: "opp-1",
      review_status: "UNREVIEWED",
      review_notes: null,
      review_reason_code: null,
      state: "QUALIFIED_FLIP",
      expected_net_profit: 55.5,
    });
    await updateOpportunityReview(db, "opp-1", { reviewStatus: "BOUGHT" });

    const snapshotCall = calls.find((c) => c.sql.includes("INSERT INTO learning_review_snapshots"))!;
    const snapshotJson = snapshotCall.args[snapshotCall.args.length - 1] as string;
    const snapshot = JSON.parse(snapshotJson);

    // The frozen copy reflects what the row looked like BEFORE this
    // decision — its OWN review_status field is still the old value, even
    // though the decision being recorded (in the dedicated column above)
    // is "BOUGHT". Economics are carried through untouched.
    expect(snapshot.review_status).toBe("UNREVIEWED");
    expect(snapshot.state).toBe("QUALIFIED_FLIP");
    expect(snapshot.expected_net_profit).toBe(55.5);
  });

  it("does not write a snapshot when nothing actually changed (no-op call)", async () => {
    const { db, calls } = capturingDb();
    await updateOpportunityReview(db, "opp-1", {});

    expect(calls.filter((c) => c.sql.includes("learning_review_snapshots"))).toHaveLength(0);
  });
});
