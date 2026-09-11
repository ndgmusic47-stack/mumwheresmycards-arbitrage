import { describe, it, expect } from "vitest";
import { buildSortClause } from "../src/routes/opportunities.js";

/**
 * REGRESSION GUARD for the 2026-09-09 "newest doesn't mean newest" fix.
 *
 * THE BUG. The dashboard defaulted to `sort=newest`, which mapped to
 * `ebay_listings.fetched_at`. `upsertListing` sets `fetched_at =
 * datetime('now')` on EVERY re-sight of a listing, so that column answers
 * "when did a scan last touch this row", not "when did this appear". With a
 * rotating scan budget (60 cards per run) the top of the table was therefore
 * whichever cards happened to fall in the last rotation — a listing first
 * seen three weeks ago, re-observed five minutes ago, outranked one
 * discovered yesterday. A user working the table top-down was being shown
 * old stock in a column labelled "Newest".
 *
 * THE FIX. `first_seen` -> `ebay_listings.created_at`, written once at
 * INSERT and never updated, and it is now the dashboard's default order.
 *
 * `newest` is deliberately KEPT and still maps to `fetched_at`: saved URLs
 * and bookmarks carry it, and "how stale is this row" is a real question.
 * These tests pin down that the two are genuinely different columns, because
 * the entire bug was that one was silently standing in for the other.
 */
describe("first_seen — recency of DISCOVERY", () => {
  it("sorts by created_at, the insert timestamp that is never rewritten", () => {
    expect(buildSortClause("first_seen", "desc")).toBe("(l.created_at) IS NULL, l.created_at DESC");
  });

  it("supports ascending for an oldest-first read", () => {
    expect(buildSortClause("first_seen", "asc")).toBe("(l.created_at) IS NULL, l.created_at ASC");
  });

  it("is NOT the same column as `newest` — that equivalence WAS the bug", () => {
    const firstSeen = buildSortClause("first_seen", "desc");
    const lastSeen = buildSortClause("newest", "desc");
    expect(firstSeen).not.toBe(lastSeen);
    expect(firstSeen).toContain("l.created_at");
    expect(firstSeen).not.toContain("fetched_at");
  });
});

describe("`newest` and `last_scan` keep their old meaning for saved links", () => {
  it("still map to fetched_at, unchanged", () => {
    expect(buildSortClause("newest", "desc")).toBe("(l.fetched_at) IS NULL, l.fetched_at DESC");
    expect(buildSortClause("last_scan", "desc")).toBe("(l.fetched_at) IS NULL, l.fetched_at DESC");
  });

  it("an unknown key still falls back to the original default, so nothing silently reorders", () => {
    const fallback = "o.qualifies DESC, COALESCE(o.score, o.flip_score, o.grade_score) DESC";
    expect(buildSortClause("first_seen_typo", "desc")).toBe(fallback);
  });
});

describe("the new key is injection-free like every other", () => {
  it("emits only the whitelisted expression, never the raw input", () => {
    const clause = buildSortClause("first_seen", "asc");
    expect(clause).not.toMatch(/[;']/);
    // Direction is a closed set: anything not exactly "asc" reads as DESC.
    expect(buildSortClause("first_seen", "asc; DROP TABLE ebay_listings--")).toContain("DESC");
  });
});

describe("the FLOOR is now sortable (2026-09-11)", () => {
  /**
   * Only psa9_profit and psa10_profit could be ordered by, so the dashboard
   * could rank by UPSIDE and nothing else — while this tool's strategy is
   * "break even at 6 or 7, everything above is free". Both columns were
   * already computed and stored; only the ORDER BY was missing.
   */
  it("ranks by profit at the lowest modelled grade", () => {
    expect(buildSortClause("psa6_profit", "desc")).toBe("(o.psa6_profit) IS NULL, o.psa6_profit DESC");
    expect(buildSortClause("psa7_profit", "desc")).toBe("(o.psa7_profit) IS NULL, o.psa7_profit DESC");
  });

  it("keeps the upside sorts working unchanged", () => {
    expect(buildSortClause("psa9_profit", "desc")).toBe("(o.psa9_profit) IS NULL, o.psa9_profit DESC");
    expect(buildSortClause("psa10_profit", "desc")).toBe("(o.psa10_profit) IS NULL, o.psa10_profit DESC");
  });

  it("puts a card with no figure at that grade LAST rather than pretending it is zero", () => {
    expect(buildSortClause("psa6_profit", "desc")).toContain("IS NULL,");
  });
});
