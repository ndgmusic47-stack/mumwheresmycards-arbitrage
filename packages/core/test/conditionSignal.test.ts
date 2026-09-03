import { describe, expect, it } from "vitest";
import { detectListingConditionSignal } from "../src/opportunity/conditionSignal.js";

describe("detectListingConditionSignal (SOURCING WORKFLOW item 8)", () => {
  it("detects a full spelled-out condition phrase", () => {
    expect(detectListingConditionSignal("Charizard Base Set Holo - Heavily Played").tier).toBe("HEAVILY_PLAYED");
    expect(detectListingConditionSignal("Pikachu VMAX - Damaged corners").tier).toBe("DAMAGED");
    expect(detectListingConditionSignal("Blastoise Moderately Played condition").tier).toBe("MODERATELY_PLAYED");
    expect(detectListingConditionSignal("Venusaur - Lightly Played").tier).toBe("LIGHTLY_PLAYED");
    expect(detectListingConditionSignal("Charizard Near Mint raw single").tier).toBe("NEAR_MINT");
  });

  it("returns null (not NEAR_MINT) for a title with no condition claim at all — silence is not a claim", () => {
    const result = detectListingConditionSignal("Charizard Base Set Holo 4/102 Unlimited");
    expect(result.tier).toBeNull();
    expect(result.matchedText).toBeNull();
  });

  it("NEVER matches the bare abbreviation 'HP' — that's the card's own printed stat, not a condition claim", () => {
    expect(detectListingConditionSignal("Charizard 150HP EX").tier).toBeNull();
    expect(detectListingConditionSignal("Base Set Blastoise 100 HP holo").tier).toBeNull();
    expect(detectListingConditionSignal("Mewtwo GX 130HP heavily played").tier).toBe("HEAVILY_PLAYED"); // the spelled-out phrase still matches
  });

  it("never matches other bare abbreviations (LP, NM, MP, DMG) either — full phrases only", () => {
    expect(detectListingConditionSignal("Charizard LP raw single").tier).toBeNull();
    expect(detectListingConditionSignal("Charizard NM condition").tier).toBeNull();
    expect(detectListingConditionSignal("Charizard MP grade").tier).toBeNull();
    expect(detectListingConditionSignal("Charizard DMG edges").tier).toBeNull();
  });

  it("is case-insensitive and tolerates a hyphen in place of a space", () => {
    expect(detectListingConditionSignal("CHARIZARD heavily-played").tier).toBe("HEAVILY_PLAYED");
    expect(detectListingConditionSignal("charizard NEAR-MINT").tier).toBe("NEAR_MINT");
  });

  it("returns the matched substring for display, not just the tier", () => {
    const result = detectListingConditionSignal("Charizard - Lightly Played - raw");
    expect(result.matchedText?.toLowerCase()).toBe("lightly played");
  });

  it("handles null/undefined/empty title without throwing", () => {
    expect(detectListingConditionSignal(null).tier).toBeNull();
    expect(detectListingConditionSignal(undefined).tier).toBeNull();
    expect(detectListingConditionSignal("").tier).toBeNull();
  });
});
