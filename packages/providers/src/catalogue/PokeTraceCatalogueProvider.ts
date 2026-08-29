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
 * CONFIRMED against a second live call (PHASE 1 pagination/sets smoke test,
 * see apps/worker/scripts/poketrace-catalogue-smoke-test.ts):
 * - The real `pagination` object is `{ hasMore, nextCursor, count }`,
 *   NESTED under a top-level `pagination` key — e.g.
 *   `{ "hasMore": true, "nextCursor": "Mg==", "count": 2 }`. The previous
 *   version of this file read `nextCursor`/`hasMore` at the TOP level of
 *   the response, which doesn't exist there — a real bug (`fetchPage`
 *   would always report `hasMore: false`, silently stopping a catalogue
 *   sync after one page). Fixed below: checks `body.pagination.*` first,
 *   falls back to the top level defensively. Verified against two live
 *   pages of real cards with no duplicate ids between them.
 * - `GET /sets` returns the same `{ data: [...], pagination: {...} }`
 *   envelope as `GET /cards` — confirmed it also has `hasMore`/`nextCursor`
 *   (a real catalogue of ~150-200 Pokémon sets won't all fit on one page),
 *   so `fetchSets()` below now pages through all of it instead of silently
 *   returning only the first page.
 * - Each set's real fields are `slug`, `name`, `releaseDate`, `cardCount`.
 *   `slug`/`name` were already being found correctly (via fallback
 *   candidates). `releaseDate` is real, but PokeTrace returns `null` for it
 *   on at least some real sets sampled (e.g. "151", "Ancient Origins") —
 *   this project does NOT fabricate a year for those; `year` stays `null`
 *   and the catalogue sync already skips year-less cards rather than
 *   guessing (see ARCHITECTURE.md) — this is a genuine PokeTrace data gap,
 *   not a bug in this file.
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
    const { nextCursor, hasMore } = readPagination(body);

    return { cards: items.map(toDTO), nextCursor, hasMore };
  }

  /**
   * CONFIRMED live: paginated the same way as `fetchPage` (see class
   * doc-comment) — loops until `hasMore` is false so callers get the FULL
   * set list, not just the first page. `MAX_PAGES` is only a safety valve
   * against an infinite loop on a malformed response, not a business rule
   * — Pokémon has on the order of 150-200 sets, comfortably under it.
   */
  async fetchSets(): Promise<CatalogueSetInfo[]> {
    const doFetch = this.config.fetchImpl ?? fetch;
    const allSets: CatalogueSetInfo[] = [];
    const MAX_PAGES = 50;

    let cursor: string | null = null;
    let page = 0;
    do {
      const url = new URL("/v1/sets", this.config.baseUrl);
      url.searchParams.set("game", "pokemon");
      if (cursor) url.searchParams.set("cursor", cursor);

      const response = await fetchWithBackoff(() =>
        doFetch(url.toString(), { headers: { "X-API-Key": this.config.apiKey, Accept: "application/json" } }),
      );
      if (!response.ok) {
        throw new Error(`PokeTrace GET /sets failed: ${response.status} ${response.statusText}`);
      }

      const body = (await response.json()) as Record<string, unknown>;
      const items = (readField<unknown[]>(body, ["sets", "items", "results", "data"]) ?? []) as Record<string, unknown>[];
      allSets.push(...items.map(toSetInfo));

      const pagination = readPagination(body);
      cursor = pagination.hasMore ? pagination.nextCursor : null;
      page++;
    } while (cursor && page < MAX_PAGES);

    return allSets;
  }
}

function toSetInfo(item: Record<string, unknown>): CatalogueSetInfo {
  return {
    setCode: String(readField(item, ["slug", "code", "setCode", "id"]) ?? ""),
    setName: String(readField(item, ["name", "setName"]) ?? ""),
    // CONFIRMED live: the real field is `releaseDate`, but PokeTrace returns
    // `null` for it on at least some real sets — `readField` already skips
    // null values, so this correctly stays `null` (not fabricated) rather
    // than silently falling through to a wrong candidate.
    year: parseYear(readField(item, ["releaseDate", "releaseYear", "year", "releasedAt"])),
  };
}

/**
 * CONFIRMED live: `nextCursor`/`hasMore` are nested under a top-level
 * `pagination` object (`{ hasMore, nextCursor, count }`), not at the top
 * level directly — checked first here; the top-level check remains only as
 * a defensive fallback for a response shape that might not match.
 */
function readPagination(body: Record<string, unknown>): { nextCursor: string | null; hasMore: boolean } {
  const pagination = (body.pagination && typeof body.pagination === "object" ? body.pagination : {}) as Record<string, unknown>;
  return {
    nextCursor: readField<string>(pagination, ["nextCursor", "next_cursor"]) ?? readField<string>(body, ["nextCursor", "next_cursor"]) ?? null,
    hasMore: readField<boolean>(pagination, ["hasMore", "has_more"]) ?? readField<boolean>(body, ["hasMore", "has_more"]) ?? false,
  };
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
