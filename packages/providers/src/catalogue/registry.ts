import type { CatalogueProvider } from "./CatalogueProvider.js";
import { MockCatalogueProvider } from "./MockCatalogueProvider.js";
import { PokeTraceCatalogueProvider } from "./PokeTraceCatalogueProvider.js";

export type CatalogueProviderName = "mock" | "poketrace";

/**
 * The ONE place that wires a provider name to a concrete CatalogueProvider
 * implementation — mirrors packages/providers/src/market/registry.ts.
 */
export function createCatalogueProvider(
  name: CatalogueProviderName,
  config: { poketraceApiKey?: string; poketraceBaseUrl?: string },
): CatalogueProvider {
  switch (name) {
    case "mock":
      return new MockCatalogueProvider();
    case "poketrace":
      if (!config.poketraceApiKey || !config.poketraceBaseUrl) {
        throw new Error("createCatalogueProvider('poketrace'): missing POKETRACE_API_KEY / POKETRACE_API_BASE_URL");
      }
      return new PokeTraceCatalogueProvider({ apiKey: config.poketraceApiKey, baseUrl: config.poketraceBaseUrl });
    default: {
      const exhaustiveCheck: never = name;
      throw new Error(`Unknown catalogue provider: ${exhaustiveCheck}`);
    }
  }
}
