import { describe, it, expect } from "vitest";
import {
  mapTierKey,
  normaliseTierKey,
  graderIdForTierKey,
  resolveGradedPrices,
  gradersWithPrices,
} from "../src/deal/gradedTierKeys.js";

/**
 * The provider hands back ~30 graded prices across three graders. These tests
 * pin down which ones may be USED, and — more importantly — which must be
 * stored but not used, because using them would require a guess.
 *
 * The tier keys below are the real ones observed from a live PokeTrace call
 * on 2026-09-12, not invented examples.
 */
describe("recognising a provider's tier keys", () => {
  it("maps the grades that exist on a published scale", () => {
    expect(mapTierKey("PSA_9").rung?.key).toBe("PSA_9");
    expect(mapTierKey("PSA_5").rung?.label).toBe("EX 5");
    expect(mapTierKey("SGC_8_5").rung?.label).toBe("NM/MT+ 8.5");
    expect(mapTierKey("TAG_6_5").rung?.label).toBe("EX MT+ 6.5");
  });

  it("tolerates separator and case variations rather than dropping a grade", () => {
    expect(normaliseTierKey("psa-8")).toBe("PSA_8");
    expect(normaliseTierKey(" psa 8 ")).toBe("PSA_8");
    expect(mapTierKey("psa_9").rung?.key).toBe("PSA_9");
  });

  it("knows which grader a key belongs to", () => {
    expect(graderIdForTierKey("SGC_7")).toBe("SGC");
    expect(graderIdForTierKey("TAG_10")).toBe("TAG");
    expect(graderIdForTierKey("BGS_9")).toBeNull();
  });
});

describe("what must NOT be mapped", () => {
  it("refuses an ambiguous ten rather than picking one of the two", () => {
    // CGC, SGC and TAG each have a Pristine 10 AND a Gem Mint 10 — different
    // outcomes at very different prices. A bare "TAG_10" could be either or
    // a blend, and assigning it would misprice the top of the ladder.
    for (const key of ["TAG_10", "SGC_10", "CGC_10"]) {
      const mapping = mapTierKey(key);
      expect(mapping.rung).toBeNull();
      expect(mapping.unmappedReason).toBe("AMBIGUOUS_TEN");
    }
  });

  it("maps PSA's single ten cleanly, because PSA has only one", () => {
    expect(mapTierKey("PSA_10").rung?.key).toBe("PSA_10");
  });

  it("stores but does not map a grade the scale has not verified", () => {
    // PokeTrace returns PSA_8_5. PSA's own half-grade list has not been
    // verified for this project, so PSA_SCALE has no 8.5 rung — the price
    // is kept in the map, and connects the day the scale is extended.
    const mapping = mapTierKey("PSA_8_5");
    expect(mapping.graderId).toBe("PSA");
    expect(mapping.rung).toBeNull();
    expect(mapping.unmappedReason).toBe("NO_SUCH_RUNG");
  });

  it("ignores a grader it has no published scale for", () => {
    expect(mapTierKey("BGS_9_5").graderId).toBeNull();
  });
});

describe("resolving a real price map onto one grader", () => {
  // The tier keys observed live, with plausible GBP figures.
  const prices = {
    PSA_3: 12, PSA_4: 15, PSA_4_5: 17, PSA_5: 22, PSA_5_5: 25,
    PSA_6: 30, PSA_6_5: 32, PSA_7: 33, PSA_7_5: 40, PSA_8: 74,
    PSA_8_5: 90, PSA_9: 237, PSA_10: 2014,
    SGC_8: 60, SGC_9: 180, TAG_9: 190, TAG_10: 1500,
  };

  it("returns only the asked-for grader, highest grade first", () => {
    const { priced } = resolveGradedPrices(prices, "PSA");
    expect(priced[0]!.gradeKey).toBe("PSA_10");
    expect(priced.at(-1)!.gradeKey).toBe("PSA_3");
    expect(priced.every((p) => p.gradeKey.startsWith("PSA_"))).toBe(true);
  });

  it("surfaces the low grades that were previously discarded entirely", () => {
    // This is the whole point: PSA 3, 4 and 5 were never read before.
    const keys = resolveGradedPrices(prices, "PSA").priced.map((p) => p.gradeKey);
    expect(keys).toEqual(expect.arrayContaining(["PSA_5", "PSA_4", "PSA_3"]));
  });

  it("reports the tiers it could not map instead of hiding them", () => {
    const { priced, unmappableTiers } = resolveGradedPrices(prices, "PSA");
    expect(priced.some((p) => p.tierKey === "PSA_8_5")).toBe(false);
    expect(unmappableTiers.map((t) => t.tierKey)).toEqual(
      expect.arrayContaining(["PSA_4_5", "PSA_5_5", "PSA_6_5", "PSA_7_5", "PSA_8_5"]),
    );
  });

  it("excludes TAG's ambiguous ten from the priced list, and says why", () => {
    const { priced, unmappableTiers } = resolveGradedPrices(prices, "TAG");
    expect(priced.map((p) => p.gradeKey)).toEqual(["TAG_9"]);
    expect(unmappableTiers.find((t) => t.tierKey === "TAG_10")!.unmappedReason).toBe("AMBIGUOUS_TEN");
  });

  it("rejects a negative or non-finite price rather than passing it through", () => {
    const { priced } = resolveGradedPrices({ PSA_9: -5, PSA_8: Number.NaN, PSA_7: 33 }, "PSA");
    expect(priced.map((p) => p.gradeKey)).toEqual(["PSA_7"]);
  });

  it("lists every grader the map carries a price for", () => {
    expect(gradersWithPrices(prices)).toEqual(["PSA", "SGC", "TAG"]);
  });

  it("returns nothing for a grader with no published scale", () => {
    expect(resolveGradedPrices(prices, "BGS").priced).toEqual([]);
  });
});
