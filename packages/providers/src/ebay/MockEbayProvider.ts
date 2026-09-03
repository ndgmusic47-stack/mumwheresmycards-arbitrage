import type { EbayListingsProvider, EbaySearchQuery, RawEbayListing, RawEbayItemDetail } from "./EbayListingsProvider.js";
import { EBAY_LISTING_FIXTURES, findEbayFixturesByKeyword } from "../fixtures/ebay.fixtures.js";

/**
 * Fixture-backed EbayListingsProvider. Default for local dev and the only
 * provider used by tests — matches fixtures by naive keyword containment,
 * mirroring real search semantics closely enough for engine testing
 * without ever calling the network.
 */
export class MockEbayProvider implements EbayListingsProvider {
  readonly name = "mock";

  async searchActiveListings(query: EbaySearchQuery): Promise<RawEbayListing[]> {
    const matches = findEbayFixturesByKeyword(query.keywords);
    const limited = query.limit ? matches.slice(0, query.limit) : matches;
    return query.maxPrice ? limited.filter((l) => l.price <= query.maxPrice!) : limited;
  }

  /** Test/dev convenience — every fixture regardless of query. */
  async allListings(): Promise<RawEbayListing[]> {
    return EBAY_LISTING_FIXTURES;
  }

  /**
   * SOURCING WORKFLOW item 9: a deliberately CANNED stub, not real eBay
   * data — exists only so scanRunner's enrichment-gating logic and the
   * storage/UI plumbing have something deterministic to exercise in tests
   * without a live eBay call. Only "ebay-fixture-001" has a descriptor;
   * every other id returns null ("nothing richer available"), matching the
   * real provider's contract.
   */
  async getItemDetail(itemId: string): Promise<RawEbayItemDetail | null> {
    if (itemId !== "ebay-fixture-001") return null;
    return {
      ebayItemId: itemId,
      conditionDescriptors: [{ name: "27501", values: ["400010"] }],
      conditionDescription: "Excellent - Lightly played, minor edge wear (fixture data)",
      // AI INTELLIGENCE gap 2: canned fixture evidence, same discipline as
      // the fields above — lets the enrichment/AI-evidence plumbing (and
      // dev environment, which always runs on this provider) be exercised
      // without a live eBay call.
      description: "Pulled from a smoke-free storage box, never played. (fixture data)",
      aspects: [
        { name: "Language", value: "English" },
        { name: "Grade", value: "Ungraded" },
      ],
      rawPayload: { fixture: true },
    };
  }
}
