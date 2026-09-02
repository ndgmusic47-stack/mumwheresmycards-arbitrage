import { describe, it, expect } from "vitest";
import type { RawCardIdentity } from "@mwmc/core";
import { reconcileIdentityWithTitle } from "../src/scan/titleParser.js";

/**
 * REGRESSION GUARD for STABILISATION item 5 (identity safety).
 *
 * reconcileIdentityWithTitle() had NO test coverage at all before this —
 * both the pre-existing edition/finish/variant/language corroboration and
 * the new item-5 name/cardNumber corroboration are pinned down here. The
 * contract throughout is "corroborate or drop, never guess": a field is
 * only cleared (set to undefined) when the title actively contradicts or
 * fails to mention it, never defaulted/assumed either way. Dropping a
 * required field (name/cardNumber included) routes the listing to
 * REJECTED — CARD IDENTITY UNCERTAIN via the canonical resolver, which is
 * the deliberately safe outcome — see packages/core/src/card/resolver.ts.
 */
function target(overrides: Partial<RawCardIdentity> = {}): RawCardIdentity {
  return {
    game: "pokemon",
    name: "Charizard",
    setName: "Base Set",
    setCode: "base-set",
    cardNumber: "4/102",
    language: "EN",
    edition: "na",
    variant: "holo",
    finish: "na",
    ...overrides,
  };
}

describe("reconcileIdentityWithTitle — pre-existing edition/finish/variant/language corroboration", () => {
  it("keeps 1st edition when the title says so", () => {
    const result = reconcileIdentityWithTitle(target({ edition: "1st" }), "Charizard Base Set 1st Edition Holo 4/102");
    expect(result.edition).toBe("1st");
  });

  it("drops 1st edition when the title doesn't corroborate it", () => {
    const result = reconcileIdentityWithTitle(target({ edition: "1st" }), "Charizard Base Set Holo 4/102");
    expect(result.edition).toBeUndefined();
  });

  it("drops unlimited edition when the title actually says 1st edition (contradiction)", () => {
    const result = reconcileIdentityWithTitle(target({ edition: "unlimited" }), "Charizard Base Set 1st Edition Holo 4/102");
    expect(result.edition).toBeUndefined();
  });

  it("keeps shadowless finish when corroborated, drops reverse holo variant when title says reverse and target says holo", () => {
    const withFinish = reconcileIdentityWithTitle(target({ finish: "shadowless" }), "Charizard Shadowless 4/102");
    expect(withFinish.finish).toBe("shadowless");

    const withVariant = reconcileIdentityWithTitle(target({ variant: "holo" }), "Charizard Reverse Holo 4/102");
    expect(withVariant.variant).toBeUndefined();
  });

  it("drops a non-EN language target when the title never mentions it", () => {
    const result = reconcileIdentityWithTitle(target({ language: "JA" }), "Charizard Base Set Holo 4/102");
    expect(result.language).toBeUndefined();
  });

  it("drops an EN language target when the title mentions a different language", () => {
    const result = reconcileIdentityWithTitle(target({ language: "EN" }), "Charizard Japanese Base Set Holo 4/102");
    expect(result.language).toBeUndefined();
  });
});

describe("reconcileIdentityWithTitle — STABILISATION item 5 (name corroboration)", () => {
  it("keeps name when the title mentions the card", () => {
    const result = reconcileIdentityWithTitle(target(), "Pokemon Charizard Base Set Holo 4/102 PSA 9");
    expect(result.name).toBe("Charizard");
  });

  it("drops name when the title never mentions the card at all — the wrong-Pokémon case item 5 exists to catch", () => {
    const result = reconcileIdentityWithTitle(target(), "Pokemon Blastoise Base Set Holo 2/102 PSA 9");
    expect(result.name).toBeUndefined();
  });

  it("keeps name across spacing/punctuation differences (VMAX vs V MAX vs V-MAX)", () => {
    const vmaxTarget = target({ name: "Pikachu VMAX" });
    expect(reconcileIdentityWithTitle(vmaxTarget, "Pikachu V MAX Vivid Voltage 044/185").name).toBe("Pikachu VMAX");
    expect(reconcileIdentityWithTitle(vmaxTarget, "Pikachu V-MAX Vivid Voltage 044/185").name).toBe("Pikachu VMAX");
  });
});

describe("reconcileIdentityWithTitle — STABILISATION item 5 (cardNumber corroboration)", () => {
  it("keeps cardNumber when the title's N/M number matches", () => {
    const result = reconcileIdentityWithTitle(target({ cardNumber: "4/102" }), "Charizard Base Set Holo 4/102");
    expect(result.cardNumber).toBe("4/102");
  });

  it("drops cardNumber when the title states a contradicting N/M number — the wrong-printing case item 5 exists to catch", () => {
    const result = reconcileIdentityWithTitle(target({ cardNumber: "4/102" }), "Charizard Base Set Holo 10/102");
    expect(result.cardNumber).toBeUndefined();
  });

  it("keeps cardNumber when the title omits any number — absence is not a contradiction", () => {
    const result = reconcileIdentityWithTitle(target({ cardNumber: "4/102" }), "Charizard Base Set Holo PSA 9");
    expect(result.cardNumber).toBe("4/102");
  });

  it("does not attempt corroboration for a cardNumber without a '/' (non-N/M format)", () => {
    const result = reconcileIdentityWithTitle(target({ cardNumber: "SWSH040" }), "Charizard Sword Shield Promo 10/102");
    expect(result.cardNumber).toBe("SWSH040");
  });
});

describe("reconcileIdentityWithTitle — setName/setCode/year/rarity/game pass through unchanged", () => {
  it("never alters setName or setCode regardless of title content", () => {
    const result = reconcileIdentityWithTitle(
      target({ setName: "Base Set", setCode: "base-set" }),
      "Charizard Some Totally Different Set Name 4/102",
    );
    expect(result.setName).toBe("Base Set");
    expect(result.setCode).toBe("base-set");
  });
});
