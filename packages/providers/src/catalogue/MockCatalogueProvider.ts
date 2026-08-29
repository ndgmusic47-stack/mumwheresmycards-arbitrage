import type { CatalogueProvider, CataloguePage, CatalogueSetInfo } from "./CatalogueProvider.js";
import { CATALOGUE_CARD_FIXTURES, CATALOGUE_SET_FIXTURES } from "../fixtures/catalogue.fixtures.js";

/**
 * Fixture-backed CatalogueProvider — paginates over a fixed, small fixture
 * list using a simple numeric-offset cursor (encoded as a string, since
 * real provider cursors are opaque strings too — nothing downstream should
 * ever parse cursor contents). Default provider for local dev/tests; never
 * touches the network.
 */
export class MockCatalogueProvider implements CatalogueProvider {
  readonly name = "mock";

  async fetchPage(cursor: string | null, limit = 2): Promise<CataloguePage> {
    const offset = cursor ? Number(cursor) : 0;
    const page = CATALOGUE_CARD_FIXTURES.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    const hasMore = nextOffset < CATALOGUE_CARD_FIXTURES.length;

    return {
      cards: page,
      nextCursor: hasMore ? String(nextOffset) : null,
      hasMore,
    };
  }

  async fetchSets(): Promise<CatalogueSetInfo[]> {
    return CATALOGUE_SET_FIXTURES;
  }
}
