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
 * things. Rather than hardcode one guess, `readField` below tries a short
 * list of plausible candidates per field and is the single place to fix
 * once verified against a real authenticated response — consistent with
 * the same "don't fabricate, be defensive and transparent" approach used
 * in PokeTraceProvider.ts for the prices tier-key gap.
 *
 * CONFIRMED against a live authenticated call (PHASE 1 smoke test, see
 * apps/worker/scripts/poketrace-smoke-test.ts):
 * - `id`, `name`, `cardNumber`, `variant`, `rarity`, `game`, `market`,
 *   `image`, `lastUpdated` are all exactly as this file already guessed.
 * - `set` is NOT a flat string — it's an object, `{ slug, name }` (e.g.
 *   `{"slug":"base-set","name":"Base Set"}`). The previous version of
 *   `toDTO` treated it as a string candidate for `setCode`, which meant
 *   `setCode` was silently coming out as the literal text
 *   `"[object Object]"` for every real card — a real bug, now fixed below
 *   (`readSetRef`).
 * - Each card also carries `currency` directly (handled in
 *   PokeTraceProvider.ts, not needed on this identity-only DTO).
 *
 * STILL NOT VERIFIED: `GET /sets` response field names (not exercised by
 * the smoke test), and the exact `pagination` object shape for
 * `nextCursor`/`hasMore` on `GET /cards` — the smoke test's tiny
 * single-page sample didn't need to page, so this wasn't confirmed either.
 * Both keep their original candidate-list guesses below.
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
  const { setCode, setName } = readSetRef(item);
  return {
    providerCardId: String(readField(item, ["id", "cardId"]) ?? ""),
    name: String(readField(item, ["name"]) ?? ""),
    setName,
    setCode,
    cardNumber: (readField<string>(item, ["cardNumber", "card_number", "number"]) ?? null) as string | null,
    providerVariant: (readField<string>(item, ["variant"]) ?? null) as string | null,
    rarity: (readField<string>(item, ["rarity"]) ?? null) as string | null,
    game: String(readField(item, ["game"]) ?? "pokemon"),
    market: (readField<string>(item, ["market"]) ?? null) as string | null,
    image: (readField<string>(item, ["image", "imageUrl", "image_url"]) ?? null) as string | null,
    providerUpdatedAt: (readField<string>(item, ["updatedAt", "lastUpdated", "updated_at"]) ?? null) as string | null,
  };
}

/**
 * CONFIRMED live: `set` is an object `{ slug, name }`, not a flat string
 * (see class doc-comment). Handles that real shape first; falls back to
 * the original flat-string/alternate-key guesses for any card that might
 * not follow it, rather than assuming every response is identical.
 */
function readSetRef(item: Record<string, unknown>): { setCode: string; setName: string | null } {
  const setRef = item.set;
  if (setRef && typeof setRef === "object" && !Array.isArray(setRef)) {
    const setObj = setRef as Record<string, unknown>;
    const setCode = String(readField(setObj, ["slug", "code", "id"]) ?? "");
    const setName = (readField<string>(setObj, ["name"]) ?? null) as string | null;
    if (setCode || setName) return { setCode, setName };
  }
  return {
    setCode: String(readField(item, ["setCode", "setSlug", "set_code"]) ?? ""),
    setName: (readField<string>(item, ["setName", "set_name"]) ?? null) as string | null,
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
