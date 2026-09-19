import { describe, it, expect } from "vitest";
import {
  classifyEbayCondition,
  normaliseConditionValue,
  rawConditionSpellingsFor,
} from "../src/opportunity/ebayCondition.js";
import { classifyListingStructure } from "../src/opportunity/listingStructure.js";

/**
 * Every value in this file was read out of the production `ebay_listings`
 * table on 2026-09-13, with its live count. Nothing here is a guess at what
 * a locale might send.
 *
 *   Graded 5851 · Valutata 88 · Bewertet 61 · Gradée 6 · Gradé 1
 *   Ungraded 44477 · Non gradata 391 · Nicht bewertet 165 · Non gradée 73 · Non gradé 20
 *   Used 196 · Gebraucht 19 · Usato 6 · New 82 · Unspecified 6
 */
describe("eBay says GRADED, in whatever language the seller uses", () => {
  it.each([
    ["Graded", "EN"],
    ["Valutata", "IT"],
    ["Bewertet", "DE"],
    ["Gradée", "FR feminine"],
    ["Gradé", "FR masculine"],
  ])("classifies %s (%s) as GRADED", (value) => {
    expect(classifyEbayCondition(value)).toBe("GRADED");
  });

  it("was the leak: 156 live listings eBay called slabs were priced as raw cards", () => {
    // The classifier matched the single literal "graded" and nothing else.
    for (const value of ["Valutata", "Bewertet", "Gradée", "Gradé"]) {
      const assessment = classifyListingStructure({ title: "Charizard Base Set Holo 4/102", itemCondition: value });
      expect(assessment.structure).toBe("GRADED");
      expect(assessment.confidence).toBe(1);
      expect(assessment.source).toBe("EBAY_STRUCTURED_CONDITION");
    }
  });
});

describe("eBay says UNGRADED — and the negatives must never fall through", () => {
  it.each([
    ["Ungraded", "EN"],
    ["Non gradata", "IT"],
    ["Nicht bewertet", "DE"],
    ["Non gradée", "FR feminine"],
    ["Non gradé", "FR masculine"],
  ])("classifies %s (%s) as UNGRADED", (value) => {
    expect(classifyEbayCondition(value)).toBe("UNGRADED");
  });

  /**
   * THE INVERSION THIS GUARDS AGAINST. "Non gradée" CONTAINS "gradée". Any
   * substring test for a graded marker would classify every French raw card
   * as a slab — worse than the original bug, because it hides real buys
   * instead of surfacing fake ones.
   */
  it("never reads a French raw card as a slab", () => {
    for (const value of ["Non gradée", "Non gradé"]) {
      expect(classifyEbayCondition(value)).toBe("UNGRADED");
      expect(classifyListingStructure({ title: "Dracaufeu Set de Base 4/102", itemCondition: value }).structure).not.toBe(
        "GRADED",
      );
    }
  });
});

describe("what the tool does NOT recognise, it says it does not recognise", () => {
  it.each(["Used", "Gebraucht", "Usato", "Occasion", "New", "Brand New", "Unspecified", "Very Good"])(
    "classifies %s as OTHER rather than guessing",
    (value) => {
      expect(classifyEbayCondition(value)).toBe("OTHER");
    },
  );

  it("distinguishes 'not told' from 'told it is raw'", () => {
    expect(classifyEbayCondition(null)).toBe("UNKNOWN");
    expect(classifyEbayCondition(undefined)).toBe("UNKNOWN");
    expect(classifyEbayCondition("   ")).toBe("UNKNOWN");
    expect(classifyEbayCondition("Ungraded")).toBe("UNGRADED");
  });

  it("treats an unseen locale as OTHER, so a new gap is visible rather than silent", () => {
    expect(classifyEbayCondition("Calificada")).toBe("OTHER");
  });
});

describe("normalisation", () => {
  it("ignores case, padding and accents", () => {
    expect(normaliseConditionValue("  GRADÉE ")).toBe("gradee");
    expect(normaliseConditionValue("Nicht   bewertet")).toBe("nicht bewertet");
  });

  it("returns null for nothing at all", () => {
    expect(normaliseConditionValue("")).toBeNull();
    expect(normaliseConditionValue(null)).toBeNull();
  });
});

describe("the spellings handed to SQL", () => {
  it("asks for every language, in eBay's own casing", () => {
    expect(rawConditionSpellingsFor("UNGRADED")).toEqual([
      "Ungraded",
      "Non gradata",
      "Nicht bewertet",
      "Non gradée",
      "Non gradé",
    ]);
    expect(rawConditionSpellingsFor("GRADED")).toEqual(["Graded", "Valutata", "Bewertet", "Gradée", "Gradé"]);
  });

  it("keeps the two sets disjoint once normalised", () => {
    const graded = rawConditionSpellingsFor("GRADED").map(normaliseConditionValue);
    const ungraded = rawConditionSpellingsFor("UNGRADED").map(normaliseConditionValue);
    expect(graded.filter((g) => ungraded.includes(g))).toEqual([]);
  });
});
