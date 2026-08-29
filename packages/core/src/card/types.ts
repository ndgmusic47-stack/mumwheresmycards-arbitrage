export type Language = "EN" | "JA" | "FR" | "DE" | "IT" | "ES" | "PT" | "NL" | "KO" | "ZH" | "OTHER";

export type Edition = "1st" | "unlimited" | "na";

/** Visual/printing variant. Distinct variants must never be compared as equivalent. */
export type Variant = "normal" | "holo" | "reverse_holo" | "stamped" | "promo";

/**
 * Generic "print run" distinguisher for sets that had multiple physically
 * different printings of the same nominal card (the canonical example being
 * Base Set Shadowless vs Unlimited). Modeled as a free-ish tag rather than a
 * hardcoded enum of set-specific cases so future sets with their own split
 * printings don't require a schema change — but a fixed set of known values
 * is enforced for the ones we already know about.
 */
export type Finish = "shadowless" | "unlimited_shadow" | "1st_edition_stamp" | "na";

/**
 * Raw, possibly-incomplete identity fields as extracted from a market
 * provider match or parsed from an eBay listing title/description. Any
 * field left undefined is NOT defaulted by the resolver — an incomplete
 * identity must be flagged, never silently guessed.
 */
export interface RawCardIdentity {
  game?: "pokemon";
  name?: string;
  setName?: string;
  setCode?: string;
  cardNumber?: string;
  year?: number;
  language?: Language;
  edition?: Edition;
  variant?: Variant;
  finish?: Finish;
  rarity?: string;
  stampType?: string;
}

/** A fully resolved, exact printing. Every field is present and specific,
 *  EXCEPT `year`: PokeTrace's catalogue does not resolve a release year for
 *  every set (some sets carry `releaseDate: null` — see
 *  PokeTraceCatalogueProvider.ts), and this project never fabricates one.
 *  `year: null` means "unknown", not "not applicable" — it is still a
 *  genuine, addressable printing (identity, pricing, and grading never
 *  depend on year), just one whose print year we don't have data for. */
export interface CardPrinting {
  game: "pokemon";
  name: string;
  setName: string;
  setCode: string;
  cardNumber: string;
  year: number | null;
  language: Language;
  edition: Edition;
  variant: Variant;
  finish: Finish;
  rarity: string;
  stampType: string | null;
  /** Deterministic identity key. Two printings are the same iff this matches. */
  printingHash: string;
}

export interface ResolutionResult {
  ok: boolean;
  printing: CardPrinting | null;
  /** Populated when ok=false or when the match was confident but worth flagging. */
  missingFields: (keyof RawCardIdentity)[];
  /** 0..1 — how confident the resolver is that this identity is correct and complete. */
  confidence: number;
  notes: string[];
}
