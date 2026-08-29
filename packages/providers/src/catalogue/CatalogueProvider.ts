/**
 * One entry from a market-data provider's card CATALOGUE — distinct from
 * `MarketSnapshotResult` (pricing). This is identity/metadata only: what
 * the card IS, not what it's worth. Separating the two interfaces mirrors
 * the real PokeTrace API, which has a paginated `GET /cards` for
 * enumeration and a separate `GET /cards/{id}` for pricing detail on one
 * card at a time.
 *
 * `year` and `language` are intentionally nullable here even though our
 * canonical CardPrinting requires both — PokeTrace's documented Card
 * schema doesn't obviously carry either directly (year is set-level
 * metadata; PokeTrace's `market` dimension is US/EU sales markets, not
 * card language). The catalogue sync engine resolves `year` via a
 * setCode -> year lookup (see `CatalogueProvider.fetchSets`) and currently
 * ASSUMES `language: "EN"` for every PokeTrace-catalogued card (PokeTrace's
 * coverage is English-market TCG singles) — this is a documented
 * assumption to verify with real data, not a guess about any specific
 * card, and a card whose set can't be resolved to a year is skipped by the
 * sync rather than given a fabricated one (see ARCHITECTURE.md).
 */
export interface CatalogueCardDTO {
  providerCardId: string;
  name: string;
  setName: string | null;
  /** Provider's own set slug/id — joined against fetchSets() to resolve year. */
  setCode: string;
  cardNumber: string | null;
  /** Provider's raw variant enum string (e.g. PokeTrace's "1st_Edition_Holofoil") — mapped to our Edition/Variant/Finish by the caller, not this interface. */
  providerVariant: string | null;
  rarity: string | null;
  game: string;
  /** 'US' | 'EU' per PokeTrace's documented market dimension. */
  market: string | null;
  image: string | null;
  providerUpdatedAt: string | null;
}

export interface CatalogueSetInfo {
  setCode: string;
  setName: string;
  year: number | null;
}

export interface CataloguePage {
  cards: CatalogueCardDTO[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The ONE interface the rest of the application depends on for enumerating
 * a provider's full card catalogue. Resolved via
 * packages/providers/src/catalogue/registry.ts — business logic never
 * imports a concrete provider directly.
 */
export interface CatalogueProvider {
  readonly name: string;
  fetchPage(cursor: string | null, limit?: number): Promise<CataloguePage>;
  /** Set metadata (name + release year), used to backfill `year` for
   *  catalogue cards whose provider payload doesn't carry it directly. */
  fetchSets(): Promise<CatalogueSetInfo[]>;
}
