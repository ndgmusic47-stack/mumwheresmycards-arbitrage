/**
 * EBAY'S OWN CONDITION FIELD, IN EVERY LANGUAGE IT ARRIVES IN.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE LEAK THIS CLOSES. Found 2026-09-13 by grouping the live table:
 *
 *   Graded        5851      Ungraded       44477
 *   Valutata        88  IT  Non gradata      391  IT
 *   Bewertet        61  DE  Nicht bewertet   165  DE
 *   Gradée           6  FR  Non gradée        73  FR
 *   Gradé            1  FR  Non gradé         20  FR
 *
 * eBay returns `condition` in the SELLER'S locale, not the buyer's. The
 * already-graded classifier matched the single literal "graded", so 156
 * listings that eBay itself marks as graded slabs were being evaluated as
 * raw cards to send off for grading — priced on raw economics, offered as
 * opportunities. That is the same class of error as buying a card that is
 * not the card in the photo: the arithmetic is fine and the subject is
 * wrong.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY EXACT MATCHING, NOT SUBSTRINGS. "Non gradée" contains "gradée".
 * Anything doing a substring test for a graded marker classifies every
 * FRENCH UNGRADED card as a slab — the exact inversion of the bug, and a far
 * more expensive one, because it would hide real buys rather than surface
 * fake ones. Values are compared whole, after normalising case, whitespace
 * and accents, and the negative forms are listed explicitly so none of them
 * can fall through to a partial match.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A CLOSED LIST AND NOT A HEURISTIC. Every value here was read out of
 * the production database, not guessed from a locale table. A value this
 * module has never seen returns OTHER, which is honest: the tool does not
 * know whether it is a slab, and the caller must decide what to do about not
 * knowing rather than be handed a confident wrong answer. When a new locale
 * shows up, it shows up as OTHER and gets added here — a visible gap beats
 * an invisible misclassification.
 */

export type EbayConditionClass = "GRADED" | "UNGRADED" | "OTHER" | "UNKNOWN";

/** Lowercased, trimmed, accent-stripped, inner whitespace collapsed. */
export function normaliseConditionValue(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed
    .toLowerCase()
    .normalize("NFD")
    // Strip combining accents so "gradée" and "gradee" cannot diverge.
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * eBay says: this is a graded slab. Raw-card economics do not apply.
 * Normalised forms — see normaliseConditionValue.
 */
export const GRADED_CONDITION_VALUES: readonly string[] = [
  "graded", // EN
  "valutata", // IT
  "bewertet", // DE
  "gradee", // FR, feminine ("Gradée")
  "grade", // FR, masculine ("Gradé") — safe as an EXACT match only
];

/**
 * eBay says: this is a raw, ungraded card. The thing this tool buys.
 *
 * The negatives are listed in full and deliberately. "non gradee" must
 * resolve to UNGRADED on its own terms, never by failing to match something
 * else.
 */
export const UNGRADED_CONDITION_VALUES: readonly string[] = [
  "ungraded", // EN
  "non gradata", // IT
  "nicht bewertet", // DE
  "non gradee", // FR, feminine
  "non grade", // FR, masculine
];

/**
 * Classify eBay's condition string.
 *
 * UNKNOWN = eBay sent nothing. OTHER = eBay sent something this module does
 * not recognise as a graded/ungraded marker — "Used", "Gebraucht", "New",
 * "Unspecified", or a locale not yet seen. Neither is treated as ungraded:
 * "we were not told" and "we were told it is raw" are different facts and
 * the tool has to be able to say which one it has.
 */
export function classifyEbayCondition(raw: string | null | undefined): EbayConditionClass {
  const value = normaliseConditionValue(raw);
  if (value === null) return "UNKNOWN";
  if (GRADED_CONDITION_VALUES.includes(value)) return "GRADED";
  if (UNGRADED_CONDITION_VALUES.includes(value)) return "UNGRADED";
  return "OTHER";
}

/**
 * The RAW database values a semantic filter should match, so a query for
 * "ungraded" finds the Italian and German ones too.
 *
 * Returned in eBay's own casing rather than normalised, because this feeds a
 * SQL `IN (...)` against the stored column. The list is generated from the
 * canonical spellings below rather than by un-normalising, so what goes into
 * the query is exactly what eBay wrote.
 */
const RAW_SPELLINGS: Record<"GRADED" | "UNGRADED", readonly string[]> = {
  GRADED: ["Graded", "Valutata", "Bewertet", "Gradée", "Gradé"],
  UNGRADED: ["Ungraded", "Non gradata", "Nicht bewertet", "Non gradée", "Non gradé"],
};

export function rawConditionSpellingsFor(cls: "GRADED" | "UNGRADED"): readonly string[] {
  return RAW_SPELLINGS[cls];
}
