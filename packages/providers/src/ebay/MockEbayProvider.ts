import type { EbayListingsProvider, EbaySearchQuery, RawEbayListing } from "./EbayListingsProvider.js";
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
}
