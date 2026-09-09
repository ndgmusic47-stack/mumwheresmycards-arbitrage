import { describe, it, expect } from "vitest";
import { buildFilterConditions } from "../src/routes/opportunities.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * REGRESSION GUARD for the 2026-09-09 Save/Pass workflow.
 *
 * The user's requirement was specific and stronger than a UI toggle: a
 * listing marked Passed "must not keep appearing in the working feed,
 * INCLUDING after future scans". That guarantee has two halves and both are
 * pinned here, because either one silently breaking would put dismissed
 * listings back in front of him with no error anywhere.
 */
describe("Pass: excluded from the working feed", () => {
  it("emits a NOT IN clause for excluded statuses", () => {
    const { clause, params } = buildFilterConditions(new URLSearchParams({ excludeReviewStatus: "PASS" }));
    expect(clause).toContain("o.review_status NOT IN (?)");
    expect(params).toEqual(["PASS"]);
  });

  it("supports several excluded statuses at once", () => {
    const { clause, params } = buildFilterConditions(new URLSearchParams({ excludeReviewStatus: "PASS,BOUGHT" }));
    expect(clause).toContain("o.review_status NOT IN (?,?)");
    expect(params).toEqual(["PASS", "BOUGHT"]);
  });

  it("stays silent on a blank value rather than emitting an always-false clause", () => {
    const { clause, params } = buildFilterConditions(new URLSearchParams({ excludeReviewStatus: "" }));
    expect(clause).toBe("");
    expect(params).toEqual([]);
  });

  it("can be combined with an explicit reviewStatus without the two colliding", () => {
    // "show me only my saved ones, but never the passed ones" is coherent and
    // must produce both clauses rather than one overwriting the other.
    const { clause, params } = buildFilterConditions(
      new URLSearchParams({ reviewStatus: "INTERESTED", excludeReviewStatus: "PASS" }),
    );
    expect(clause).toContain("o.review_status IN (?)");
    expect(clause).toContain("o.review_status NOT IN (?)");
    expect(params).toEqual(["INTERESTED", "PASS"]);
  });
});

describe("Pass survives a re-scan", () => {
  /**
   * The second half of the guarantee, and the one that cannot be expressed as
   * a query: `upsertOpportunity` re-fires on EVERY scan for a listing that is
   * still live (same listing_id + strategy -> same row id). If its
   * `ON CONFLICT ... DO UPDATE SET` clause ever mentioned review_status, a
   * scan half an hour later would reset the user's decision to UNREVIEWED and
   * the listing would silently reappear.
   *
   * Asserted against the SQL text itself rather than by round-tripping a
   * value, because "the column is absent from the UPDATE SET clause" is the
   * actual invariant — a round-trip test would still pass if someone added
   * `review_status = excluded.review_status` while a scan happened not to
   * change it.
   */
  it("never writes review_status/review_notes/reviewed_at in the ON CONFLICT clause", () => {
    const source = readFileSync(resolve(__dirname, "..", "src", "repo", "opportunitiesRepo.ts"), "utf-8");
    const start = source.indexOf("ON CONFLICT(id) DO UPDATE SET");
    expect(start).toBeGreaterThan(-1);
    // The clause runs to the end of that SQL template literal.
    const clause = source.slice(start, source.indexOf("`", start));
    // Strip comments — the clause deliberately EXPLAINS the omission in prose,
    // and that prose naturally names the columns it is refusing to write.
    const sql = clause
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/review_status\s*=/);
    expect(sql).not.toMatch(/review_notes\s*=/);
    expect(sql).not.toMatch(/reviewed_at\s*=/);
  });
});
