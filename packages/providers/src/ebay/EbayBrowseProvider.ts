import type { EbayListingsProvider, EbaySearchQuery, RawEbayListing } from "./EbayListingsProvider.js";

export interface EbayBrowseConfig {
  clientId: string;
  clientSecret: string;
  marketplaceId: string; // e.g. 'EBAY_GB'
  oauthScope: string;
  fetchImpl?: typeof fetch;
}

interface EbayOAuthToken {
  access_token: string;
  expires_in: number;
}

// Mirrors the fields of eBay's Browse API `item_summary/search` response
// that this adapter actually reads. Kept minimal and ISOLATED to this file
// — packages/core and apps/worker only ever see RawEbayListing.
interface EbayItemSummary {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  shippingOptions?: { shippingCost?: { value: string } }[];
  buyingOptions?: string[];
  condition?: string;
  seller?: { username?: string; feedbackScore?: number; feedbackPercentage?: string };
  itemWebUrl: string;
  image?: { imageUrl: string };
  additionalImages?: { imageUrl: string }[];
  itemLocation?: { country?: string };
  itemEndDate?: string;
}

interface EbaySearchResponse {
  itemSummaries?: EbayItemSummary[];
}

/**
 * Real eBay Browse API adapter (client-credentials OAuth flow). Live
 * listings only — this is supply data, never used as market valuation.
 * Field mapping here is isolated to this file; everything else in the app
 * depends only on EbayListingsProvider/RawEbayListing.
 */
export class EbayBrowseProvider implements EbayListingsProvider {
  readonly name = "ebay-browse";

  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor(private readonly config: EbayBrowseConfig) {}

  async searchActiveListings(query: EbaySearchQuery): Promise<RawEbayListing[]> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const token = await this.getAccessToken();

    const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
    url.searchParams.set("q", query.keywords);
    url.searchParams.set("limit", String(query.limit ?? 50));
    if (query.categoryId) url.searchParams.set("category_ids", query.categoryId);

    const filters: string[] = ["buyingOptions:{FIXED_PRICE|AUCTION|BEST_OFFER}"];
    if (query.maxPrice) filters.push(`price:[..${query.maxPrice}]`, `priceCurrency:GBP`);
    url.searchParams.set("filter", filters.join(","));

    const response = await doFetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": this.config.marketplaceId,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`eBay Browse search failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as EbaySearchResponse;
    return (body.itemSummaries ?? []).map(toRawListing);
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now()) {
      return this.tokenCache.token;
    }

    const doFetch = this.config.fetchImpl ?? fetch;
    const credentials = btoa(`${this.config.clientId}:${this.config.clientSecret}`);

    const response = await doFetch("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: this.config.oauthScope }).toString(),
    });

    if (!response.ok) {
      // eBay's body explains WHY (e.g. "invalid_client" for a sandbox key
      // used against production, or a mismatched App ID / Cert ID pair).
      // Throwing that away turns every auth problem into an indistinguishable
      // 401, so it is included here — it contains no secret of ours.
      const body = await response.text().catch(() => "");
      throw new Error(
        `eBay OAuth token request failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`,
      );
    }

    const token = (await response.json()) as EbayOAuthToken;
    this.tokenCache = {
      token: token.access_token,
      expiresAt: Date.now() + (token.expires_in - 60) * 1000, // refresh 60s early
    };
    return this.tokenCache.token;
  }
}

function toRawListing(item: EbayItemSummary): RawEbayListing {
  const shippingCost = Number(item.shippingOptions?.[0]?.shippingCost?.value ?? 0);
  const buyingOptions = item.buyingOptions ?? [];
  const listingType: RawEbayListing["listingType"] = buyingOptions.includes("AUCTION")
    ? "AUCTION"
    : buyingOptions.includes("BEST_OFFER")
      ? "BEST_OFFER"
      : "FIXED";

  const images = [item.image?.imageUrl, ...(item.additionalImages?.map((i) => i.imageUrl) ?? [])].filter(
    (u): u is string => Boolean(u),
  );

  return {
    ebayItemId: item.itemId,
    title: item.title,
    price: Number(item.price?.value ?? 0),
    currency: item.price?.currency ?? "GBP",
    shippingCost,
    listingType,
    itemCondition: item.condition,
    sellerUsername: item.seller?.username,
    sellerFeedbackScore: item.seller?.feedbackScore,
    sellerFeedbackPct: item.seller?.feedbackPercentage ? Number(item.seller.feedbackPercentage) : undefined,
    itemUrl: item.itemWebUrl,
    imageUrls: images,
    locationCountry: item.itemLocation?.country,
    watchers: undefined, // Browse API does not expose watcher count directly
    bids: undefined,
    endTime: item.itemEndDate ?? null,
    // NOTE: title/aspect -> card identity parsing is deliberately NOT done
    // here. It happens in apps/worker/src/scan (title parser + card
    // resolver) so this adapter stays a pure data-fetching boundary.
    parsedIdentity: {},
    rawPayload: item,
  };
}
