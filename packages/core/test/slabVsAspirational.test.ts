import { describe, it, expect } from "vitest";
import { classifyListingStructure, STRUCTURE_OVERRIDE_CONFIDENCE } from "../src/opportunity/listingStructure.js";

/**
 * REGRESSION GUARD for the 2026-09-11 slab/aspirational split.
 *
 * THE COMPLAINT: "I'm getting a lot of slabs in the Buy It Now filter."
 * Correct — slabs are overwhelmingly sold fixed-price, and a title-detected
 * slab sat at confidence 0.6, below the 0.85 override, so it stayed in the
 * ACTIONABLE feed carrying RAW-card economics.
 *
 * THE TRAP, and why the fix is a split rather than a lower threshold:
 * sellers market RAW cards with grade language — "PSA 10 candidate",
 * "would grade a 9". Those are ungraded cards, and they are precisely the
 * near-mint singles this tool exists to find. Route those away and the fix
 * costs far more than the bug.
 *
 * So: a bare grade statement acts; a grade statement wrapped in aspirational
 * wording does not. These tests pin down both sides, because getting the
 * second one wrong would silently delete the good inventory.
 */
function assess(title: string, itemCondition?: string) {
  return classifyListingStructure({ title, itemCondition });
}

describe("a bare grade in the title now reads as a slab and is acted on", () => {
  for (const title of [
    "Charizard Base Set PSA 9",
    "Pokemon Blastoise 1999 PSA 10 GEM MINT",
    "BGS 9.5 Pikachu Illustrator",
    "CGC 8 Venusaur Holo",
  ]) {
    it(`routes away: "${title}"`, () => {
      const result = assess(title);
      expect(result.structure).toBe("GRADED");
      expect(result.confidence).toBeGreaterThanOrEqual(STRUCTURE_OVERRIDE_CONFIDENCE);
    });
  }
});

describe("a RAW card marketed as grade-worthy is left alone — this is the inventory", () => {
  for (const title of [
    "Charizard Base Set PSA 10 candidate",
    "Blastoise holo - would grade a PSA 9 easily",
    "Pikachu - PSA 10 potential, raw card",
    "Venusaur, compares to a PSA 9",
    "Mewtwo holo PSA 10 ready",
    "Gyarados ungraded, PSA 9 worthy",
  ]) {
    it(`stays in the feed: "${title}"`, () => {
      const result = assess(title);
      expect(result.confidence).toBeLessThan(STRUCTURE_OVERRIDE_CONFIDENCE);
    });
  }
});

describe("eBay's own structured condition still outranks any title reading", () => {
  it("condition 'Graded' is certainty, whatever the title says", () => {
    const result = assess("Charizard PSA 10 candidate", "Graded");
    expect(result.structure).toBe("GRADED");
    expect(result.confidence).toBe(1);
    expect(result.source).toBe("EBAY_STRUCTURED_CONDITION");
  });
});

describe("a plain raw listing is untouched", () => {
  it("no grade language at all means no structure override", () => {
    const result = assess("Charizard Base Set Holo Near Mint");
    expect(result.confidence).toBeLessThan(STRUCTURE_OVERRIDE_CONFIDENCE);
  });

  it("lots are still detected independently", () => {
    expect(assess("Pokemon card bundle joblot 50 cards").structure).toBe("LOT");
  });
});

describe("nothing is ever deleted — only rerouted to a visible category", () => {
  it("a slab read produces GRADED, which the engine maps to REVIEW_ALREADY_GRADED", () => {
    // REVIEW is a category the user can open; a false positive costs a click,
    // not an opportunity. That asymmetry is what makes acting on the title
    // acceptable at all.
    expect(assess("Charizard PSA 9").structure).toBe("GRADED");
  });
});
