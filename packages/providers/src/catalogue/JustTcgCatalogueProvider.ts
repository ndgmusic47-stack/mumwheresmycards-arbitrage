import type { CatalogueProvider, CataloguePage, CatalogueCardDTO, CatalogueSetInfo } from "./CatalogueProvider.js";

/**
 * JUSTTCG CATALOGUE PROVIDER — the second game's front door.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IS VERIFIED AND WHAT IS NOT. Read this before debugging a 404.
 *
 * VERIFIED against justtcg.com's published API reference:
 *   - Base URL `https://api.justtcg.com/v1`
 *   - Auth header `x-api-key`, keys prefixed `tcg_`
 *   - `GET /cards`, `GET /sets`, `GET /games`
 *   - Pagination is `limit` + `offset`, and the response envelope carries
 *     `meta.hasMore` — NOT a cursor, NOT a page number.
 *   - Card fields: `id`, `name`, `game`, `set`, `set_name`, `rarity`,
 *     `number`, `variants[]`; variant fields include `printing` and
 *     `condition`.
 *   - Set fields: `id`, `name`, `game`, `release_date`.
 *   - Free tier caps `limit` at 20.
 *
 * NOT VERIFIED, and handled defensively for that reason:
 *   - The exact `game` slug for One Piece. The docs never print the full
 *     list. `GET /games` returns it, so this provider is constructed with
 *     whatever slug the caller resolved rather than hardcoding a guess —
 *     see `gameSlug` below. Hardcoding a plausible-looking path is exactly
 *     the mistake that cost this project a day on PokeTrace's `/v1/` prefix.
 *   - Whether JustTCG carries an image field at all. Mapped
 *     best-effort from several candidate names, null when absent, never
 *     fabricated.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A NOTE ON THE FREE TIER. JustTCG documents an `EXCESSIVE_FREE_TIER_USAGE`
 * block that specifically targets free keys called from serverless
 * platforms — Cloudflare Workers by name, which is exactly where this runs.
 * A free key may therefore work locally and be refused in production. That
 * is a billing fact, not a bug in this file, and the error is surfaced
 * verbatim rather than retried.
 */

interface JustTcgConfig {
  apiKey: string;
  /** Override for tests. Defaults to the documented production base. */
  baseUrl?: string;
  /**
   * The provider's own slug for the game to enumerate, e.g.
   * "one-piece-card-game". REQUIRED and not defaulted: this provider does
   * not know which of JustTCG's seventeen games the operator wants, and
   * picking one would silently catalogue the wrong game. Resolve it from
   * `fetchGames()` and pass it in.
   */
  gameSlug: string;
  /** Our canonical Game id the slug corresponds to. Written onto every DTO. */
  game: string;
  /** Free tier caps this at 20. */
  pageSize?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.justtcg.com/v1";

/**
 * JustTCG's documented condition vocabulary is
 * `Sealed | Near Mint | Lightly Played | Moderately Played | Heavily Played
 * | Damaged`, abbreviated `S | NM | LP | MP | HP | DMG`. These are the five
 * that describe a SINGLE CARD; `Sealed` describes a box.
 */
const SINGLES_CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
const DEFAULT_PAGE_SIZE = 20;

export interface JustTcgGameInfo {
  id: string;
  name: string;
}

export class JustTcgCatalogueProvider implements CatalogueProvider {
  readonly name = "justtcg";
  private readonly config: Required<Omit<JustTcgConfig, "fetchImpl">> & { fetchImpl: typeof fetch };

  constructor(config: JustTcgConfig) {
    if (!config.apiKey) throw new Error("JustTcgCatalogueProvider: apiKey is required");
    if (!config.gameSlug) throw new Error("JustTcgCatalogueProvider: gameSlug is required — resolve it from GET /games, never guess it");
    if (!config.game) throw new Error("JustTcgCatalogueProvider: game (our canonical id) is required");

    this.config = {
      apiKey: config.apiKey,
      baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
      gameSlug: config.gameSlug,
      game: config.game,
      pageSize: config.pageSize ?? DEFAULT_PAGE_SIZE,
      fetchImpl: config.fetchImpl ?? fetch,
    };
  }

  /**
   * The call that removes the one guess in this file. Returns JustTCG's own
   * game list so the caller can find the real slug for the game it wants
   * instead of assuming a convention.
   */
  static async fetchGames(config: { apiKey: string; baseUrl?: string; fetchImpl?: typeof fetch }): Promise<JustTcgGameInfo[]> {
    const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const res = await (config.fetchImpl ?? fetch)(`${base}/games`, {
      headers: { "x-api-key": config.apiKey, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`JustTCG GET /games failed: ${res.status} ${await safeText(res)}`);
    const body = (await res.json()) as unknown;
    return asArray(readField(body, ["data", "games"]) ?? body).flatMap((g) => {
      const id = str(readField(g, ["id", "slug"]));
      const name = str(readField(g, ["name"]));
      return id ? [{ id, name: name ?? id }] : [];
    });
  }

  /**
   * `cursor` is our own encoding of JustTCG's numeric offset. It stays an
   * opaque string at this boundary because the sync engine's checkpoint
   * contract says cursors are opaque — nothing outside this class parses it.
   */
  async fetchPage(cursor: string | null, limit?: number): Promise<CataloguePage> {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isFinite(offset) || offset < 0) {
      throw new Error(`JustTcgCatalogueProvider: malformed cursor '${cursor}'`);
    }
    const pageSize = limit ?? this.config.pageSize;

    const url = new URL(`${this.config.baseUrl}/cards`);
    url.searchParams.set("game", this.config.gameSlug);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    // EXCLUDE SEALED PRODUCT. Found on a live call, 2026-09-19: two of the
    // first three One Piece results were `Romance Dawn - Booster Box Case
    // (Wave 1 - Blue)` and `(Wave 2 - White)`. Without this the tool would
    // put booster box cases in the grading universe and compute the PSA 9
    // value of a sealed case.
    //
    // There is no product-type field to filter on. JustTCG encodes sealed
    // as a CONDITION value — its documented condition vocabulary is
    // Sealed | Near Mint | Lightly Played | Moderately Played | Heavily
    // Played | Damaged — so naming the five singles conditions and omitting
    // Sealed is the filter. JustTCG's own SDK examples do exactly this,
    // with the same intent in the comment.
    //
    // Their changelog also explains what we saw: sealed was removed from
    // `cards_count` but is still RETURNED by /cards unless filtered, which
    // is why the games list carries a separate `sealed_count`.
    url.searchParams.set("condition", SINGLES_CONDITIONS.join(","));

    const body = await this.get(url);
    const items = asArray(readField(body, ["data", "cards"]) ?? body);

    const cards = items.flatMap((item) => this.toDto(item));

    // `meta.hasMore` is the documented signal. If it is missing we fall
    // back to "a full page probably means more", which is a guess about
    // pagination and NOT a guess about card data — the worst case is one
    // extra empty request, and the sync's own checkpoint handles it.
    const meta = readField(body, ["meta"]);
    const hasMoreField = readField(meta, ["hasMore", "has_more"]);
    const hasMore = typeof hasMoreField === "boolean" ? hasMoreField : items.length >= pageSize;

    return {
      cards,
      nextCursor: hasMore ? String(offset + items.length) : null,
      hasMore,
    };
  }

  async fetchSets(): Promise<CatalogueSetInfo[]> {
    const url = new URL(`${this.config.baseUrl}/sets`);
    url.searchParams.set("game", this.config.gameSlug);

    const body = await this.get(url);
    return asArray(readField(body, ["data", "sets"]) ?? body).flatMap((s) => {
      const setCode = str(readField(s, ["id", "set_id", "slug"]));
      const setName = str(readField(s, ["name", "set_name"]));
      if (!setCode) return [];
      return [{ setCode, setName: setName ?? setCode, year: parseYear(readField(s, ["release_date", "releaseDate"])) }];
    });
  }

  /**
   * One JustTCG card becomes ONE DTO PER PRINTING, not one per card.
   *
   * This is the shape mismatch that matters. JustTCG models a card as a
   * single object with a `variants` array (normal, foil, and — in v2 —
   * graded slabs). Our catalogue models one row per exact printing, because
   * a foil and a non-foil are different things that sell for different
   * money. Collapsing the array to one row would recreate, in a new game on
   * day one, precisely the identity collapse this project has already spent
   * days chasing in Pokémon.
   *
   * GRADED VARIANTS ARE EXCLUDED HERE. A PSA 9 copy is not a separate
   * printing — it is the same printing in a slab, and it belongs to the
   * PRICE side of the model, not the identity side. Cataloguing it as a
   * card would put ten rows in the catalogue for one card and make every
   * population and sale count meaningless.
   */
  private toDto(item: unknown): CatalogueCardDTO[] {
    const providerCardId = str(readField(item, ["id", "uuid", "cardId"]));
    const name = str(readField(item, ["name"]));
    const setCode = str(readField(item, ["set", "set_id", "setId"]));
    const setName = str(readField(item, ["set_name", "setName"])) ?? setCode;
    const cardNumber = str(readField(item, ["number", "card_number", "cardNumber"]));
    const rarity = str(readField(item, ["rarity"]));
    const image = str(readField(item, ["image_url", "imageUrl", "image"]));
    const updatedAt = str(readField(item, ["lastUpdated", "last_updated", "updated_at"]));

    if (!providerCardId || !name || !setCode) return [];

    const variants = asArray(readField(item, ["variants"]));

    // BELT AND BRACES on the sealed filter. The `condition` query parameter
    // above is documented, but the docs do not say whether it DROPS a
    // non-matching card or returns it with an empty `variants` array — and
    // they are explicit about that distinction for the `language` filter
    // ("never drops a card"), so the silence here is not reassuring.
    //
    // A sealed variant that arrived anyway is refused on its own terms.
    // Cheap, and the alternative is a booster box priced as a card.
    if (variants.some(isSealedVariant) && variants.every((v) => isSealedVariant(v))) return [];

    // Distinct printing strings only — JustTCG repeats a printing once per
    // condition (Near Mint, Lightly Played, ...), and condition is a
    // property of one physical copy, not of the printing. Deduping here
    // stops a single card producing eight identical catalogue rows.
    const printings = new Set<string>();
    for (const v of variants) {
      if (isGradedVariant(v)) continue;
      if (isSealedVariant(v)) continue;
      const printing = str(readField(v, ["printing"]));
      if (printing) printings.add(printing);
    }

    // A card with no usable printing string is NOT defaulted to "Normal".
    // The catalogue sync skips unmapped variants by design; emitting a
    // fabricated "Normal" here would route that decision around the very
    // check meant to catch it.
    if (printings.size === 0) return [];

    return [...printings].map((providerVariant) => ({
      // The provider id must stay unique per printing, because
      // external_card_refs maps provider id -> our card id and a shared id
      // would collapse the foil and the non-foil onto one row.
      providerCardId: `${providerCardId}::${providerVariant}`,
      name,
      setName,
      setCode,
      cardNumber: cardNumber ?? null,
      providerVariant,
      rarity: rarity ?? null,
      game: this.config.game,
      // JustTCG v1 has no US/EU market dimension; null is the honest value.
      market: null,
      image: image ?? null,
      providerUpdatedAt: updatedAt ?? null,
    }));
  }

  private async get(url: URL): Promise<unknown> {
    const res = await this.config.fetchImpl(url.toString(), {
      headers: { "x-api-key": this.config.apiKey, accept: "application/json" },
    });
    if (!res.ok) {
      // Surfaced verbatim, never retried blind: 429 needs backoff the
      // caller controls, and EXCESSIVE_FREE_TIER_USAGE is a plan problem
      // that retrying converts into a longer block.
      throw new Error(`JustTCG ${url.pathname} failed: ${res.status} ${await safeText(res)}`);
    }
    return res.json();
  }
}

/**
 * v2 marks graded variants with a `grading` object and `type: "graded"`.
 * v1 has neither, so this is false for every v1 variant — which is correct,
 * because v1 returns no graded data at all.
 */
function isGradedVariant(v: unknown): boolean {
  if (readField(v, ["grading"]) != null) return true;
  return str(readField(v, ["type"]))?.toLowerCase() === "graded";
}

/** Sealed product, which JustTCG encodes as a condition rather than a type. */
export function isSealedVariant(v: unknown): boolean {
  const condition = str(readField(v, ["condition"]))?.toLowerCase();
  return condition === "sealed" || condition === "s";
}

function readField(obj: unknown, names: string[]): unknown {
  if (obj == null || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const n of names) {
    if (rec[n] !== undefined && rec[n] !== null) return rec[n];
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** Never fabricates a year — a set with no parseable release date gets null. */
function parseYear(value: unknown): number | null {
  const s = str(value);
  if (!s) return null;
  const m = /(\d{4})/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 1990 && year <= 2100 ? year : null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}
