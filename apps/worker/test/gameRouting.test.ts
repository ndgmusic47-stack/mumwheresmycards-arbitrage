import { describe, it, expect } from "vitest";
import type { Db, CardRow } from "@mwmc/db";
import type { MarketDataProvider, MarketSnapshotCache, MarketSnapshotResult } from "@mwmc/providers";
import { runMarketProfiling } from "../src/scan/marketProfiling.js";
import { loadSettings } from "../src/repo/settingsRepo.js";
import { createGameProviderSet, singleGameProviderSet, describeGameCoverage } from "../src/scan/gameProviders.js";
import { parseJustTcgGames } from "../src/scan/providerSetup.js";

/**
 * WHICH PROVIDER PRICES WHICH CARD — 2026-09-19.
 *
 * Every provider in this worker was built from ONE environment variable,
 * `MARKET_PROVIDER`, used for both the catalogue and the market data. One
 * variable, one provider, one game — which meant pointing the tool at a
 * second game meant pointing it away from the first.
 *
 * These tests are about the failure mode that replaces it. Asking PokéTrace
 * about a One Piece card does not fail loudly: it returns nothing, or
 * worse, a similarly-named Pokémon card whose prices then become that
 * card's economics. So the rule under test is that a card is only ever
 * priced by a provider configured for ITS game, and that "nobody can price
 * this" is a recorded outcome rather than a fallback.
 */

function cardRow(id: string, game: string): CardRow {
  return {
    id,
    game,
    name: `Card ${id}`,
    set_name: "Base Set",
    set_code: "BS",
    card_number: "4/102",
    year: 1999,
    language: "EN",
    edition: "na",
    variant: "normal",
    finish: "na",
    rarity: null,
    stamp_type: null,
    last_ebay_scanned_at: null,
  } as unknown as CardRow;
}

function fakeDb(cardsDue: CardRow[], refs: Record<string, string>) {
  const execs: { sql: string; params: unknown[] }[] = [];
  const refLookups: { provider: string; cardId: string }[] = [];
  const db = {
    exec: async (sql: string, ...params: unknown[]) => {
      execs.push({ sql, params });
      return { success: true };
    },
    queryFirst: async (sql: string, ...params: unknown[]) => {
      if (/FROM api_usage/.test(sql)) return { n: 0 };
      if (/FROM external_card_refs/.test(sql)) {
        const provider = params[0] as string;
        const internalId = params[1] as string;
        refLookups.push({ provider, cardId: internalId });
        const providerId = refs[internalId];
        return providerId ? { id: 1, provider, internal_card_id: internalId, provider_card_id: providerId, market: "EU" } : null;
      }
      if (/COUNT\(\*\) as n FROM cards c/.test(sql)) return { n: 0 };
      return null;
    },
    queryAll: async (sql: string, ...params: unknown[]) => {
      if (/FROM settings/.test(sql)) return [];
      if (/SELECT c\.\* FROM cards c/.test(sql)) return cardsDue.slice(0, params[params.length - 1] as number);
      return [];
    },
  } as unknown as Db;
  return { db, execs, refLookups };
}

function namedProvider(name: string): MarketDataProvider {
  return { name } as unknown as MarketDataProvider;
}

function spyCache(snapshot: MarketSnapshotResult | null = null) {
  const requested: string[] = [];
  const cache = {
    getSnapshot: async (_internal: string, providerCardId: string) => {
      requested.push(providerCardId);
      return snapshot;
    },
  } as unknown as MarketSnapshotCache;
  return { cache, requested };
}

describe("a card is only ever priced by a provider configured for its game", () => {
  it("never asks the Pokémon provider about a card from another game", async () => {
    const { db, refLookups } = fakeDb([cardRow("c1", "onepiece")], { c1: "p1" });
    const settings = await loadSettings(db);
    const poke = spyCache();

    const result = await runMarketProfiling(
      db,
      singleGameProviderSet("pokemon", { provider: namedProvider("poketrace"), cache: poke.cache }),
      settings,
      200,
      12,
    );

    // Not merely "no snapshot" — the provider was never reached at all, and
    // no external-ref lookup was even attempted on its behalf.
    expect(poke.requested).toEqual([]);
    expect(refLookups).toEqual([]);
    expect(result.cardsWithNoProviderForGame).toBe(1);
    expect(result.cardsProfiled).toBe(0);
  });

  /**
   * The distinction is worth a counter of its own. "No external ref" means
   * we know who to ask and have not mapped this card yet. This means nobody
   * is configured to answer for the game at all. Conflating them sends an
   * operator hunting for a missing mapping when what is missing is a
   * provider.
   */
  it("records a game with no provider distinctly from a card with no reference", async () => {
    const { db } = fakeDb([cardRow("c1", "onepiece"), cardRow("c2", "pokemon")], {});
    const settings = await loadSettings(db);

    const result = await runMarketProfiling(
      db,
      singleGameProviderSet("pokemon", { provider: namedProvider("poketrace"), cache: spyCache().cache }),
      settings,
      200,
      12,
    );

    expect(result.cardsWithNoProviderForGame).toBe(1);
    expect(result.cardsMissingExternalRef).toBe(1);
  });

  it("sends each game's cards to its own provider when two are configured", async () => {
    const { db, refLookups } = fakeDb([cardRow("c1", "pokemon"), cardRow("c2", "onepiece")], { c1: "p1", c2: "p2" });
    const settings = await loadSettings(db);
    const poke = spyCache();
    const just = spyCache();

    await runMarketProfiling(
      db,
      createGameProviderSet({
        pokemon: { provider: namedProvider("poketrace"), cache: poke.cache },
        onepiece: { provider: namedProvider("justtcg"), cache: just.cache },
      }),
      settings,
      200,
      12,
    );

    expect(poke.requested).toEqual(["p1"]);
    expect(just.requested).toEqual(["p2"]);
    // The external-ref lookup is scoped per provider too — a One Piece card
    // must not resolve against a PokéTrace reference row.
    expect(refLookups).toEqual([
      { provider: "poketrace", cardId: "c1" },
      { provider: "justtcg", cardId: "c2" },
    ]);
  });

  /**
   * A row whose game string we do not recognise is a row we cannot price.
   * Falling back to the configured provider is precisely how a One Piece
   * price would land on a Pokémon ladder.
   */
  it("refuses a row whose game string is unrecognised rather than defaulting it", async () => {
    const { db } = fakeDb([cardRow("c1", "digimon"), cardRow("c2", "")], { c1: "p1", c2: "p2" });
    const settings = await loadSettings(db);
    const poke = spyCache();

    const result = await runMarketProfiling(
      db,
      singleGameProviderSet("pokemon", { provider: namedProvider("poketrace"), cache: poke.cache }),
      settings,
      200,
      12,
    );

    expect(poke.requested).toEqual([]);
    expect(result.cardsWithNoProviderForGame).toBe(2);
  });

  /**
   * The budget exists to cap what the tool spends per day. That total does
   * not get larger because the spend is split between two vendors —
   * counting each provider against its own full allowance would silently
   * double the cap the moment a second game was added.
   */
  it("counts the daily budget across every configured provider, not per provider", async () => {
    const seen: string[] = [];
    const base = fakeDb([], {});
    const db = {
      ...base.db,
      queryFirst: async (sql: string, ...params: unknown[]) => {
        if (/FROM api_usage/.test(sql)) {
          seen.push(params[0] as string);
          return { n: 5 };
        }
        return (base.db as unknown as { queryFirst: (s: string, ...p: unknown[]) => Promise<unknown> }).queryFirst(sql, ...params);
      },
    } as unknown as Db;
    const settings = await loadSettings(db);

    const result = await runMarketProfiling(
      db,
      createGameProviderSet({
        pokemon: { provider: namedProvider("poketrace"), cache: spyCache().cache },
        onepiece: { provider: namedProvider("justtcg"), cache: spyCache().cache },
      }),
      settings,
      200,
      12,
    );

    expect(seen.sort()).toEqual(["justtcg", "poketrace"]);
    expect(result.providerCallsUsedToday).toBe(10);
  });
});

describe("the operator can see which games this deployment can actually price", () => {
  it("names the provider for a covered game and the reason for an uncovered one", () => {
    const lines = describeGameCoverage(singleGameProviderSet("pokemon", { provider: namedProvider("poketrace"), cache: spyCache().cache }));

    expect(lines.some((l) => /Pokémon: priced by poketrace/.test(l))).toBe(true);
    expect(lines.some((l) => /One Piece: no market provider configured/.test(l))).toBe(true);
    // An uncovered game says what would be needed, not just that it is absent.
    expect(lines.find((l) => l.startsWith("One Piece"))!.length).toBeGreaterThan(80);
  });
});

/**
 * JustTCG covers seventeen games and does not publish its slug list, so the
 * pairing between our game id and its slug is configuration. A typo that
 * silently fell back to a default would be the same class of bug as the
 * hardcode this whole change removed.
 */
describe("JUSTTCG_GAMES configuration", () => {
  it("parses a single pairing", () => {
    expect(parseJustTcgGames("onepiece:one-piece-card-game").pairs).toEqual([{ game: "onepiece", slug: "one-piece-card-game" }]);
  });

  it("parses several, ignoring surrounding whitespace", () => {
    const { pairs } = parseJustTcgGames(" onepiece:one-piece-card-game , lorcana:disney-lorcana ");
    expect(pairs).toEqual([
      { game: "onepiece", slug: "one-piece-card-game" },
      { game: "lorcana", slug: "disney-lorcana" },
    ]);
  });

  it("is a no-op when unset, so an existing deployment is unchanged", () => {
    expect(parseJustTcgGames(undefined)).toEqual({ pairs: [], warnings: [] });
    expect(parseJustTcgGames("")).toEqual({ pairs: [], warnings: [] });
  });

  it("drops a malformed entry and says so, rather than half-honouring it", () => {
    const { pairs, warnings } = parseJustTcgGames("onepiece,lorcana:,:slug,onepiece:one-piece-card-game");

    expect(pairs).toEqual([{ game: "onepiece", slug: "one-piece-card-game" }]);
    expect(warnings).toHaveLength(3);
  });

  it("drops a game this tool does not model", () => {
    const { pairs, warnings } = parseJustTcgGames("digimon:digimon-card-game");

    expect(pairs).toEqual([]);
    expect(warnings[0]).toMatch(/does not model/);
  });

  /**
   * PokéTrace returns PSA 1-10 WITH a sale count per tier; JustTCG's graded
   * variants carry no sale count at all. Quietly re-pointing Pokémon at the
   * weaker source would degrade the one game that works, invisibly, because
   * both produce a ladder that looks the same.
   */
  it("refuses to re-point Pokémon at the weaker-evidenced source", () => {
    const { pairs, warnings } = parseJustTcgGames("pokemon:pokemon");

    expect(pairs).toEqual([]);
    expect(warnings[0]).toMatch(/pokemon/i);
  });

  it("uses only the first pairing when a game is listed twice", () => {
    const { pairs, warnings } = parseJustTcgGames("onepiece:slug-a,onepiece:slug-b");

    expect(pairs).toEqual([{ game: "onepiece", slug: "slug-a" }]);
    expect(warnings[0]).toMatch(/more than once/);
  });
});
