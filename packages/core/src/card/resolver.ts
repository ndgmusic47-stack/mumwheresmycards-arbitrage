import type { CardPrinting, RawCardIdentity, ResolutionResult } from "./types.js";
import { hashPrinting } from "./hash.js";

/**
 * Fields required to consider a card identity fully resolved to an exact
 * printing. `rarity` and `stampType` are intentionally excluded from the
 * "required" set: rarity is descriptive (doesn't distinguish printings by
 * itself) and stampType only applies to a subset of variants.
 */
const REQUIRED_FIELDS: (keyof RawCardIdentity)[] = [
  "game",
  "name",
  "setName",
  "setCode",
  "cardNumber",
  "year",
  "language",
  "edition",
  "variant",
  "finish",
];

/**
 * Resolve a raw, possibly-incomplete identity into an exact CardPrinting.
 *
 * This function NEVER fills in a default for a missing/ambiguous field.
 * If any required field is missing, resolution fails outright (ok=false)
 * so the caller can route the listing to
 * `REJECTED — CARD IDENTITY UNCERTAIN` rather than silently merging it
 * with a different printing.
 */
export function resolveCardPrinting(raw: RawCardIdentity): ResolutionResult {
  const missingFields = REQUIRED_FIELDS.filter((f) => raw[f] === undefined || raw[f] === null || raw[f] === "");

  if (missingFields.length > 0) {
    return {
      ok: false,
      printing: null,
      missingFields,
      confidence: 0,
      notes: [`Missing required identity field(s): ${missingFields.join(", ")}`],
    };
  }

  const notes: string[] = [];

  // Cross-field sanity checks that catch common mis-parses without ever
  // *guessing* a corrected value — an inconsistency is a reason to lower
  // confidence and flag for photo inspection, not to auto-correct.
  let confidence = 1;

  if (raw.variant === "stamped" && !raw.stampType) {
    confidence -= 0.15;
    notes.push("Variant is 'stamped' but no stampType provided — verify from photos.");
  }

  if (raw.finish !== "na" && raw.edition === "na") {
    confidence -= 0.1;
    notes.push("Finish implies a specific print run but edition is 'na' — double-check 1st/Unlimited.");
  }

  if (raw.edition === "1st" && raw.year !== undefined && raw.year > 2003) {
    // 1st Edition print convention effectively ended (WotC era); a later
    // year paired with '1st' is very likely a mis-parse (e.g. a reprint
    // promo mislabeled), not a real distinct printing we should trust blind.
    confidence -= 0.25;
    notes.push("'1st Edition' combined with a modern year is unusual — verify card identity from photos.");
  }

  const printing: CardPrinting = {
    game: "pokemon",
    name: raw.name!,
    setName: raw.setName!,
    setCode: raw.setCode!,
    cardNumber: raw.cardNumber!,
    year: raw.year!,
    language: raw.language!,
    edition: raw.edition!,
    variant: raw.variant!,
    finish: raw.finish!,
    rarity: raw.rarity ?? "unknown",
    stampType: raw.stampType ?? null,
    printingHash: "", // filled below
  };

  printing.printingHash = hashPrinting(printing);

  return {
    ok: true,
    printing,
    missingFields: [],
    confidence: Math.max(0, Math.min(1, confidence)),
    notes,
  };
}

/**
 * Strict equality between two printings — by identity hash only. Never
 * compare CardPrinting objects field-by-field elsewhere in the codebase;
 * always go through this (or compare printingHash directly) so a future
 * field addition can't silently change equality semantics in one call site
 * but not another.
 */
export function isSamePrinting(a: CardPrinting, b: CardPrinting): boolean {
  return a.printingHash === b.printingHash;
}
