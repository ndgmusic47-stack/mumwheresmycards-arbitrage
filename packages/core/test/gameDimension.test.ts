import { describe, it, expect } from "vitest";
import { GAMES, DEFAULT_GAME, isGame, parseGame, gameProfile, buildSearchKeywords } from "../src/card/games.js";
import { hashPrinting } from "../src/card/hash.js";
import { resolveCardPrinting } from "../src/card/resolver.js";
import type { CardPrinting, RawCardIdentity } from "../src/card/types.js";

/**
 * THE GAME DIMENSION — 2026-09-19.
 *
 * The end goal is "across every card game worth grading". The tool scanned
 * one. The schema had carried a `game` column since migration 0001 and the
 * hash had always included it; what made the tool single-game was a TYPE —
 * `game` declared as the literal `"pokemon"` — plus two hardcodes, one in
 * the catalogue sync and one in the scanner's row-to-identity conversion.
 *
 * These tests are mostly not about the new game. They are about the old
 * one: the overwhelming risk in widening a key field is that the working
 * business quietly changes underneath it.
 */

const CHARIZARD: Omit<CardPrinting, "printingHash"> = {
  game: "pokemon",
  name: "Charizard",
  setName: "Base Set",
  setCode: "BS",
  cardNumber: "4/102",
  year: 1999,
  language: "EN",
  edition: "1st",
  variant: "holo",
  finish: "na",
  rarity: "Holo Rare",
  stampType: null,
};

/**
 * THE LOAD-BEARING TEST IN THIS FILE.
 *
 * `game` is the FIRST field in the printing hash, and the hash is the
 * primary key of `cards` — every price, profile, opportunity, external
 * provider ref and passed-card decision is keyed to it. If widening the
 * type had changed the value written for a Pokémon card by so much as one
 * character, the entire existing catalogue would re-hash on the next sync:
 * 76,000 new rows, every stored price orphaned, every card the operator
 * ever passed on reappearing as new.
 *
 * It does not change, because the STRING is unchanged — "pokemon" is
 * "pokemon" whether its type is a literal or a union member. These are the
 * literal values, pinned, so that a future edit to GAMES (renaming a member,
 * reordering the hash fields) fails here loudly instead of in production
 * silently.
 */
describe("existing Pokémon identities must hash exactly as they did before the game type was widened", () => {
  it("pins the hash of a 1st Edition holo", () => {
    expect(hashPrinting(CHARIZARD)).toBe("pc_f768ff6a");
  });

  it("pins the hash of the unlimited normal printing of the same card", () => {
    expect(hashPrinting({ ...CHARIZARD, edition: "unlimited", variant: "normal" })).toBe("pc_bb741ecc");
  });

  it("pins the hash of a printing whose year is unknown", () => {
    expect(hashPrinting({ ...CHARIZARD, year: null })).toBe("pc_c87b4ccb");
  });

  it("keeps 'pokemon' in the frozen game list, since the string itself is the key material", () => {
    expect(GAMES).toContain("pokemon");
    expect(DEFAULT_GAME).toBe("pokemon");
  });
});

/**
 * The reason the hash includes `game` at all. Two games can absolutely have
 * a card of the same name in a set of the same code — and if they collided
 * on one row, one game's sold prices would be valuing the other game's card.
 * That is the identity collapse this project has already spent days on,
 * and it would arrive on day one of a second game.
 */
describe("two games can never collide on one row", () => {
  it("hashes the same card fields differently per game", () => {
    const onepiece: Omit<CardPrinting, "printingHash"> = {
      game: "onepiece",
      name: "Monkey D. Luffy",
      setName: "Romance Dawn",
      setCode: "OP-01",
      cardNumber: "OP01-001",
      year: 2022,
      language: "EN",
      edition: "na",
      variant: "holo",
      finish: "na",
      rarity: "Leader",
      stampType: null,
    };

    expect(hashPrinting(onepiece)).toBe("pc_52abcf03");
    expect(hashPrinting({ ...onepiece, game: "pokemon" })).toBe("pc_41ae09ee");
    expect(hashPrinting(onepiece)).not.toBe(hashPrinting({ ...onepiece, game: "pokemon" }));
  });
});

/**
 * THE SEARCH STRING FOR POKÉMON MUST NOT MOVE.
 *
 * Adding a game disambiguator to eBay keywords is obviously right for a new
 * game whose card names are words like "Ace" and "Law". It is NOT obviously
 * right for the game that already works: the live feed, every stored
 * listing and every reconciliation test sit on top of the current string,
 * and narrowing the query would change what the operator sees for reasons
 * that have nothing to do with a new game.
 *
 * So Pokémon's suffix is empty and this test pins the exact output —
 * character for character, not merely "equivalent".
 */
describe("the eBay keyword string", () => {
  it("is byte-identical to the pre-change string for Pokémon", () => {
    const built = buildSearchKeywords("pokemon", { name: "Charizard", setName: "Base Set", cardNumber: "4/102" });

    // This is literally the template the scanner used before games existed:
    // `${cardRow.name} ${cardRow.set_name} ${cardRow.card_number}`
    expect(built).toBe("Charizard Base Set 4/102");
  });

  it("adds a disambiguator for a game whose card names are ordinary words", () => {
    const built = buildSearchKeywords("onepiece", { name: "Ace", setName: "Romance Dawn", cardNumber: "OP01-001" });

    expect(built).toBe("Ace Romance Dawn OP01-001 one piece card");
  });

  it("never leaves doubled or trailing whitespace, whatever the suffix", () => {
    for (const game of GAMES) {
      const built = buildSearchKeywords(game, { name: "A", setName: "B", cardNumber: "C" });
      expect(built).toBe(built.trim());
      expect(built).not.toMatch(/\s{2,}/);
    }
  });
});

/**
 * Every game must answer for itself whether it can be priced. A list of
 * supported games that implies coverage it does not have is how "we support
 * six games" comes to mean "we have no data for five of them".
 */
describe("every game declares how it would get graded prices", () => {
  it("has a profile with a stated route and a reason", () => {
    for (const game of GAMES) {
      const profile = gameProfile(game);
      expect(profile.id).toBe(game);
      expect(["provider", "auction_closes", "none"]).toContain(profile.gradedPriceRoute);
      expect(profile.gradedPriceNote.length).toBeGreaterThan(20);
    }
  });

  it("claims no verified eBay category for any game, rather than a plausible-looking one", () => {
    // Category IDs differ per marketplace and none has been checked against
    // a live UK response. A guessed ID silently filters a search down to
    // whatever that number really means, which may be nothing.
    for (const game of GAMES) {
      expect(gameProfile(game).ebayCategoryId).toBeNull();
    }
  });
});

describe("parsing a game from untyped input", () => {
  it("accepts our own ids", () => {
    for (const game of GAMES) expect(parseGame(game)).toBe(game);
  });

  it("normalises the spellings providers actually use", () => {
    expect(parseGame("Pokemon")).toBe("pokemon");
    expect(parseGame("POKÉMON")).toBe("pokemon");
    expect(parseGame("one-piece-card-game")).toBe("onepiece");
    expect(parseGame("Magic: The Gathering")).toBe("magic");
    expect(parseGame("disney-lorcana")).toBe("lorcana");
  });

  /**
   * Japanese Pokémon is Pokémon. Language is a separate identity field in
   * this model, so routing it to a second game id would split one card's
   * market in half — and the halves would never see each other's prices.
   */
  it("keeps Japanese Pokémon as Pokémon, because language is its own field", () => {
    expect(parseGame("pokemon-japan")).toBe("pokemon");
  });

  /**
   * THE LINE THAT MUST NOT MOVE. Defaulting an unknown game to Pokémon is
   * exactly how a One Piece price ends up on a Pokémon ladder — the single
   * failure this whole change exists to prevent.
   */
  it("returns null for anything unrecognised, and never falls back to a default", () => {
    for (const bad of ["digimon", "", "  ", "poke", null, undefined, 42, {}]) {
      expect(parseGame(bad as never)).toBeNull();
    }
  });

  it("agrees with isGame on our own ids", () => {
    expect(isGame("pokemon")).toBe(true);
    expect(isGame("digimon")).toBe(false);
    // An alias is parseable but is NOT one of our ids — the distinction
    // matters, because only the id is safe to write into the hash.
    expect(isGame("one-piece-card-game")).toBe(false);
  });
});

describe("the resolver refuses an identity whose game it does not recognise", () => {
  function identity(over: Partial<RawCardIdentity> = {}): RawCardIdentity {
    return {
      game: "pokemon",
      name: "Charizard",
      setName: "Base Set",
      setCode: "BS",
      cardNumber: "4/102",
      year: 1999,
      language: "EN",
      edition: "1st",
      variant: "holo",
      finish: "na",
      ...over,
    };
  }

  it("resolves a known game", () => {
    const result = resolveCardPrinting(identity());
    expect(result.ok).toBe(true);
    expect(result.printing!.game).toBe("pokemon");
  });

  it("carries the game through instead of stamping every card as Pokémon", () => {
    const result = resolveCardPrinting(identity({ game: "onepiece", name: "Ace" }));
    expect(result.ok).toBe(true);
    expect(result.printing!.game).toBe("onepiece");
  });

  it("fails rather than defaulting when the game is unrecognised at runtime", () => {
    // The type says Game; the data comes from eBay title parsing and D1
    // rows, neither of which the compiler checks.
    const result = resolveCardPrinting(identity({ game: "digimon" as never }));

    expect(result.ok).toBe(false);
    expect(result.printing).toBeNull();
    expect(result.missingFields).toContain("game");
    expect(result.notes.join(" ")).toMatch(/digimon/);
  });

  it("fails when the game is missing entirely", () => {
    const result = resolveCardPrinting(identity({ game: undefined }));
    expect(result.ok).toBe(false);
    expect(result.missingFields).toContain("game");
  });
});
