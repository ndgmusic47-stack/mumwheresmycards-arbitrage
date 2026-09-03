import type { EbayListingsProvider, EbaySearchQuery, RawEbayListing, RawEbayItemDetail } from "./EbayListingsProvider.js";

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
  // Fixed-price and Best Offer listings carry `price`. A pure AUCTION
  // listing does not — eBay omits it entirely and reports the live bid
  // state via `currentBidPrice`/`bidCount` instead (confirmed against a
  // real listing, 2026-09-02 — see the fallback in toRawListing below).
  price?: { value: string; currency: string };
  currentBidPrice?: { value: string; currency: string };
  bidCount?: number;
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

// Mirrors the fields of eBay's Browse API `item/{item_id}` ("Get Item")
// response that this adapter reads, for item 9's second-stage enrichment.
// Deliberately minimal — see RawEbayItemDetail's doc comment for why
// conditionDescriptors are captured raw/unmapped rather than interpreted.
// `description`/`localizedAspects` added for AI INTELLIGENCE gap 2 —
// field names and shapes confirmed against developer.ebay.com/api-docs/
// buy/browse/resources/item/methods/getItem, 2026-09-03.
interface EbayItemDetailResponse {
  conditionDescriptors?: { name: string; values?: { content: string }[] }[];
  conditionDescription?: string;
  description?: string;
  localizedAspects?: { name?: string; value?: string }[];
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

    // STABILISATION item 11: eBay's Browse API accepts `sort=newlyListed` to
    // surface the most recently listed items first, instead of its default
    // relevance ranking. Only set when explicitly requested — omitting the
    // param keeps eBay's own default behaviour, unchanged from before.
    if (query.sort === "NEWLY_LISTED") url.searchParams.set("sort", "newlyListed");

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

  /**
   * SOURCING WORKFLOW item 9: second-stage "Get Item" call. Callers decide
   * WHICH listings are worth this (see scanRunner.ts) — this method itself
   * makes no judgement, it just fetches whatever itemId it's given.
   */
  async getItemDetail(itemId: string): Promise<RawEbayItemDetail | null> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const token = await this.getAccessToken();

    // itemId (e.g. "v1|123456789|0") contains characters that must be
    // percent-encoded for use as a path segment.
    const url = `https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(itemId)}`;

    const response = await doFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": this.config.marketplaceId,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`eBay Get Item failed for ${itemId}: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as EbayItemDetailResponse;
    return {
      ebayItemId: itemId,
      conditionDescriptors: (body.conditionDescriptors ?? []).map((d) => ({
        name: d.name,
        values: (d.values ?? []).map((v) => v.content),
      })),
      conditionDescription: body.conditionDescription,
      description: body.description,
      // AI INTELLIGENCE gap 2: only keep aspects with both a name and a
      // value — a malformed/partial entry from eBay is dropped rather than
      // stored as evidence with a missing half, same "don't fabricate the
      // gap" discipline as everywhere else this app touches eBay data.
      aspects: body.localizedAspects
        ?.filter((a): a is { name: string; value: string } => typeof a.name === "string" && typeof a.value === "string")
        .map((a) => ({ name: a.name, value: a.value })),
      rawPayload: body,
    };
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

  // BUG (found 2026-09-02 against real eBay data): this used to read only
  // item.price?.value, defaulting to 0 whenever it was absent. That default
  // is correct for a listing eBay genuinely didn't return a price for, but
  // WRONG for a live AUCTION with no completed bids yet — eBay never
  // populates `price` for those, it reports the live state via
  // `currentBidPrice` instead. The 0 default made a real, biddable auction
  // (e.g. current bid £5.45 + £2.72 postage) look like a free card, which
  // sailed through as a "QUALIFIED GRADE, DOWNSIDE PROTECTED" opportunity
  // with a fabricated multi-hundred-pound profit — bug 7's £0-total guard
  // didn't catch it because postage alone made the total nonzero. Fall back
  // to the current bid for auctions before accepting 0 as the real price.
  const price = item.price?.value ?? (listingType === "AUCTION" ? item.currentBidPrice?.value : undefined);
  const currency = item.price?.currency ?? item.currentBidPrice?.currency ?? "GBP";

  return {
    ebayItemId: item.itemId,
    title: item.title,
    price: Number(price ?? 0),
    currency,
    shippingCost,
    listingType,
    itemCondition: item.condition,
    // Seller username is intentionally never read from eBay's response —
    // see the NOTE in EbayListingsProvider.ts.
    sellerFeedbackScore: item.seller?.feedbackScore,
    sellerFeedbackPct: item.seller?.feedbackPercentage ? Number(item.seller.feedbackPercentage) : undefined,
    itemUrl: item.itemWebUrl,
    imageUrls: images,
    locationCountry: item.itemLocation?.country,
    watchers: undefined, // Browse API does not expose watcher count directly
    bids: item.bidCount,
    endTime: item.itemEndDate ?? null,
    // NOTE: title/aspect -> card identity parsing is deliberately NOT done
    // here. It happens in apps/worker/src/scan (title parser + card
    // resolver) so this adapter stays a pure data-fetching boundary.
    parsedIdentity: {},
    rawPayload: item,
  };
}
