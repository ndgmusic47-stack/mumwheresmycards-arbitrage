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
  // NOTE: seller username is deliberately NOT captured here. eBay disables
  // production keysets that don't implement (or hold an exemption from) the
  // Marketplace Account Deletion/Account Closure Notification requirement,
  // which applies to apps that store eBay-account-linked data. This project
  // never needed the seller's identity for anything beyond a display label,
  // so it's dropped at the provider boundary instead — see ARCHITECTURE.md.
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
  /**
   * STABILISATION item 11 ("sort sourcing searches by newly listed where
   * supported"): defaults to the provider's own relevance ranking
   * (undefined / "BEST_MATCH"). "NEWLY_LISTED" asks the provider to surface
   * the most recently listed items first, which matters for a sourcing tool
   * — a genuinely underpriced listing is most likely to still be available,
   * and most likely to still be unnoticed, soon after it goes up. A
   * provider that has no such concept (e.g. a static fixture set) is free
   * to ignore this field entirely — "where supported" is deliberate.
   */
  sort?: "BEST_MATCH" | "NEWLY_LISTED";
}

/**
 * SOURCING WORKFLOW item 9 (two-stage eBay enrichment): the richer,
 * per-listing detail available from eBay's Browse API "Get Item" call —
 * deliberately a SEPARATE call from search (item_summary/search), never
 * folded into it, because eBay only returns this depth for one listing at
 * a time and it costs a full extra API call per item. Callers must gate
 * this to a small number of PROMISING candidates per run (see
 * scanRunner.ts) — never fired for every search result.
 *
 * `conditionDescriptors` is confirmed (developer.ebay.com/api-docs/buy/
 * browse/types/gct:Item, checked 2026-09-02) to be populated ONLY for
 * trading card categories — exactly this app's domain — which is why this
 * exists at all. Each descriptor's `name` and `values` are NUMERIC ID
 * STRINGS from eBay's condition-descriptor dictionary (e.g. "27501"),
 * not human-readable text; eBay does not inline the label, only a
 * separate getItemConditionPolicies lookup (not implemented here) does.
 * This is stored and surfaced RAW/unmapped rather than guessing what each
 * ID means — the same discipline this codebase already applies to
 * PokeTrace's tier keys: verify against a real captured response before
 * trusting an interpretation, never assume one from docs alone.
 */
export interface EbayConditionDescriptor {
  name: string;
  values: string[];
}

export interface RawEbayItemDetail {
  ebayItemId: string;
  conditionDescriptors: EbayConditionDescriptor[];
  /** eBay's own free-text elaboration of `condition`, when present (e.g.
   *  "Excellent - Lightly played, minor edge wear"). Independent of, and
   *  usually more useful pre-mapping than, the raw conditionDescriptors. */
  conditionDescription?: string;
  rawPayload?: unknown;
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
  /**
   * Optional: a provider that has no richer per-item data (e.g. a static
   * fixture set with nothing more to say) simply omits this method rather
   * than implementing a no-op. Callers must feature-detect
   * (`typeof provider.getItemDetail === "function"`) before calling it —
   * see scanRunner.ts.
   */
  getItemDetail?(itemId: string): Promise<RawEbayItemDetail | null>;
}
