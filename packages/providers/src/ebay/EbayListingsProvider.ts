/**
 * Provider-agnostic representation of one active eBay listing (SUPPLY
 * signal — never treated as market value, see ARCHITECTURE.md section 4).
 * Identity fields are intentionally raw/unresolved here — the canonical
 * card resolver (packages/core/src/card) turns this into a CardPrinting
 * (or flags it uncertain) in a separate step, not inside the provider.
 */
export interface RawEbayListing {
  ebayItemId: string;
  title: string;
  price: number;
  currency: string;
  shippingCost: number;
  listingType: "FIXED" | "AUCTION" | "BEST_OFFER";
  itemCondition?: string;
  sellerUsername?: string;
  sellerFeedbackScore?: number;
  sellerFeedbackPct?: number;
  itemUrl: string;
  imageUrls: string[];
  locationCountry?: string;
  watchers?: number;
  bids?: number;
  endTime?: string | null;
  /**
   * Best-effort identity fields parsed from the listing title/aspects by
   * the provider adapter. Deliberately Partial<...> shaped like
   * RawCardIdentity (kept as a structural duplicate here, not an import,
   * so this package's ebay/ subtree has zero compile-time dependency on
   * packages/core's card resolver — the worker wires the two together).
   */
  parsedIdentity: Record<string, string | number | undefined>;
  rawPayload?: unknown;
}

export interface EbaySearchQuery {
  keywords: string;
  categoryId?: string;
  maxPrice?: number;
  limit?: number;
}

/**
 * The ONE interface the rest of the application depends on for live eBay
 * supply data. Business logic must never import EbayBrowseProvider (or any
 * future replacement) directly — only this interface, resolved via
 * packages/providers/src/ebay/registry.ts.
 */
export interface EbayListingsProvider {
  readonly name: string;
  searchActiveListings(query: EbaySearchQuery): Promise<RawEbayListing[]>;
}
