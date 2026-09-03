import { describe, it, expect } from "vitest";
import { classifyListingStructure, STRUCTURE_OVERRIDE_CONFIDENCE } from "../src/opportunity/listingStructure.js";

describe("classifyListingStructure — AI INTELLIGENCE item 6", () => {
  it("treats eBay's own structured 'Graded' condition as a confident, override-worthy signal", () => {
    const result = classifyListingStructure({ title: "Charizard VMAX PSA 10", itemCondition: "Graded" });
    expect(result.structure).toBe("GRADED");
    expect(result.confidence).toBeGreaterThanOrEqual(STRUCTURE_OVERRIDE_CONFIDENCE);
    expect(result.source).toBe("EBAY_STRUCTURED_CONDITION");
  });

  it("is case-insensitive on eBay's structured condition value", () => {
    const result = classifyListingStructure({ title: "Slab", itemCondition: "graded" });
    expect(result.structure).toBe("GRADED");
    expect(result.confidence).toBeGreaterThanOrEqual(STRUCTURE_OVERRIDE_CONFIDENCE);
  });

  it("treats a title-only grading-company + grade mention as a WEAK signal that does not clear the override bar", () => {
    const result = classifyListingStructure({ title: "Charizard VMAX compares to PSA 9 quality", itemCondition: "Ungraded" });
    expect(result.structure).toBe("GRADED");
    expect(result.confidence).toBeLessThan(STRUCTURE_OVERRIDE_CONFIDENCE);
    expect(result.source).toBe("TITLE_PATTERN");
  });

  it.each([
    "Pokemon Card Lot of 50 Bulk Common Uncommon",
    "Huge Pokemon Job Lot Vintage Cards",
    "Pokemon Bundle of 20 Holo Rares",
    "Pokemon Collection of 100 Cards Mixed",
    "Wholesale Lot Pokemon Cards TCG",
    "Bulk Lot Pokemon Trading Cards",
    "x50 Pokemon Cards Mixed Rarity",
    "200 Cards Lot Pokemon TCG Mixed",
  ])("detects confident lot/bundle language: %s", (title) => {
    const result = classifyListingStructure({ title, itemCondition: undefined });
    expect(result.structure).toBe("LOT");
    expect(result.confidence).toBeGreaterThanOrEqual(STRUCTURE_OVERRIDE_CONFIDENCE);
    expect(result.source).toBe("TITLE_PATTERN");
  });

  it("does not flag a single-card listing that merely mentions a number in its title", () => {
    const result = classifyListingStructure({ title: "Umbreon VMAX Evolving Skies 215/203 Alt Art", itemCondition: "Ungraded" });
    expect(result.structure).toBe("SINGLE");
    expect(result.confidence).toBe(0);
  });

  it("defaults to SINGLE (unconfirmed), never a false confirmation, when no signal is present", () => {
    const result = classifyListingStructure({ title: "Pikachu Base Set 58/102", itemCondition: undefined });
    expect(result.structure).toBe("SINGLE");
    expect(result.confidence).toBe(0);
    expect(result.evidence[0]).toMatch(/not confirmed/i);
  });

  it("returns UNKNOWN for an empty title", () => {
    const result = classifyListingStructure({ title: "", itemCondition: undefined });
    expect(result.structure).toBe("UNKNOWN");
    expect(result.confidence).toBe(0);
  });

  it("prioritises eBay's structured condition over conflicting title lot-language", () => {
    // A graded slab being sold as part of a described "lot" of one — the
    // structured, first-party fact wins over title parsing either way.
    const result = classifyListingStructure({ title: "Lot of 1 Graded PSA 10 Charizard", itemCondition: "Graded" });
    expect(result.structure).toBe("GRADED");
    expect(result.source).toBe("EBAY_STRUCTURED_CONDITION");
  });
});
