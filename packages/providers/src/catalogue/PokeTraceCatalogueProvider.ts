import type { CatalogueProvider, CataloguePage, CatalogueCardDTO, CatalogueSetInfo } from "./CatalogueProvider.js";
import { fetchWithBackoff } from "../http/backoff.js";

export interface PokeTraceCatalogueConfig {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * Real PokeTrace catalogue adapter: `GET /cards?product_type=single` for
 * paginated enumeration (cursor-based: `nextCursor`/`hasMore`/`count`, per
 * the verified OpenAPI spec) and `GET /sets` for set-level metadata used to
 * backfill each card's release year.
 *
 * Field-name uncertainty: the spec confirms the QUERY parameters (set,
 * search, card_number, variant, rarity, game, product_type, market, ...)
 * but is less explicit about the exact RESPONSE field names for a few
 * things (e.g. whether a card's set reference comes back as `set`,
 * `setCode`, or `setSlug`; whether the per-card timestamp is `updatedAt`
 * or `lastUpdated`). Rather than hardcode one guess, `readField` below
 * tries a short list of plausible candidates per field and is the single
 * place to fix once verified against a real authenticated response —
 * consistent with the same "don't fabricate, be defensive and transparent"
 * approach used in PokeTraceProvider.ts for the prices tier-key gap.
 */
export class PokeTraceCatalogueProvider implements CatalogueProvider {
  readonly name = "poketrace";

  constructor(private readonly config: PokeTraceCatalogueConfig) {}

  async fetchPage(cursor: string | null, limit = 20): Promise<CataloguePage> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const url = new URL("/v1/cards", this.config.baseUrl);
    url.searchParams.set("product_type", "single");
    url.searchParams.set("game", "pokemon");
    url.searchParams.set("limit", String(Math.min(20, limit))); // spec caps limit at 20
    if (cursor) url.searchParams.set("cursor", cursor);

    const response = await fetchWithBackoff(() =>
      doFetch(url.toString(), { headers: { "X-API-Key": this.config.apiKey, Accept: "application/json" } }),
    );

    if (!response.ok) {
      throw new Error(`PokeTrace GET /cards (catalogue) failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    const items = (readField<unknown[]>(body, ["cards", "items", "results", "data"]) ?? []) as Record<string, unknown>[];

    return {
      cards: items.map(toDTO),
      nextCursor: readField<string>(body, ["nextCursor", "next_cursor"]) ?? null,
      hasMore: readField<boolean>(body, ["hasMore", "has_more"]) ?? false,
    };
  }

  async fetchSets(): Promise<CatalogueSetInfo[]> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const url = new URL("/v1/sets", this.config.baseUrl);
    url.searchParams.set("game", "pokemon");

    const response = await fetchWithBackoff(() =>
      doFetch(url.toString(), { headers: { "X-API-Key": this.config.apiKey, Accept: "application/json" } }),
    );

    if (!response.ok) {
      throw new Error(`PokeTrace GET /sets failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as Record<string, unknown>;
    const items = (readField<unknown[]>(body, ["sets", "items", "results", "data"]) ?? []) as Record<string, unknown>[];

    return items.map((item) => ({
      setCode: String(readField(item, ["code", "setCode", "slug", "id"]) ?? ""),
      setName: String(readField(item, ["name", "setName"]) ?? ""),
      year: parseYear(readField(item, ["releaseYear", "year", "releaseDate", "releasedAt"])),
    }));
  }
}

function toDTO(item: Record<string, unknown>): CatalogueCardDTO {
  return {
    providerCardId: String(readField(item, ["id", "cardId"]) ?? ""),
    name: String(readField(item, ["name"]) ?? ""),
    setName: (readField<string>(item, ["setName", "set_name"]) ?? null) as string | null,
    setCode: String(readField(item, ["set", "setCode", "setSlug", "set_code"]) ?? ""),
    cardNumber: (readField<string>(item, ["cardNumber", "card_number", "number"]) ?? null) as string | null,
    providerVariant: (readField<string>(item, ["variant"]) ?? null) as string | null,
    rarity: (readField<string>(item, ["rarity"]) ?? null) as string | null,
    game: String(readField(item, ["game"]) ?? "pokemon"),
    market: (readField<string>(item, ["market"]) ?? null) as string | null,
    image: (readField<string>(item, ["image", "imageUrl", "image_url"]) ?? null) as string | null,
    providerUpdatedAt: (readField<string>(item, ["updatedAt", "lastUpdated", "updated_at"]) ?? null) as string | null,
  };
}

function readField<T>(obj: Record<string, unknown>, candidates: string[]): T | undefined {
  for (const key of candidates) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key] as T;
  }
  return undefined;
}

function parseYear(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const match = value.match(/\d{4}/);
    if (match) return Number(match[0]);
  }
  return null;
}
