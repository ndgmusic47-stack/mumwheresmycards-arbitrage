import { describe, it, expect } from "vitest";
import { rankMarket, DEFAULT_EXTERNAL_REF_MARKET_PREFERENCE } from "../src/repo/externalCardRefsRepo.js";

/**
 * Unit coverage for the pure ranking rule behind findExternalRefForCard's
 * ORDER BY (see that function's doc comment for the "why" — this used to
 * be an unordered `LIMIT 1`, arbitrarily picking between a card's US vs EU
 * provider refs). This repo has no D1/Miniflare test harness, so the SQL
 * itself isn't exercised here — this locks down the ranking LOGIC that SQL
 * is generated from.
 */
describe("rankMarket", () => {
  it("ranks markets in the given preference order, most-preferred = 0", () => {
    expect(rankMarket("EU", ["EU", "US"])).toBe(0);
    expect(rankMarket("US", ["EU", "US"])).toBe(1);
  });

  it("ranks an unrecognized market after every named preference", () => {
    expect(rankMarket("JP", ["EU", "US"])).toBe(2);
  });

  it("ranks a null market (e.g. a ref written before migration 0011) after every named preference", () => {
    expect(rankMarket(null, ["EU", "US"])).toBe(2);
  });

  it("respects a reordered preference list", () => {
    expect(rankMarket("US", ["US", "EU"])).toBe(0);
    expect(rankMarket("EU", ["US", "EU"])).toBe(1);
  });

  it("the default preference is a documented placeholder (EU ahead of US)", () => {
    expect(DEFAULT_EXTERNAL_REF_MARKET_PREFERENCE).toEqual(["EU", "US"]);
  });
});
