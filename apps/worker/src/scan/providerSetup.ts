import { Db } from "@mwmc/db";
import type { FxRates, Game } from "@mwmc/core";
import { parseGame } from "@mwmc/core";
import {
  createMarketDataProvider,
  createCatalogueProvider,
  MarketSnapshotCache,
  type CatalogueProvider,
} from "@mwmc/providers";
import type { Env } from "../env.js";
import { createGameProviderSet, type GameProviderEntry, type GameProviderSet } from "./gameProviders.js";

/**
 * TURNING CONFIGURATION INTO A GAME→PROVIDER MAP.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ENV VAR THAT MADE THIS SINGLE-GAME.
 *
 * `MARKET_PROVIDER` chose the catalogue provider AND the market provider,
 * globally. It is kept, unchanged, as the provider for Pokémon — every
 * existing deployment keeps behaving exactly as it does today, and an
 * operator who adds nothing sees no difference.
 *
 * What is new is `JUSTTCG_GAMES`, which adds games alongside it rather than
 * instead of it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE SLUG IS CONFIGURATION AND NOT A CONSTANT.
 *
 * JustTCG covers seventeen games and its documentation does not print the
 * slug list. The convention is lowercase-hyphenated, so "one-piece-card-game"
 * is a good guess — and a good guess is exactly what this project has
 * already been burned by, when a documented-looking `/cards/{id}` path cost
 * a day against an API whose real path was `/v1/cards/{id}`.
 *
 * So the operator supplies the pairing, and `GET /games` tells them what to
 * supply. A wrong slug then produces an empty catalogue with a clear cause,
 * not a silently mis-filed one.
 *
 *   JUSTTCG_GAMES = "onepiece:one-piece-card-game"
 *   JUSTTCG_GAMES = "onepiece:one-piece-card-game,lorcana:disney-lorcana"
 *
 * Left unset, nothing changes: no second game, no second provider, no extra
 * quota spent.
 */

export interface GameProviderBundle {
  market: GameProviderSet;
  /** One catalogue provider per game that has one, for the sync step. */
  catalogues: { game: Game; provider: CatalogueProvider }[];
  /** Configuration problems found while building — surfaced, never thrown. */
  warnings: string[];
}

/**
 * Parse `JUSTTCG_GAMES` into validated pairs.
 *
 * Every malformed entry is REPORTED and DROPPED, never partially honoured.
 * A typo in a game id that silently fell back to a default would be the
 * same class of bug as the hardcode this whole change removes.
 */
export function parseJustTcgGames(raw: string | undefined): { pairs: { game: Game; slug: string }[]; warnings: string[] } {
  const pairs: { game: Game; slug: string }[] = [];
  const warnings: string[] = [];
  if (!raw || raw.trim() === "") return { pairs, warnings };

  for (const chunk of raw.split(",")) {
    const entry = chunk.trim();
    if (entry === "") continue;

    const idx = entry.indexOf(":");
    if (idx <= 0 || idx === entry.length - 1) {
      warnings.push(`JUSTTCG_GAMES entry '${entry}' is not in the form <game>:<providerSlug> — ignored.`);
      continue;
    }

    const game = parseGame(entry.slice(0, idx).trim());
    const slug = entry.slice(idx + 1).trim();
    if (!game) {
      warnings.push(`JUSTTCG_GAMES entry '${entry}' names a game this tool does not model — ignored.`);
      continue;
    }
    if (game === "pokemon") {
      // Refused rather than allowed. PokeTrace returns PSA 1-10 WITH
      // per-tier sale counts; JustTCG's graded variants carry no sale
      // count at all. Quietly re-pointing Pokemon at the weaker source
      // would degrade the one game that currently works, and it would do
      // so invisibly, because both produce a ladder that looks the same.
      warnings.push("JUSTTCG_GAMES names pokemon, which is served by MARKET_PROVIDER and has better-evidenced data there — ignored.");
      continue;
    }
    if (pairs.some((p) => p.game === game)) {
      warnings.push(`JUSTTCG_GAMES names '${game}' more than once — only the first pairing is used.`);
      continue;
    }

    pairs.push({ game, slug });
  }

  return { pairs, warnings };
}

export function buildGameProviders(
  db: Db,
  env: Env,
  opts: { fxRates: FxRates; ttlHours: number; scanRunId?: string | null },
): GameProviderBundle {
  const warnings: string[] = [];
  const map: Partial<Record<Game, GameProviderEntry>> = {};
  const catalogues: { game: Game; provider: CatalogueProvider }[] = [];

  const cache = (provider: GameProviderEntry["provider"]): MarketSnapshotCache =>
    new MarketSnapshotCache(db, provider, { ttlHours: opts.ttlHours, scanRunId: opts.scanRunId ?? undefined });

  // ── Pokémon: exactly as before. ───────────────────────────────────────
  const pokemonMarket = createMarketDataProvider(env.MARKET_PROVIDER, {
    poketraceApiKey: env.POKETRACE_API_KEY,
    poketraceBaseUrl: env.POKETRACE_API_BASE_URL,
    fxRates: opts.fxRates,
  });
  map.pokemon = { provider: pokemonMarket, cache: cache(pokemonMarket) };
  catalogues.push({
    game: "pokemon",
    provider: createCatalogueProvider(env.MARKET_PROVIDER, {
      poketraceApiKey: env.POKETRACE_API_KEY,
      poketraceBaseUrl: env.POKETRACE_API_BASE_URL,
    }),
  });

  // ── Additional games via JustTCG. ─────────────────────────────────────
  const { pairs, warnings: parseWarnings } = parseJustTcgGames(env.JUSTTCG_GAMES);
  warnings.push(...parseWarnings);

  if (pairs.length > 0 && !env.JUSTTCG_API_KEY) {
    warnings.push(
      `JUSTTCG_GAMES configures ${pairs.length} game(s) but JUSTTCG_API_KEY is not set — those games will be catalogued by nobody and profiled by nobody.`,
    );
    return { market: createGameProviderSet(map), catalogues, warnings };
  }

  for (const { game, slug } of pairs) {
    try {
      const market = createMarketDataProvider("justtcg", {
        justtcgApiKey: env.JUSTTCG_API_KEY,
        justtcgBaseUrl: env.JUSTTCG_MARKET_BASE_URL,
        fxRates: opts.fxRates,
      });
      map[game] = { provider: market, cache: cache(market) };
      catalogues.push({
        game,
        provider: createCatalogueProvider("justtcg", {
          justtcgApiKey: env.JUSTTCG_API_KEY,
          justtcgBaseUrl: env.JUSTTCG_CATALOGUE_BASE_URL,
          justtcgGameSlug: slug,
          justtcgGame: game,
        }),
      });
    } catch (err) {
      // A misconfigured extra game must never take the scan down with it.
      // Pokémon is the working business; a new game is an addition, and an
      // addition that throws should degrade to "that game is absent", which
      // is precisely the state the operator was in before configuring it.
      warnings.push(`Could not configure JustTCG for '${game}': ${String(err)}`);
    }
  }

  return { market: createGameProviderSet(map), catalogues, warnings };
}
