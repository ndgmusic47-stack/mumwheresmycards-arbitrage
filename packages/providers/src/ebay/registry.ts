import type { EbayListingsProvider } from "./EbayListingsProvider.js";
import { MockEbayProvider } from "./MockEbayProvider.js";
import { EbayBrowseProvider } from "./EbayBrowseProvider.js";

export type EbayProviderName = "mock" | "ebay-browse";

/**
 * The ONE place that wires a provider name (from env/settings) to a
 * concrete EbayListingsProvider implementation.
 */
export function createEbayListingsProvider(
  name: EbayProviderName,
  config: { clientId?: string; clientSecret?: string; marketplaceId?: string; oauthScope?: string },
): EbayListingsProvider {
  switch (name) {
    case "mock":
      return new MockEbayProvider();
    case "ebay-browse":
      if (!config.clientId || !config.clientSecret || !config.marketplaceId || !config.oauthScope) {
        throw new Error("createEbayListingsProvider('ebay-browse'): missing EBAY_CLIENT_ID/EBAY_CLIENT_SECRET/EBAY_MARKETPLACE_ID/EBAY_OAUTH_SCOPE");
      }
      return new EbayBrowseProvider({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        marketplaceId: config.marketplaceId,
        oauthScope: config.oauthScope,
      });
    default: {
      const exhaustiveCheck: never = name;
      throw new Error(`Unknown eBay provider: ${exhaustiveCheck}`);
    }
  }
}
