import { describe, expect, it } from "vitest";
import { formatFetchedAt } from "../src/components/OpportunityTable";

/**
 * WHY THESE EXIST (2026-09-13).
 *
 * Reproduced live: a single row whose timestamp came back null threw inside
 * a table cell, and because the app had no error boundary anywhere, React
 * unmounted the entire tree — a blank white page, the real error visible
 * only in a console nobody has open while sourcing. That is what "it
 * crashes" looked like from the outside.
 *
 * Two things were done about it. The boundary (see components/ErrorBoundary)
 * contains and NAMES any future one. These tests cover the other half: the
 * specific formatters that took a value the type said could not happen.
 *
 * The point is not that the column is nullable — `ebay_listings.fetched_at`
 * and `created_at` are both NOT NULL, and TypeScript is right about every
 * normal row. The point is that a display helper must degrade to an em dash
 * when handed something it cannot read, because the alternative is losing
 * the whole page over a dash's worth of information.
 */
describe("formatFetchedAt", () => {
  it("returns an em dash rather than throwing on null", () => {
    expect(formatFetchedAt(null)).toBe("—");
  });

  it("returns an em dash rather than throwing on undefined", () => {
    expect(formatFetchedAt(undefined)).toBe("—");
  });

  it("returns an em dash on an empty string", () => {
    expect(formatFetchedAt("")).toBe("—");
  });

  it("returns an em dash on unparseable text rather than 'NaNd ago'", () => {
    expect(formatFetchedAt("not a date")).toBe("—");
  });

  it("still reads a plain SQLite timestamp as UTC", () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
    expect(formatFetchedAt(twoHoursAgo)).toBe("2h ago");
  });

  it("still reads an ISO timestamp", () => {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(formatFetchedAt(thirtyMinutesAgo)).toBe("30m ago");
  });
});
