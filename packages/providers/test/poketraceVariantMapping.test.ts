import { describe, it, expect } from "vitest";
import { mapPokeTraceVariant } from "../src/catalogue/poketraceVariantMapping.js";

describe("mapPokeTraceVariant", () => {
  it("maps all 6 documented PokeTrace variant values", () => {
    expect(mapPokeTraceVariant("Normal")).toEqual({ edition: "na", variant: "normal", finish: "na" });
    expect(mapPokeTraceVariant("Holofoil")).toEqual({ edition: "na", variant: "holo", finish: "na" });
    expect(mapPokeTraceVariant("Reverse_Holofoil")).toEqual({ edition: "na", variant: "reverse_holo", finish: "na" });
    expect(mapPokeTraceVariant("1st_Edition")).toEqual({ edition: "1st", variant: "normal", finish: "na" });
    expect(mapPokeTraceVariant("1st_Edition_Holofoil")).toEqual({ edition: "1st", variant: "holo", finish: "na" });
    expect(mapPokeTraceVariant("Unlimited")).toEqual({ edition: "unlimited", variant: "normal", finish: "na" });
  });

  it("never guesses — returns null for an unrecognized variant string rather than a best-effort mapping", () => {
    expect(mapPokeTraceVariant("Textured_Foil_Special")).toBeNull();
    expect(mapPokeTraceVariant(null)).toBeNull();
  });

  it("never returns a shadowless/unlimited_shadow finish (documented gap — catalogue data alone cannot detect it)", () => {
    const variants: string[] = ["Normal", "Holofoil", "Reverse_Holofoil", "1st_Edition", "1st_Edition_Holofoil", "Unlimited"];
    for (const v of variants) {
      expect(mapPokeTraceVariant(v)!.finish).toBe("na");
    }
  });
});
