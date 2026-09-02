import { describe, it, expect } from "vitest";
import { buildStateCondition } from "../src/routes/opportunities.js";

/**
 * REGRESSION GUARD for STABILISATION item 10.
 *
 * GET /api/opportunities used to only accept a single `state` value, so the
 * dashboard's category buckets (e.g. "REJECTED" = NO_MARKET_DATA +
 * REJECTED_CARD_IDENTITY_UNCERTAIN + REJECTED_COMPUTATION_ERROR) could never
 * be requested from the server — the dashboard was left either fetching the
 * unfiltered feed and hiding rows client-side (the exact "hidden filtering"
 * the stabilisation spec warns against, since `total`/`remaining` then
 * describe the wrong set of rows) or matching only one state at a time.
 * buildStateCondition is the pure piece of that fix: given the raw query
 * param, it returns exactly the SQL condition and bound params the route
 * appends to its WHERE clause.
 */
describe("buildStateCondition", () => {
  it("returns null for an absent or empty state param — no WHERE clause added", () => {
    expect(buildStateCondition(undefined)).toBeNull();
    expect(buildStateCondition("")).toBeNull();
  });

  it("still builds a plain equality condition for a single state (unchanged, pre-existing behaviour)", () => {
    expect(buildStateCondition("QUALIFIED_FLIP")).toEqual({
      clause: "o.state = ?",
      params: ["QUALIFIED_FLIP"],
    });
  });

  it("builds an IN (...) condition for a comma-separated list, one placeholder per state", () => {
    const result = buildStateCondition("NO_MARKET_DATA,REJECTED_CARD_IDENTITY_UNCERTAIN,REJECTED_COMPUTATION_ERROR");
    expect(result).not.toBeNull();
    expect(result!.clause).toBe("o.state IN (?,?,?)");
    expect(result!.params).toEqual([
      "NO_MARKET_DATA",
      "REJECTED_CARD_IDENTITY_UNCERTAIN",
      "REJECTED_COMPUTATION_ERROR",
    ]);
    // Placeholder count must match bound param count, or D1 rejects the
    // query outright (see sqlParameterParity.test.ts for why this matters).
    const placeholderCount = (result!.clause.match(/\?/g) ?? []).length;
    expect(result!.params.length).toBe(placeholderCount);
  });

  it("tolerates stray whitespace and trailing commas from a hand-built query string", () => {
    const result = buildStateCondition(" QUALIFIED_FLIP , QUALIFIED_GRADE ,");
    expect(result).toEqual({
      clause: "o.state IN (?,?)",
      params: ["QUALIFIED_FLIP", "QUALIFIED_GRADE"],
    });
  });

  it("the two ACTIONABLE states the dashboard's category tab actually sends", () => {
    expect(buildStateCondition("QUALIFIED_FLIP,QUALIFIED_GRADE")).toEqual({
      clause: "o.state IN (?,?)",
      params: ["QUALIFIED_FLIP", "QUALIFIED_GRADE"],
    });
  });
});
