import type { FxRates } from "@mwmc/core";
import type { MarketDataProvider } from "./MarketDataProvider.js";
import { MockMarketProvider } from "./MockMarketProvider.js";
import { PokeTraceProvider } from "./PokeTraceProvider.js";
import { JustTcgMarketProvider } from "./JustTcgMarketProvider.js";

export type MarketProviderName = "mock" | "poketrace" | "justtcg";

/**
 * The ONE place that wires a provider name (from env/settings) to a
 * concrete MarketDataProvider implementation. Adding PriceCharting,
 * PkmnPrices, or Cardmarket later means adding one case here and one new
 * adapter file — nothing else in the app changes.
 */
export function createMarketDataProvider(
  name: MarketProviderName,
  config: { poketraceApiKey?: string; poketraceBaseUrl?: string; justtcgApiKey?: string; justtcgBaseUrl?: string; fxRates?: FxRates },
): MarketDataProvider {
  switch (name) {
    case "mock":
      return new MockMarketProvider();
    case "poketrace":
      if (!config.poketraceApiKey || !config.poketraceBaseUrl) {
        throw new Error("createMarketDataProvider('poketrace'): missing POKETRACE_API_KEY / POKETRACE_API_BASE_URL");
      }
      return new PokeTraceProvider({
        apiKey: config.poketraceApiKey,
        baseUrl: config.poketraceBaseUrl,
        fxRates: config.fxRates,
      });
    case "justtcg":
      if (!config.justtcgApiKey) {
        throw new Error("createMarketDataProvider('justtcg'): missing JUSTTCG_API_KEY");
      }
      // Graded prices are a v2 feature. The base URL is left to the caller
      // so a v1 key can be pointed at v1 deliberately — but a v1 response
      // carries no `grading` block, so the adapter will honestly return an
      // empty ladder rather than pretending.
      return new JustTcgMarketProvider({
        apiKey: config.justtcgApiKey,
        baseUrl: config.justtcgBaseUrl,
        fxRates: config.fxRates,
      });
    default: {
      const exhaustiveCheck: never = name;
      throw new Error(`Unknown market provider: ${exhaustiveCheck}`);
    }
  }
}
