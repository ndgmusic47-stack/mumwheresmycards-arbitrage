import { describe, it, expect } from "vitest";
import { groupCardsBySearchKeyword } from "../src/market/searchGrouping.js";

/**
 * REGRESSION GUARD for STABILISATION item 11 ("avoid duplicate eBay
 * calls/listings"). Two different eligible printings of the same physical
 * card (e.g. 1st Edition vs Unlimited, holo vs reverse holo) share an
 * identical search keyword string, because keywords are built from
 * name+set+number only — edition/finish/variant/language are deliberately
 * excluded (see titleParser.ts). Without grouping, scanRunner would call
 * eBay with the exact same query twice for the same run.
 */
describe("groupCardsBySearchKeyword", () => {
  it("returns one group per card when every keyword is unique", () => {
    const groups = groupCardsBySearchKeyword([
      { cardId: "a", keywords: "Charizard Base Set 4/102" },
      { cardId: "b", keywords: "Blastoise Base Set 2/102" },
    ]);

    expect(groups).toEqual([
      { keywords: "Charizard Base Set 4/102", cardIds: ["a"] },
      { keywords: "Blastoise Base Set 2/102", cardIds: ["b"] },
    ]);
  });

  it("groups two different printings sharing an identical keyword into one search", () => {
    // Same name+set+number, but these are genuinely different catalogued
    // printings (1st Edition vs Unlimited) — the exact scenario this exists
    // to catch.
    const groups = groupCardsBySearchKeyword([
      { cardId: "charizard-1st", keywords: "Charizard Base Set 4/102" },
      { cardId: "charizard-unlimited", keywords: "Charizard Base Set 4/102" },
    ]);

    expect(groups).toEqual([{ keywords: "Charizard Base Set 4/102", cardIds: ["charizard-1st", "charizard-unlimited"] }]);
  });

  it("groups three-or-more-way collisions (holo / reverse holo / stamped variants) into a single group", () => {
    const groups = groupCardsBySearchKeyword([
      { cardId: "v-holo", keywords: "Pikachu VMAX Vivid Voltage 44/185" },
      { cardId: "v-reverse", keywords: "Pikachu VMAX Vivid Voltage 44/185" },
      { cardId: "v-stamped", keywords: "Pikachu VMAX Vivid Voltage 44/185" },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.cardIds).toEqual(["v-holo", "v-reverse", "v-stamped"]);
  });

  it("preserves first-seen order across a mix of unique and colliding keywords", () => {
    const groups = groupCardsBySearchKeyword([
      { cardId: "a", keywords: "K1" },
      { cardId: "b", keywords: "K2" },
      { cardId: "c", keywords: "K1" },
      { cardId: "d", keywords: "K3" },
    ]);

    expect(groups.map((g) => g.keywords)).toEqual(["K1", "K2", "K3"]);
    expect(groups[0]!.cardIds).toEqual(["a", "c"]);
  });

  it("returns an empty array for an empty input", () => {
    expect(groupCardsBySearchKeyword([])).toEqual([]);
  });

  it("total cardIds across all groups always equals the input length — nothing is dropped", () => {
    const input = [
      { cardId: "a", keywords: "K1" },
      { cardId: "b", keywords: "K1" },
      { cardId: "c", keywords: "K2" },
      { cardId: "d", keywords: "K1" },
      { cardId: "e", keywords: "K3" },
    ];
    const groups = groupCardsBySearchKeyword(input);
    const total = groups.reduce((sum, g) => sum + g.cardIds.length, 0);
    expect(total).toBe(input.length);
  });
});
