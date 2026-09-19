import { describe, it, expect } from "vitest";
import type { CardRow } from "@mwmc/db";
import { resolveCardPrinting } from "@mwmc/core";
import { rowToIdentity } from "../src/scan/scanRunner.js";
import { reconcileIdentityWithTitle } from "../src/scan/titleParser.js";

/**
 * WHY A HAND-ADDED LEAD MUST NOT GO THROUGH TITLE RECONCILIATION.
 *
 * Adding a lead by hand shipped on 2026-09-14 running the catalogue identity
 * through reconcileIdentityWithTitle, so it would follow the scanner's path
 * exactly. First real use came back:
 *
 *   API /leads failed: 409 ... FLIP: skipped_identity_uncertain;
 *                              GRADE: skipped_identity_uncertain
 *
 * Reconciliation answers a different question from the one being asked. It
 * exists because eBay's search is full text and returns other cards, so it
 * corroborates-or-DROPS a searched-for identity against the title — and a
 * dropped required field is SUPPOSED to end in identity-uncertain. Correct
 * for a guess. Wrong for an identity a person asserted while looking at the
 * listing.
 *
 * Both halves are pinned here: the assertion resolves, and reconciliation
 * would have destroyed it.
 */
function cardRow(over: Partial<CardRow>): CardRow {
  return {
    id: "pc_test",
    game: "pokemon",
    name: "Pikachu EX - XY124",
    set_name: "XY Promos",
    set_code: "xy-promos",
    card_number: "XY124",
    year: null,
    language: "EN",
    edition: "na",
    variant: "holo",
    finish: "na",
    rarity: "Promo",
    stamp_type: null,
    printing_hash: "pc_test",
    notes: null,
    created_at: "2026-09-04 01:01:02",
    updated_at: "2026-09-12 00:35:38",
    last_ebay_scanned_at: null,
    ...over,
  } as CardRow;
}

describe("an identity the operator asserted resolves cleanly", () => {
  it("resolves a real catalogue row at full confidence", () => {
    // pc_31de716a as it actually sits in production, year included (null).
    const result = resolveCardPrinting(rowToIdentity(cardRow({})));

    expect(result.ok).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.missingFields).toEqual([]);
    // The hash is derived from these very fields, so it must come back as
    // the card's own id — otherwise the opportunity would attach to a
    // different printing than the one the operator picked.
    expect(result.printing?.printingHash).toBe("pc_31de716a");
  });

  it("resolves even with a missing release year, which most promos have", () => {
    expect(resolveCardPrinting(rowToIdentity(cardRow({ year: null }))).ok).toBe(true);
  });
});

describe("what reconciliation would have done to it", () => {
  /**
   * The specific shape that broke it: catalogue names carry parenthetical
   * qualifiers, and sellers write the number differently. "142 Full Art"
   * against a title saying "142/146 Full Art" fails the name-substring
   * test — so `name` is dropped, and `name` is required.
   */
  it("destroys a correctly identified card whose title spells the number differently", () => {
    const row = cardRow({ name: "Blastoise EX (142 Full Art)", card_number: "142/146", set_name: "XY Base Set" });
    const title = "Blastoise EX 142/146 Full Art XY Base Set Pokemon";

    const asserted = resolveCardPrinting(rowToIdentity(row));
    expect(asserted.ok).toBe(true);

    const reconciled = resolveCardPrinting(reconcileIdentityWithTitle(rowToIdentity(row), title));
    expect(reconciled.ok).toBe(false);
    expect(reconciled.missingFields).toContain("name");
  });

  /**
   * Reconciliation is still RIGHT where it belongs — this is not a bug in it,
   * and nothing here should be read as a reason to loosen it. A search that
   * returns a genuinely different card must still be caught.
   */
  it("still catches a listing for a different card on the scanner's path", () => {
    const row = cardRow({});
    const wrongCard = "Charizard VMAX Rainbow Rare 074/073 Champions Path";

    const reconciled = reconcileIdentityWithTitle(rowToIdentity(row), wrongCard);
    expect(reconciled.name).toBeUndefined();
    expect(resolveCardPrinting(reconciled).ok).toBe(false);
  });
});
