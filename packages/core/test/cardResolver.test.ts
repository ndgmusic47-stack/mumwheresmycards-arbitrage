import { describe, it, expect } from "vitest";
import { resolveCardPrinting, isSamePrinting } from "../src/card/resolver.js";
import type { RawCardIdentity } from "../src/card/types.js";

const complete: RawCardIdentity = {
  game: "pokemon",
  name: "Charizard",
  setName: "Base Set",
  setCode: "BS",
  cardNumber: "4/102",
  year: 1999,
  language: "EN",
  edition: "1st",
  variant: "holo",
  finish: "shadowless",
  rarity: "Holo Rare",
};

describe("resolveCardPrinting", () => {
  it("resolves a complete identity to a CardPrinting with a stable hash", () => {
    const result = resolveCardPrinting(complete);
    expect(result.ok).toBe(true);
    expect(result.printing).not.toBeNull();
    expect(result.printing!.printingHash).toMatch(/^pc_[0-9a-f]{8}$/);
  });

  it("is deterministic — the same identity always produces the same hash", () => {
    const a = resolveCardPrinting(complete);
    const b = resolveCardPrinting({ ...complete });
    expect(a.printing!.printingHash).toBe(b.printing!.printingHash);
  });

  it("fails (does not guess) when a required field is missing", () => {
    const { edition, ...withoutEdition } = complete;
    const result = resolveCardPrinting(withoutEdition);
    expect(result.ok).toBe(false);
    expect(result.printing).toBeNull();
    expect(result.missingFields).toContain("edition");
  });

  it("never defaults a missing field silently — multiple missing fields are all reported", () => {
    const result = resolveCardPrinting({ name: "Blastoise", setCode: "BS" });
    expect(result.ok).toBe(false);
    expect(result.missingFields.length).toBeGreaterThan(3);
  });

  describe("distinct printings never collide", () => {
    it("1st Edition vs Unlimited hash differently", () => {
      const firstEd = resolveCardPrinting({ ...complete, edition: "1st" });
      const unlimited = resolveCardPrinting({ ...complete, edition: "unlimited" });
      expect(firstEd.printing!.printingHash).not.toBe(unlimited.printing!.printingHash);
    });

    it("Shadowless vs Unlimited finish hash differently", () => {
      const shadowless = resolveCardPrinting({ ...complete, finish: "shadowless" });
      const unlimitedShadow = resolveCardPrinting({ ...complete, finish: "unlimited_shadow" });
      expect(shadowless.printing!.printingHash).not.toBe(unlimitedShadow.printing!.printingHash);
    });

    it("holo vs non-holo vs reverse vs stamped vs promo hash differently", () => {
      const variants: RawCardIdentity["variant"][] = ["normal", "holo", "reverse_holo", "stamped", "promo"];
      const hashes = variants.map(
        (variant) =>
          resolveCardPrinting({
            ...complete,
            variant,
            stampType: variant === "stamped" ? "Staff" : undefined,
          }).printing!.printingHash,
      );
      expect(new Set(hashes).size).toBe(variants.length);
    });

    it("different languages hash differently", () => {
      const en = resolveCardPrinting({ ...complete, language: "EN" });
      const ja = resolveCardPrinting({ ...complete, language: "JA" });
      expect(en.printing!.printingHash).not.toBe(ja.printing!.printingHash);
    });

    it("different card numbers within the same set hash differently", () => {
      const a = resolveCardPrinting({ ...complete, cardNumber: "4/102" });
      const b = resolveCardPrinting({ ...complete, cardNumber: "5/102" });
      expect(a.printing!.printingHash).not.toBe(b.printing!.printingHash);
    });

    it("different copyright years (reprints) hash differently", () => {
      const y1 = resolveCardPrinting({ ...complete, year: 1999 });
      const y2 = resolveCardPrinting({ ...complete, year: 2000 });
      expect(y1.printing!.printingHash).not.toBe(y2.printing!.printingHash);
    });
  });

  it("lowers confidence when a stamped variant has no stampType", () => {
    const result = resolveCardPrinting({ ...complete, variant: "stamped", stampType: undefined });
    expect(result.ok).toBe(true);
    expect(result.confidence).toBeLessThan(1);
    expect(result.notes.length).toBeGreaterThan(0);
  });

  it("flags an implausible 1st Edition + modern year combination", () => {
    const result = resolveCardPrinting({ ...complete, edition: "1st", year: 2020 });
    expect(result.confidence).toBeLessThan(0.8);
  });
});

describe("isSamePrinting", () => {
  it("returns true only for identical printingHash", () => {
    const a = resolveCardPrinting(complete).printing!;
    const b = resolveCardPrinting({ ...complete }).printing!;
    const c = resolveCardPrinting({ ...complete, edition: "unlimited" }).printing!;
    expect(isSamePrinting(a, b)).toBe(true);
    expect(isSamePrinting(a, c)).toBe(false);
  });
});
