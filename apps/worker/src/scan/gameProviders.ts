import type { Game } from "@mwmc/core";
import { gameProfile, GAMES } from "@mwmc/core";
import type { MarketDataProvider, MarketSnapshotCache } from "@mwmc/providers";

/**
 * WHICH PROVIDER PRICES WHICH GAME.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ASSUMPTION THIS REPLACES. Every provider in this worker was built
 * from one environment variable, `MARKET_PROVIDER`, used for BOTH the
 * catalogue and the market data. One variable, one provider, one game — and
 * so pointing the tool at a second game meant pointing it AWAY from the
 * first. Pokémon would have lost PokeTrace the moment One Piece gained
 * JustTCG.
 *
 * A card's game decides who can price it. That is a property of the card,
 * not of the deployment, so it cannot live in an env var.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A GAME WITH NO PROVIDER IS A FIRST-CLASS ANSWER.
 *
 * `forGame` returns null rather than falling back to whichever provider
 * happens to be configured. Asking PokeTrace about a One Piece card does
 * not fail loudly — it returns nothing, or worse, matches a Pokémon card
 * with a similar name. Routing to a provider that does not cover the game
 * is how a One Piece row acquires a Pokémon price.
 *
 * A null here means the card is catalogued and unprofiled, which is exactly
 * what it is, and the profiling loop records it as such so the operator can
 * see the count instead of wondering why a game they added shows nothing.
 */
export interface GameProviderEntry {
  provider: MarketDataProvider;
  cache: MarketSnapshotCache;
}

export interface GameProviderSet {
  /** The provider that can price this game, or null if none is configured. */
  forGame(game: Game): GameProviderEntry | null;
  /** Every distinct configured provider, for budget accounting and messages. */
  entries(): GameProviderEntry[];
  /** Games this deployment can actually price right now. */
  supportedGames(): Game[];
}

/**
 * Build a provider set from an explicit game→provider map.
 *
 * Deliberately explicit rather than inferred from the provider's name: a
 * provider covering four games and a provider covering one look identical
 * from the outside, and guessing coverage from a class name is how a tool
 * comes to believe it supports games it has never successfully called.
 */
export function createGameProviderSet(map: Partial<Record<Game, GameProviderEntry>>): GameProviderSet {
  const distinct: GameProviderEntry[] = [];
  for (const entry of Object.values(map)) {
    if (entry && !distinct.some((e) => e.provider.name === entry.provider.name)) distinct.push(entry);
  }

  return {
    forGame: (game) => map[game] ?? null,
    entries: () => distinct,
    supportedGames: () => GAMES.filter((g) => map[g] != null),
  };
}

/**
 * The single-provider case, preserved exactly.
 *
 * Every deployment today is this: one provider, Pokémon only. Expressing it
 * through the same type as the multi-game case means the routing code has
 * one path, not a legacy path and a new one — the second of which would be
 * the only one anybody tested.
 */
export function singleGameProviderSet(game: Game, entry: GameProviderEntry): GameProviderSet {
  return createGameProviderSet({ [game]: entry });
}

/**
 * Human-readable account of what this deployment can and cannot do, for the
 * scan summary. An operator who adds a game and sees nothing appear should
 * be told which of the two reasons applies: no provider is configured for
 * it, or one is and the game simply has no cards yet.
 */
export function describeGameCoverage(set: GameProviderSet): string[] {
  return GAMES.map((game) => {
    const entry = set.forGame(game);
    const profile = gameProfile(game);
    return entry
      ? `${profile.displayName}: priced by ${entry.provider.name}.`
      : `${profile.displayName}: no market provider configured — cards are catalogued and searched but cannot be profiled or qualified. ${profile.gradedPriceNote}`;
  });
}
