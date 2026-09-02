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
});
