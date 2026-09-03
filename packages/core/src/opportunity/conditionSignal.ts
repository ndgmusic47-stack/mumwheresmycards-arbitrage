export type ConditionSignalTier = "DAMAGED" | "HEAVILY_PLAYED" | "MODERATELY_PLAYED" | "LIGHTLY_PLAYED" | "NEAR_MINT";

export interface ConditionSignal {
  tier: ConditionSignalTier | null;
  /** The exact substring that matched, for showing the user what triggered
   *  the detection rather than asking them to trust a black box. */
  matchedText: string | null;
}

/**
 * SOURCING WORKFLOW item 8 (condition truth layer): looks for an EXPLICIT
 * raw-card condition claim in an eBay listing's title, using ONLY full
 * spelled-out phrases ("Heavily Played", "Near Mint") — deliberately NEVER
 * bare abbreviations like "HP" / "LP" / "NM" / "MP", however standard those
 * abbreviations are on other TCG marketplaces. On Pokémon cards specifically
 * "HP" is also the card's own printed stat (e.g. "Charizard 150HP", "Base
 * Set Blastoise 100 HP") — a bare-abbreviation match would be an
 * unacceptably noisy false-positive source on exactly the game this tool
 * is built for. This mirrors the scan pipeline's own "corroborate
 * confidently or don't guess" discipline (STABILISATION item 5's
 * titleParser.ts, applied there to card identity) — applied here to
 * condition instead.
 *
 * A null tier means "no explicit condition claim found in the title" —
 * NEVER "confirmed near mint." Most sellers simply don't mention condition
 * in the title at all; silence is not itself a claim, and this function
 * never manufactures one.
 */
const CONDITION_SIGNAL_PATTERNS: { tier: ConditionSignalTier; patterns: RegExp[] }[] = [
  { tier: "DAMAGED", patterns: [/\bdamaged\b/i] },
  { tier: "HEAVILY_PLAYED", patterns: [/\bheavily[\s-]?played\b/i] },
  { tier: "MODERATELY_PLAYED", patterns: [/\bmoderately[\s-]?played\b/i] },
  { tier: "LIGHTLY_PLAYED", patterns: [/\blightly[\s-]?played\b/i] },
  { tier: "NEAR_MINT", patterns: [/\bnear[\s-]?mint\b/i] },
];

export function detectListingConditionSignal(title: string | null | undefined): ConditionSignal {
  if (!title) return { tier: null, matchedText: null };
  for (const { tier, patterns } of CONDITION_SIGNAL_PATTERNS) {
    for (const pattern of patterns) {
      const match = title.match(pattern);
      if (match) return { tier, matchedText: match[0] };
    }
  }
  return { tier: null, matchedText: null };
}
