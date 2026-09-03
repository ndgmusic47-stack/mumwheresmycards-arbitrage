import { describe, it, expect, vi } from "vitest";
import { EbayBrowseProvider } from "../src/ebay/EbayBrowseProvider.js";

function mockFetchSequence(responses: { status: number; body: unknown }[]): typeof fetch {
  let call = 0;
  return vi.fn().mockImplementation(async () => {
    const r = responses[Math.min(call, responses.length - 1)]!;
    call++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.status === 200 ? "OK" : "Error",
      json: async () => r.body,
    };
  }) as unknown as typeof fetch;
}

const config = {
  clientId: "id",
  clientSecret: "secret",
  marketplaceId: "EBAY_GB",
  oauthScope: "https://api.ebay.com/oauth/api_scope",
};

describe("EbayBrowseProvider", () => {
  it("fetches an OAuth token then searches, mapping item summaries to RawEbayListing", async () => {
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { access_token: "tok123", expires_in: 7200 } },
      {
        status: 200,
        body: {
          itemSummaries: [
            {
              itemId: "v1|123456|0",
              title: "Charizard Base Set Holo",
              price: { value: "1500.00", currency: "GBP" },
              shippingOptions: [{ shippingCost: { value: "9.99" } }],
              buyingOptions: ["FIXED_PRICE"],
              condition: "Ungraded",
              seller: { username: "seller1", feedbackScore: 500, feedbackPercentage: "99.5" },
              itemWebUrl: "https://www.ebay.co.uk/itm/123456",
              image: { imageUrl: "https://img.example/1.jpg" },
              itemLocation: { country: "GB" },
            },
          ],
        },
      },
    ]);

    const provider = new EbayBrowseProvider({ ...config, fetchImpl });
    const results = await provider.searchActiveListings({ keywords: "Charizard Base Set" });

    expect(results).toHaveLength(1);
    expect(results[0]!.ebayItemId).toBe("v1|123456|0");
    expect(results[0]!.price).toBe(1500);
    expect(results[0]!.shippingCost).toBe(9.99);
    expect(results[0]!.listingType).toBe("FIXED");
    // Seller username is deliberately never captured — see the NOTE in
    // EbayListingsProvider.ts — so there is nothing to assert here beyond
    // the type not exposing it.
    expect((results[0] as Record<string, unknown>).sellerUsername).toBeUndefined();
  });

  it("caches the OAuth token across multiple searches", async () => {
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { access_token: "tok123", expires_in: 7200 } },
      { status: 200, body: { itemSummaries: [] } },
      { status: 200, body: { itemSummaries: [] } },
    ]);

    const provider = new EbayBrowseProvider({ ...config, fetchImpl });
    await provider.searchActiveListings({ keywords: "a" });
    await provider.searchActiveListings({ keywords: "b" });

    // 1 token call + 2 search calls = 3 total fetch calls (token not re-fetched)
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("classifies AUCTION and BEST_OFFER listing types correctly", async () => {
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { access_token: "tok", expires_in: 7200 } },
      {
        status: 200,
        body: {
          itemSummaries: [
            {
              itemId: "1",
              title: "Auction item",
              price: { value: "10.00", currency: "GBP" },
              buyingOptions: ["AUCTION"],
              itemWebUrl: "https://ebay.co.uk/1",
            },
            {
              itemId: "2",
              title: "Best offer item",
              price: { value: "20.00", currency: "GBP" },
              buyingOptions: ["BEST_OFFER"],
              itemWebUrl: "https://ebay.co.uk/2",
            },
          ],
        },
      },
    ]);

    const provider = new EbayBrowseProvider({ ...config, fetchImpl });
    const results = await provider.searchActiveListings({ keywords: "x" });
    expect(results[0]!.listingType).toBe("AUCTION");
    expect(results[1]!.listingType).toBe("BEST_OFFER");
  });

  it("REGRESSION: falls back to currentBidPrice for a live AUCTION with no fixed price (found 2026-09-02 against a real £0-price listing)", async () => {
    // A real eBay AUCTION listing (Dragonite Movie Promo, item 398337061671)
    // had zero completed bids and no `price` field at all — only
    // `currentBidPrice`. Reading only item.price?.value made this look like
    // a free card (price 0 + postage only), which then sailed through the
    // economics engine as a "QUALIFIED GRADE, DOWNSIDE PROTECTED" trade with
    // a fabricated four-figure profit. bug 7's £0-total guard didn't catch
    // it because postage alone made the total nonzero.
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { access_token: "tok", expires_in: 7200 } },
      {
        status: 200,
        body: {
          itemSummaries: [
            {
              itemId: "v1|398337061671|0",
              title: "Dragonite Movie Promo Card 05/53 WOTC Rough Edges, HP",
              // no `price` field — eBay omits it for pure auctions
              currentBidPrice: { value: "5.45", currency: "GBP" },
              bidCount: 0,
              shippingOptions: [{ shippingCost: { value: "2.72" } }],
              buyingOptions: ["AUCTION", "BEST_OFFER"],
              condition: "Ungraded",
              itemWebUrl: "https://www.ebay.co.uk/itm/398337061671",
            },
          ],
        },
      },
    ]);

    const provider = new EbayBrowseProvider({ ...config, fetchImpl });
    const results = await provider.searchActiveListings({ keywords: "Dragonite" });

    expect(results[0]!.listingType).toBe("AUCTION");
    expect(results[0]!.price).toBe(5.45);
    expect(results[0]!.currency).toBe("GBP");
    expect(results[0]!.bids).toBe(0);
  });

  it("does NOT fall back to currentBidPrice for a FIXED-price listing missing its price (stays 0, not silently wrong)", async () => {
    // Only auctions are expected to lack `price`. If a fixed-price listing
    // is ever missing it too, that's a genuinely unpriced listing — bug 7's
    // downstream guard is what should catch that case, not a bid-price
    // fallback that doesn't apply to it.
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { access_token: "tok", expires_in: 7200 } },
      {
        status: 200,
        body: {
          itemSummaries: [
            {
              itemId: "1",
              title: "Weird fixed-price listing with no price field",
              currentBidPrice: { value: "5.45", currency: "GBP" }, // shouldn't apply — not an auction
              buyingOptions: ["FIXED_PRICE"],
              itemWebUrl: "https://ebay.co.uk/1",
            },
          ],
        },
      },
    ]);

    const provider = new EbayBrowseProvider({ ...config, fetchImpl });
    const results = await provider.searchActiveListings({ keywords: "x" });

    expect(results[0]!.listingType).toBe("FIXED");
    expect(results[0]!.price).toBe(0);
  });

  it("STABILISATION item 11: appends sort=newlyListed to the request URL when sort: 'NEWLY_LISTED' is requested", async () => {
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { access_token: "tok", expires_in: 7200 } },
      { status: 200, body: { itemSummaries: [] } },
    ]);

    const provider = new EbayBrowseProvider({ ...config, fetchImpl });
    await provider.searchActiveListings({ keywords: "x", sort: "NEWLY_LISTED" });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const searchUrl = new URL(calls[1]![0] as string);
    expect(searchUrl.searchParams.get("sort")).toBe("newlyListed");
  });

  it("does NOT set a sort param when sort is omitted (eBay's own default relevance ranking applies)", async () => {
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { access_token: "tok", expires_in: 7200 } },
      { status: 200, body: { itemSummaries: [] } },
    ]);

    const provider = new EbayBrowseProvider({ ...config, fetchImpl });
    await provider.searchActiveListings({ keywords: "x" });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const searchUrl = new URL(calls[1]![0] as string);
    expect(searchUrl.searchParams.has("sort")).toBe(false);
  });

  it("STABILISATION item 11: applies a maxPrice filter to the request URL when given", async () => {
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { access_token: "tok", expires_in: 7200 } },
      { status: 200, body: { itemSummaries: [] } },
    ]);

    const provider = new EbayBrowseProvider({ ...config, fetchImpl });
    await provider.searchActiveListings({ keywords: "x", maxPrice: 123.45 });

    const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const searchUrl = new URL(calls[1]![0] as string);
    expect(searchUrl.searchParams.get("filter")).toContain("price:[..123.45]");
  });

  it("throws when the OAuth token request fails", async () => {
    const fetchImpl = mockFetchSequence([{ status: 401, body: {} }]);
    const provider = new EbayBrowseProvider({ ...config, fetchImpl });
    await expect(provider.searchActiveListings({ keywords: "x" })).rejects.toThrow();
  });

  it("throws when the search request fails", async () => {
    const fetchImpl = mockFetchSequence([
      { status: 200, body: { access_token: "tok", expires_in: 7200 } },
      { status: 500, body: {} },
    ]);
    const provider = new EbayBrowseProvider({ ...config, fetchImpl });
    await expect(provider.searchActiveListings({ keywords: "x" })).rejects.toThrow();
  });

  describe("getItemDetail (SOURCING WORKFLOW item 9)", () => {
    it("maps a Get Item response's conditionDescriptors/conditionDescription, keeping descriptor codes RAW/unmapped", async () => {
      const fetchImpl = mockFetchSequence([
        { status: 200, body: { access_token: "tok", expires_in: 7200 } },
        {
          status: 200,
          body: {
            conditionDescriptors: [
              { name: "27501", values: [{ content: "400010" }] },
              { name: "27502", values: [{ content: "10" }, { content: "PSA" }] },
            ],
            conditionDescription: "Excellent - Lightly played, minor edge wear",
          },
        },
      ]);

      const provider = new EbayBrowseProvider({ ...config, fetchImpl });
      const detail = await provider.getItemDetail("v1|123456|0");

      expect(detail).not.toBeNull();
      expect(detail!.ebayItemId).toBe("v1|123456|0");
      // RAW dictionary IDs, not translated into words — see doc comment.
      expect(detail!.conditionDescriptors).toEqual([
        { name: "27501", values: ["400010"] },
        { name: "27502", values: ["10", "PSA"] },
      ]);
      expect(detail!.conditionDescription).toBe("Excellent - Lightly played, minor edge wear");
    });

    it("percent-encodes the item id in the request path (item ids contain '|' characters)", async () => {
      const fetchImpl = mockFetchSequence([
        { status: 200, body: { access_token: "tok", expires_in: 7200 } },
        { status: 200, body: {} },
      ]);
      const provider = new EbayBrowseProvider({ ...config, fetchImpl });
      await provider.getItemDetail("v1|123456|0");

      const calls = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls;
      const requestedUrl = calls[1]![0] as string;
      expect(requestedUrl).toBe(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent("v1|123456|0")}`);
    });

    it("defaults to an empty conditionDescriptors array when eBay returns none", async () => {
      const fetchImpl = mockFetchSequence([
        { status: 200, body: { access_token: "tok", expires_in: 7200 } },
        { status: 200, body: {} },
      ]);
      const provider = new EbayBrowseProvider({ ...config, fetchImpl });
      const detail = await provider.getItemDetail("v1|1|0");
      expect(detail!.conditionDescriptors).toEqual([]);
      expect(detail!.conditionDescription).toBeUndefined();
      expect(detail!.description).toBeUndefined();
      expect(detail!.aspects).toBeUndefined();
    });

    /** REGRESSION GUARD, AI INTELLIGENCE gap 2 (multimodal, evidence-rich
     *  Listing Analyst): eBay's free-text description and seller-declared
     *  item specifics (localizedAspects) must be captured, not just
     *  condition descriptors — confirmed field names against eBay's own
     *  Browse API docs, 2026-09-03 (see EbayItemAspect's doc comment). */
    it("maps a Get Item response's description and localizedAspects", async () => {
      const fetchImpl = mockFetchSequence([
        { status: 200, body: { access_token: "tok", expires_in: 7200 } },
        {
          status: 200,
          body: {
            description: "<p>Pulled from a binder, never played. Ask any questions!</p>",
            localizedAspects: [
              { name: "Language", value: "English" },
              { name: "Grade", value: "Ungraded" },
              { name: "Card Condition", value: "Near Mint or Better" },
            ],
          },
        },
      ]);

      const provider = new EbayBrowseProvider({ ...config, fetchImpl });
      const detail = await provider.getItemDetail("v1|123456|0");

      expect(detail!.description).toBe("<p>Pulled from a binder, never played. Ask any questions!</p>");
      expect(detail!.aspects).toEqual([
        { name: "Language", value: "English" },
        { name: "Grade", value: "Ungraded" },
        { name: "Card Condition", value: "Near Mint or Better" },
      ]);
    });

    it("drops a malformed localizedAspects entry (missing name or value) rather than storing a half-empty aspect", async () => {
      const fetchImpl = mockFetchSequence([
        { status: 200, body: { access_token: "tok", expires_in: 7200 } },
        {
          status: 200,
          body: {
            localizedAspects: [
              { name: "Language", value: "English" },
              { name: "Grade" }, // no value — malformed, must be dropped
              { value: "orphaned value" }, // no name — malformed, must be dropped
            ],
          },
        },
      ]);

      const provider = new EbayBrowseProvider({ ...config, fetchImpl });
      const detail = await provider.getItemDetail("v1|123456|0");

      expect(detail!.aspects).toEqual([{ name: "Language", value: "English" }]);
    });

    it("reuses the cached OAuth token from a prior search rather than re-authenticating", async () => {
      const fetchImpl = mockFetchSequence([
        { status: 200, body: { access_token: "tok", expires_in: 7200 } },
        { status: 200, body: { itemSummaries: [] } },
        { status: 200, body: {} },
      ]);
      const provider = new EbayBrowseProvider({ ...config, fetchImpl });
      await provider.searchActiveListings({ keywords: "x" });
      await provider.getItemDetail("v1|1|0");

      // 1 token call + 1 search + 1 get-item = 3 total (token not re-fetched)
      expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    });

    it("throws when the Get Item request fails", async () => {
      const fetchImpl = mockFetchSequence([
        { status: 200, body: { access_token: "tok", expires_in: 7200 } },
        { status: 404, body: {} },
      ]);
      const provider = new EbayBrowseProvider({ ...config, fetchImpl });
      await expect(provider.getItemDetail("v1|missing|0")).rejects.toThrow();
    });
  });
});
