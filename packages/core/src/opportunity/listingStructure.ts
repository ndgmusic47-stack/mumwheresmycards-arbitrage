/**
 * AI INTELLIGENCE spec, item 6: deterministic listing-structure
 * classification (SINGLE / LOT / GRADED / UNKNOWN).
 *
 * Phase 1 (this file) is deterministic-only, per spec section 5's own
 * instruction: "If eBay explicitly says Graded: do not spend AI tokens
 * deciding whether it is graded." This module only routes out the cases
 * that are confidently, explicitly true from a fact eBay already gives us —
 * it deliberately does NOT try to resolve genuine ambiguity (a title with
 * no lot language and no structured condition flag stays SINGLE, not
 * confirmed, exactly as the existing condition-truth panel already treats
 * "no signal found" as an absence of a red flag, never a confirmation).
 * Real ambiguity resolution (ML image review of a lot photo, a slab visible
 * only in a photo, etc.) is explicitly Phase 2 (Terra deep review) — see
 * the project doc's AI INTELLIGENCE phasing note.
 *
 * A listing this module marks GRADED or LOT with high confidence gets
 * routed by the engine to REVIEW_ALREADY_GRADED / REVIEW_LIKELY_LOT
 * instead of QUALIFIED_FLIP/QUALIFIED_GRADE — see engine.ts. It is never
 * silently dropped.
 */

export type ListingStructure = "SINGLE" | "LOT" | "GRADED" | "UNKNOWN";

export type ListingStructureSource = "EBAY_STRUCTURED_CONDITION" | "TITLE_PATTERN" | "NONE";

export interface ListingStructureAssessment {
  structure: ListingStructure;
  /** 0-1. Deterministic phase only ever emits 0 (no signal), a mid value
   *  for a weaker title-only signal, or 1 for an explicit structured fact. */
  confidence: number;
  evidence: string[];
  source: ListingStructureSource;
}

/** eBay's own structured `item_condition` value for a graded slab. Case-
 *  insensitive exact-ish match — this is the PRIMARY, high-trust signal. */
const GRADED_CONDITION_VALUES = ["graded"];

/** Grading-company + numeric-grade pattern in the title — a WEAKER,
 *  title-only signal (a raw listing's marketing copy can legitimately say
 *  "compares to a PSA 9" without being graded itself), so this alone never
 *  reaches the confidence bar the engine uses to override state. It is
 *  still surfaced as evidence for a human (or, later, Terra) to weigh. */
const GRADED_TITLE_PATTERN = /\b(PSA|BGS|CGC|SGC|ACE|TAG)\s*-?\s*(10|9(\.5)?|8(\.5)?|7(\.5)?|6(\.5)?|5(\.5)?|4|3|2|1)\b/i;

/** Explicit lot/bundle language in the title. Deliberately requires the
 *  seller to have actually said this, mirroring conditionSignal.ts's own
 *  "corroborate confidently or don't guess" discipline — a listing that
 *  merely mentions a card by name inside an unrelated bundle title still
 *  needs this to fire on the LOT wording itself, not on any other cue. */
const LOT_TITLE_PATTERNS: RegExp[] = [
  /\blot\s+of\s+\d+/i,
  /\bjob\s*lot\b/i,
  /\bbundle\s+of\s+\d+/i,
  /\bcollection\s+of\s+\d+/i,
  /\bwholesale\s+lot\b/i,
  /\bbulk\s+lot\b/i,
  /\bx\s?\d{2,}\s*(cards?|pokemon|pokémon)\b/i,
  /\b\d{2,}\s*(cards?)\s+(lot|bundle|collection|joblot)\b/i,
];

export interface ListingStructureInput {
  title: string;
  /** eBay's own structured condition string, e.g. "Graded", "Ungraded",
   *  "Used" — the same field already captured as `itemCondition` on
   *  ListingCandidate. */
  itemCondition?: string | null;
}

/** Confidence at/above which the engine treats a GRADED/LOT read as
 *  confident enough to override an otherwise-qualifying state. Below this,
 *  the structure is still recorded and shown, but nothing is overridden —
 *  Phase 1 stays conservative rather than mass-rerouting ambiguous cases. */
export const STRUCTURE_OVERRIDE_CONFIDENCE = 0.85;

export function classifyListingStructure(input: ListingStructureInput): ListingStructureAssessment {
  const title = input.title ?? "";
  const condition = (input.itemCondition ?? "").trim().toLowerCase();

  if (condition && GRADED_CONDITION_VALUES.includes(condition)) {
    return {
      structure: "GRADED",
      confidence: 1,
      evidence: [`eBay's structured condition is "${input.itemCondition}".`],
      source: "EBAY_STRUCTURED_CONDITION",
    };
  }

  for (const pattern of LOT_TITLE_PATTERNS) {
    const match = title.match(pattern);
    if (match) {
      return {
        structure: "LOT",
        confidence: 0.9,
        evidence: [`Listing title matches lot/bundle language: "${match[0]}".`],
        source: "TITLE_PATTERN",
      };
    }
  }

  const gradedTitleMatch = title.match(GRADED_TITLE_PATTERN);
  if (gradedTitleMatch) {
    return {
      structure: "GRADED",
      // Deliberately below STRUCTURE_OVERRIDE_CONFIDENCE — see
      // GRADED_TITLE_PATTERN's comment. Recorded, not acted on, in Phase 1.
      confidence: 0.6,
      evidence: [
        `Title mentions a grading company and numeric grade ("${gradedTitleMatch[0]}") but eBay's own structured condition does not confirm "Graded" — could be marketing copy on a raw listing (e.g. "compares to a PSA 9"). Not acted on automatically; flagged for review.`,
      ],
      source: "TITLE_PATTERN",
    };
  }

  if (!title.trim()) {
    return {
      structure: "UNKNOWN",
      confidence: 0,
      evidence: ["Listing has no title text to classify."],
      source: "NONE",
    };
  }

  return {
    structure: "SINGLE",
    confidence: 0,
    evidence: [
      "No lot/bundle language and no graded-condition signal found — treated as a single raw card by default, not confirmed. Most single-card listings don't say so explicitly in the title.",
    ],
    source: "NONE",
  };
}
