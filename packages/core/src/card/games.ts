/**
 * THE GAME DIMENSION.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS, AND WHY IT DID NOT BEFORE.
 *
 * The `cards` table has carried a `game` column since migration 0001, and
 * `game` has always been the first field in the printing hash. The plumbing
 * was right from day one. What was wrong was the TYPE: `game` was declared
 * as the string literal `"pokemon"` — not a union with one member, a single
 * permitted value — and the one place cards are created hardcoded it. So
 * the schema could hold a second game and the compiler forbade one.
 *
 * The operator's goal is "across every card game worth grading". Against
 * that, the tool scanned exactly one game, and the thing standing in the
 * way was a type annotation.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ORDERING MISTAKE THIS FIXES.
 *
 * The roadmap put "expand to other games" last, behind measuring demand.
 * That ordering could never have completed. Demand is measured from auction
 * closes (see market/listingClose.ts); auction closes are only recorded for
 * listings the scanner fetches; the scanner searches cards in the
 * catalogue; the catalogue was Pokémon-only. So the One Piece evidence that
 * expansion was waiting on could not accrue until One Piece was scanned.
 * The dependency ran in a circle, and left alone it would have deferred the
 * goal indefinitely while looking like patience.
 *
 * Scanning a game is what STARTS its evidence. It cannot be the reward for
 * having it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT BEING IN THIS LIST DOES AND DOES NOT MEAN.
 *
 * Membership here means the tool can REPRESENT the game without corrupting
 * an identity or a price. It does NOT mean the game has a catalogue source,
 * graded prices, or a single card in the database. Those are separate
 * facts, declared per game below and checked at runtime, because a list of
 * supported games that silently implies coverage is how "we support six
 * games" comes to mean "we have no data for five of them".
 *
 * Nothing here qualifies an opportunity. A game with no graded ladder
 * produces no grade profile, and a card with no grade profile qualifies for
 * nothing — that behaviour is inherited, not re-implemented, and there is a
 * test asserting it stays that way.
 */

/**
 * Every game the tool can represent. ORDER IS NOT MEANINGFUL, but the
 * STRINGS ARE FROZEN: `game` is the first field in the printing hash (see
 * hash.ts), so renaming "pokemon" would re-hash the entire existing
 * catalogue and orphan every price, opportunity and passed-card decision
 * already keyed to it. Add members; never edit one.
 */
export const GAMES = ["pokemon", "onepiece", "magic", "lorcana", "yugioh", "riftbound"] as const;

export type Game = (typeof GAMES)[number];

/** The game every pre-existing row carries, and the default for any call site that predates the union. */
export const DEFAULT_GAME: Game = "pokemon";

export function isGame(value: unknown): value is Game {
  return typeof value === "string" && (GAMES as readonly string[]).includes(value);
}

/**
 * Every spelling a provider has been observed to use, or documents, for a
 * game we model — mapped onto our frozen id.
 *
 * THIS IS NORMALISATION, NOT GUESSING, and the distinction is the whole
 * reason the table is explicit rather than a fuzzy match. "one-piece-card-game"
 * and "onepiece" are the same game under two vendors' slug conventions;
 * resolving one to the other loses nothing. A fuzzy matcher that mapped an
 * unknown string to its nearest neighbour would be guessing, and would file
 * an unmodelled game under a real one.
 *
 * Keys are compared lowercased with separators stripped, so "Pokemon",
 * "pokemon", "POKÉMON" and "pokemon-japan" do not each need a row — but
 * anything genuinely different does.
 *
 * Note `pokemonjapan` maps to `pokemon` DELIBERATELY: language is a
 * separate identity field in this model (see CardPrinting.language), so a
 * Japanese card is a Pokémon printing with `language: "JA"`, not a
 * different game. Routing it to a second game id would split one card's
 * market in half.
 */
const GAME_ALIASES: Record<string, Game> = {
  pokemon: "pokemon",
  pokemontcg: "pokemon",
  pokemonjapan: "pokemon",
  pokmon: "pokemon",
  onepiece: "onepiece",
  onepiececardgame: "onepiece",
  onepiecetcg: "onepiece",
  magic: "magic",
  magicthegathering: "magic",
  mtg: "magic",
  lorcana: "lorcana",
  disneylorcana: "lorcana",
  yugioh: "yugioh",
  yugiohtcg: "yugioh",
  riftbound: "riftbound",
};

/** Lowercase and strip everything that is only ever a separator or an accent. */
function normaliseGameKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Widen an arbitrary string (a database column, a provider payload) to a
 * Game, or null.
 *
 * Deliberately NOT defaulting to pokemon: a row whose game we do not
 * recognise is a row we cannot price, and quietly calling it a Pokémon card
 * would put a One Piece price on a Pokémon ladder. Null is the honest
 * answer and every caller must handle it — the catalogue sync skips the
 * card, the resolver refuses the identity.
 */
export function parseGame(value: string | null | undefined): Game | null {
  if (typeof value !== "string") return null;
  if (isGame(value)) return value;
  return GAME_ALIASES[normaliseGameKey(value)] ?? null;
}

/**
 * Where a game's GRADED prices can come from, which is the only thing that
 * decides whether the tool can have an opinion about grading it.
 *
 * - `provider`: a market-data provider returns a slab ladder directly.
 * - `auction_closes`: no provider has slab prices, so the ladder must be
 *   built in-house from auctions that closed with bids (listingClose.ts).
 *   This is slow and starts empty.
 * - `none`: no route at all. The game can be catalogued and searched, and
 *   it will qualify nothing until this changes.
 */
export type GradedPriceRoute = "provider" | "auction_closes" | "none";

export interface GameProfile {
  id: Game;
  /** For display and for operator-facing text. Never used in a hash or a query key. */
  displayName: string;
  /**
   * Words appended to an eBay keyword search to stop a card name from
   * matching a different game's card, a video game, or a plush toy.
   *
   * EMPTY FOR POKÉMON, DELIBERATELY. Pokémon searches are `name set_name
   * card_number` today and that string is working — it is what the live
   * feed, every stored listing and every reconciliation test is built on.
   * Appending "pokemon" to it would change the result set for the one game
   * that currently works, to fix a collision problem it does not have. New
   * games get a disambiguator because their names genuinely do collide
   * ("Ace", "Law", "Shanks" are not distinctive strings on eBay); Pokémon
   * keeps exactly what it has. There is a test pinning that string.
   */
  ebayKeywordSuffix: string;
  /**
   * eBay category to restrict searches to, or null for none.
   *
   * NULL FOR EVERY GAME RIGHT NOW, and that is a statement of ignorance,
   * not a default. Category IDs differ per eBay marketplace and none has
   * been verified against the live UK site. Writing a plausible-looking ID
   * here would silently filter the search down to whatever that number
   * actually means — possibly nothing. The keyword suffix does the
   * disambiguation until an ID is checked against a real response.
   */
  ebayCategoryId: string | null;
  gradedPriceRoute: GradedPriceRoute;
  /**
   * Why the route is what it is, in one sentence, so an operator reading
   * "this game qualifies nothing" gets a reason instead of a blank.
   */
  gradedPriceNote: string;
}

/**
 * PSA grades every game in this list; that is not the constraint. The
 * constraint is whether anyone will SELL us the resulting slab prices.
 */
const PROFILES: Record<Game, GameProfile> = {
  pokemon: {
    id: "pokemon",
    displayName: "Pokémon",
    ebayKeywordSuffix: "",
    ebayCategoryId: null,
    gradedPriceRoute: "provider",
    gradedPriceNote: "PokeTrace returns PSA 1-10 plus other graders, with per-tier sale counts.",
  },
  onepiece: {
    id: "onepiece",
    displayName: "One Piece",
    ebayKeywordSuffix: "one piece card",
    ebayCategoryId: null,
    gradedPriceRoute: "provider",
    gradedPriceNote:
      "JustTCG v2 exposes PSA/BGS/CGC as priced variants. Whether its graded coverage reaches One Piece specifically is UNVERIFIED against a live call — the adapter reports the grades it actually received and never fills a rung it did not see.",
  },
  magic: {
    id: "magic",
    displayName: "Magic: The Gathering",
    ebayKeywordSuffix: "mtg magic card",
    ebayCategoryId: null,
    gradedPriceRoute: "provider",
    gradedPriceNote: "JustTCG v2 graded variants, same unverified caveat as One Piece.",
  },
  lorcana: {
    id: "lorcana",
    displayName: "Disney Lorcana",
    ebayKeywordSuffix: "lorcana card",
    ebayCategoryId: null,
    gradedPriceRoute: "provider",
    gradedPriceNote: "JustTCG v2 graded variants, same unverified caveat as One Piece.",
  },
  yugioh: {
    id: "yugioh",
    displayName: "Yu-Gi-Oh!",
    ebayKeywordSuffix: "yugioh card",
    ebayCategoryId: null,
    gradedPriceRoute: "provider",
    gradedPriceNote: "JustTCG v2 graded variants, same unverified caveat as One Piece.",
  },
  riftbound: {
    id: "riftbound",
    displayName: "Riftbound",
    ebayKeywordSuffix: "riftbound card",
    ebayCategoryId: null,
    gradedPriceRoute: "auction_closes",
    gradedPriceNote:
      "Too new for a graded market worth querying. Any ladder has to be built from auctions that close with bids, which starts empty and accrues slowly.",
  },
};

export function gameProfile(game: Game): GameProfile {
  return PROFILES[game];
}

/**
 * The eBay keyword string for a card. The single place this is built, so a
 * game's disambiguator cannot be applied on one code path and forgotten on
 * another.
 *
 * Whitespace is collapsed and the result trimmed, so a game with an empty
 * suffix produces EXACTLY the string the scanner produced before this file
 * existed — byte for byte, not merely equivalent.
 */
export function buildSearchKeywords(
  game: Game,
  parts: { name: string; setName: string; cardNumber: string },
): string {
  const suffix = gameProfile(game).ebayKeywordSuffix;
  return [parts.name, parts.setName, parts.cardNumber, suffix].join(" ").replace(/\s+/g, " ").trim();
}
