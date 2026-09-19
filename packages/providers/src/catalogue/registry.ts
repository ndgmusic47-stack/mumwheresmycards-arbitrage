import type { CatalogueProvider } from "./CatalogueProvider.js";
import { MockCatalogueProvider } from "./MockCatalogueProvider.js";
import { PokeTraceCatalogueProvider } from "./PokeTraceCatalogueProvider.js";
import { JustTcgCatalogueProvider } from "./JustTcgCatalogueProvider.js";

export type CatalogueProviderName = "mock" | "poketrace" | "justtcg";

/**
 * The ONE place that wires a provider name to a concrete CatalogueProvider
 * implementation — mirrors packages/providers/src/market/registry.ts.
 */
export function createCatalogueProvider(
  name: CatalogueProviderName,
  config: {
    poketraceApiKey?: string;
    poketraceBaseUrl?: string;
    justtcgApiKey?: string;
    justtcgBaseUrl?: string;
    /** JustTCG's own slug for the game to enumerate — resolve via JustTcgCatalogueProvider.fetchGames(), never guess. */
    justtcgGameSlug?: string;
    /** Our canonical Game id that slug corresponds to. */
    justtcgGame?: string;
  },
): CatalogueProvider {
  switch (name) {
    case "mock":
      return new MockCatalogueProvider();
    case "poketrace":
      if (!config.poketraceApiKey || !config.poketraceBaseUrl) {
        throw new Error("createCatalogueProvider('poketrace'): missing POKETRACE_API_KEY / POKETRACE_API_BASE_URL");
      }
      return new PokeTraceCatalogueProvider({ apiKey: config.poketraceApiKey, baseUrl: config.poketraceBaseUrl });
    case "justtcg":
      if (!config.justtcgApiKey) {
        throw new Error("createCatalogueProvider('justtcg'): missing JUSTTCG_API_KEY");
      }
      // Both of these are REQUIRED and deliberately not defaulted. JustTCG
      // covers seventeen games; picking one here would silently catalogue
      // the wrong game under a correct-looking config.
      if (!config.justtcgGameSlug || !config.justtcgGame) {
        throw new Error(
          "createCatalogueProvider('justtcg'): justtcgGameSlug and justtcgGame are both required — resolve the slug from GET /games rather than assuming one",
        );
      }
      return new JustTcgCatalogueProvider({
        apiKey: config.justtcgApiKey,
        baseUrl: config.justtcgBaseUrl,
        gameSlug: config.justtcgGameSlug,
        game: config.justtcgGame,
      });
    default: {
      const exhaustiveCheck: never = name;
      throw new Error(`Unknown catalogue provider: ${exhaustiveCheck}`);
    }
  }
}
