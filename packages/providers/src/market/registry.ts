import type { FxRates } from "@mwmc/core";
import type { MarketDataProvider } from "./MarketDataProvider.js";
import { MockMarketProvider } from "./MockMarketProvider.js";
import { PokeTraceProvider } from "./PokeTraceProvider.js";

export type MarketProviderName = "mock" | "poketrace";

/**
 * The ONE place that wires a provider name (from env/settings) to a
 * concrete MarketDataProvider implementation. Adding PriceCharting,
 * PkmnPrices, or Cardmarket later means adding one case here and one new
 * adapter file — nothing else in the app changes.
 */
export function createMarketDataProvider(
  name: MarketProviderName,
  config: { poketraceApiKey?: string; poketraceBaseUrl?: string; fxRates?: FxRates },
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
    default: {
      const exhaustiveCheck: never = name;
      throw new Error(`Unknown market provider: ${exhaustiveCheck}`);
    }
  }
}
