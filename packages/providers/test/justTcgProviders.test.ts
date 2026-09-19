import { describe, it, expect } from "vitest";
import { JustTcgCatalogueProvider } from "../src/catalogue/JustTcgCatalogueProvider.js";
import { JustTcgMarketProvider, tierKeyFor, splitProviderCardId, variantPrice } from "../src/market/JustTcgMarketProvider.js";
import { mapProviderVariant } from "../src/catalogue/variantMapping.js";

/**
 * JUSTTCG — the second game's data source.
 *
 * These tests pin two different kinds of fact.
 *
 * The first kind was LEARNED FROM LIVE CALLS on 2026-09-19, after the
 * version written from documentation failed against a real key: the request
 * is `card_id` not `cardId`, `graded` is an enum not a boolean, prices live
 * in `variants[].markets[]` in v2, and sealed product arrives through the
 * ordinary card list and has to be filtered by CONDITION because there is
 * no product-type field. Each of those has a named regression guard below.
 *
 * The second kind is what this adapter REFUSES to invent when the data is
 * thin — no interpolated rungs, no fabricated sale counts, no borrowed
 * confidence.
 *
 * The coverage question (does JustTCG's graded data actually reach One
 * Piece, or only the big games?) still cannot be settled here and is
 * deliberately not simulated as though it had been. What is settled here is
 * that a thin answer stays thin all the way through.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function catalogueProvider(body: unknown, capture?: (url: string, init?: RequestInit) => void) {
  return new JustTcgCatalogueProvider({
    apiKey: "tcg_test",
    gameSlug: "one-piece-card-game",
    game: "onepiece",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      capture?.(String(url), init);
      return jsonResponse(body);
    }) as unknown as typeof fetch,
  });
}

describe("the catalogue request is built to the published reference, not from memory", () => {
  it("sends the key in x-api-key and paginates with limit/offset", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const provider = catalogueProvider({ data: [], meta: { hasMore: false } }, (u, i) => {
      seenUrl = u;
      seenInit = i;
    });

    await provider.fetchPage("40", 20);

    const url = new URL(seenUrl);
    expect(url.pathname).toBe("/v1/cards");
    expect(url.searchParams.get("game")).toBe("one-piece-card-game");
    expect(url.searchParams.get("limit")).toBe("20");
    expect(url.searchParams.get("offset")).toBe("40");
    expect((seenInit!.headers as Record<string, string>)["x-api-key"]).toBe("tcg_test");
  });

  /**
   * The slug is configuration, not a constant, because JustTCG does not
   * publish its slug list and this project has already lost a day to a
   * guessed API path. A provider that quietly picked a default would
   * catalogue the wrong game under a correct-looking config.
   */
  it("refuses to be constructed without an explicit game slug", () => {
    expect(
      () => new JustTcgCatalogueProvider({ apiKey: "tcg_test", gameSlug: "", game: "onepiece" }),
    ).toThrow(/gameSlug is required/);
  });

  it("stops when the documented hasMore flag says so", async () => {
    const provider = catalogueProvider({
      data: [card({ id: "c1", variants: [{ printing: "Normal", condition: "Near Mint", price: 1 }] })],
      meta: { hasMore: false },
    });

    const page = await provider.fetchPage(null, 20);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});

function card(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "op01-001",
    name: "Monkey D. Luffy",
    set: "romance-dawn",
    set_name: "Romance Dawn",
    number: "OP01-001",
    rarity: "Leader",
    variants: [],
    ...over,
  };
}

/**
 * THE SHAPE MISMATCH THAT MATTERS. JustTCG models one card with a `variants`
 * array; this project models one row per exact printing, because a foil and
 * a non-foil are different things that sell for different money.
 */
describe("one JustTCG card becomes one row per printing", () => {
  it("splits a card with a foil and a non-foil into two rows with distinct provider ids", async () => {
    const provider = catalogueProvider({
      data: [
        card({
          variants: [
            { printing: "Normal", condition: "Near Mint", price: 4 },
            { printing: "Foil", condition: "Near Mint", price: 40 },
          ],
        }),
      ],
      meta: { hasMore: false },
    });

    const page = await provider.fetchPage(null, 20);

    expect(page.cards).toHaveLength(2);
    expect(page.cards.map((c) => c.providerVariant).sort()).toEqual(["Foil", "Normal"]);
    // Distinct provider ids, or external_card_refs would map both printings
    // onto one internal card and collapse them back together.
    expect(new Set(page.cards.map((c) => c.providerCardId)).size).toBe(2);
    expect(page.cards.every((c) => c.game === "onepiece")).toBe(true);
  });

  it("does not emit a row per condition — condition belongs to a copy, not a printing", async () => {
    const provider = catalogueProvider({
      data: [
        card({
          variants: [
            { printing: "Normal", condition: "Near Mint", price: 4 },
            { printing: "Normal", condition: "Lightly Played", price: 3 },
            { printing: "Normal", condition: "Damaged", price: 1 },
          ],
        }),
      ],
      meta: { hasMore: false },
    });

    const page = await provider.fetchPage(null, 20);
    expect(page.cards).toHaveLength(1);
  });

  /**
   * A PSA 9 copy is the same printing in a slab. Cataloguing it as a card
   * would put ten rows in the catalogue for one card and make every sale
   * count and population figure downstream meaningless.
   */
  it("never catalogues a graded variant as a printing", async () => {
    const provider = catalogueProvider({
      data: [
        card({
          variants: [
            { printing: "Normal", condition: "Near Mint", price: 4 },
            { type: "graded", grading: { company: "PSA", grade: 9 }, price: 120 },
            { type: "graded", grading: { company: "PSA", grade: 10 }, price: 400 },
          ],
        }),
      ],
      meta: { hasMore: false },
    });

    const page = await provider.fetchPage(null, 20);
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]!.providerVariant).toBe("Normal");
  });

  /**
   * The catalogue sync skips unmapped variants on purpose. Emitting a
   * fabricated "Normal" here would route that decision around the very
   * check meant to catch it.
   */
  it("drops a card with no usable printing string rather than inventing one", async () => {
    const provider = catalogueProvider({
      data: [card({ variants: [{ condition: "Near Mint", price: 4 }] })],
      meta: { hasMore: false },
    });

    const page = await provider.fetchPage(null, 20);
    expect(page.cards).toHaveLength(0);
  });

  it("never fabricates a release year for a set that has no parseable date", async () => {
    const provider = new JustTcgCatalogueProvider({
      apiKey: "tcg_test",
      gameSlug: "one-piece-card-game",
      game: "onepiece",
      fetchImpl: (async () =>
        jsonResponse({ data: [{ id: "romance-dawn", name: "Romance Dawn", release_date: null }] })) as unknown as typeof fetch,
    });

    const sets = await provider.fetchSets();
    expect(sets[0]!.year).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────

function marketProvider(body: unknown) {
  return new JustTcgMarketProvider({
    apiKey: "tcg_test",
    // Fixed table so the arithmetic in these tests is checkable by hand.
    fxRates: { USD: 0.5, EUR: 0.5 },
    fetchImpl: (async () => jsonResponse(body)) as unknown as typeof fetch,
  });
}

describe("the graded ladder is only ever as complete as the data", () => {
  /**
   * THE LINE THAT MUST NOT MOVE. The coverage question is unverified: a
   * thin One Piece ladder and a full Pokémon one are the same SHAPE. If
   * this adapter ever starts interpolating, a card with two real prices
   * becomes a card with ten apparent ones, and every break-even grade
   * downstream is computed against rungs nobody observed.
   */
  it("leaves every grade it did not receive as null, and never interpolates between two it did", async () => {
    const snapshot = await marketProvider({
      data: [
        card({
          variants: [
            { printing: "Normal", condition: "Near Mint", price: 10, currency: "USD" },
            { type: "graded", grading: { company: "PSA", grade: 9 }, price: 100, currency: "USD" },
            { type: "graded", grading: { company: "PSA", grade: 10 }, price: 400, currency: "USD" },
          ],
        }),
      ],
    }).getSnapshotByProviderId("op01-001::Normal");

    expect(snapshot!.psa9).toBe(50);
    expect(snapshot!.psa10).toBe(200);
    // The rungs between the raw card and a PSA 9 are exactly as unknown as
    // they were before the call.
    expect(snapshot!.psa6).toBeNull();
    expect(snapshot!.psa7).toBeNull();
    expect(snapshot!.psa8).toBeNull();
  });

  /**
   * PokeTrace publishes a sale count per tier, so a thin number can be SEEN
   * to be thin. JustTCG's documented variant shape does not. Inventing a
   * count would satisfy the one gate built specifically to catch a price
   * with no evidence behind it ("a price with no sales behind it is not a
   * price").
   */
  it("states no sale count rather than inventing one", async () => {
    const snapshot = await marketProvider({
      data: [card({ variants: [{ type: "graded", grading: { company: "PSA", grade: 9 }, price: 100, currency: "USD" }] })],
    }).getSnapshotByProviderId("op01-001::Normal");

    expect(snapshot!.gradedSaleCounts).toEqual({});
    expect(snapshot!.psaSaleCounts).toEqual({});
  });

  /**
   * `confidence` describes the raw card. Presenting it against slab
   * economics is how a PSA 10 backed by 34 sales once came to be displayed
   * at "100% confidence".
   */
  it("says nothing about graded confidence rather than borrowing the raw side's", async () => {
    const snapshot = await marketProvider({
      data: [card({ variants: [{ type: "graded", grading: { company: "PSA", grade: 9 }, price: 100, currency: "USD" }] })],
    }).getSnapshotByProviderId("op01-001::Normal");

    expect(snapshot!.gradedConfidence).toBeNull();
  });

  /**
   * These are market prices, not sold medians, and this project's QSV model
   * is defined on sold medians specifically. Claiming otherwise would let
   * an asking price qualify a trade.
   */
  it("reports no sold medians and flags the QSV as the weaker kind", async () => {
    const snapshot = await marketProvider({
      data: [card({ variants: [{ printing: "Normal", condition: "Near Mint", price: 10, currency: "USD" }] })],
    }).getSnapshotByProviderId("op01-001::Normal");

    expect(snapshot!.rawMedian7d).toBeNull();
    expect(snapshot!.rawMedian30d).toBeNull();
    expect(snapshot!.isHighConfidenceQsv).toBe(false);
    expect(snapshot!.estimatedGrades).toEqual([]);
  });

  it("drops a grader it has no scale for instead of coercing it onto PSA's", async () => {
    const snapshot = await marketProvider({
      data: [
        card({
          variants: [
            { type: "graded", grading: { company: "WOBBLE", grade: 9 }, price: 999, currency: "USD" },
            { type: "graded", grading: { company: "PSA", grade: 9 }, price: 100, currency: "USD" },
          ],
        }),
      ],
    }).getSnapshotByProviderId("op01-001::Normal");

    expect(Object.keys(snapshot!.gradedPrices!)).toEqual(["PSA_9"]);
  });

  /**
   * The raw price is what a card being SENT FOR GRADING costs, so the best
   * available condition is the right one. Taking a median across conditions
   * would price a near-mint submission using played copies.
   */
  it("prices the raw card from the best condition present, not the cheapest", async () => {
    const snapshot = await marketProvider({
      data: [
        card({
          variants: [
            { printing: "Normal", condition: "Damaged", price: 2, currency: "USD" },
            { printing: "Normal", condition: "Near Mint", price: 10, currency: "USD" },
            { printing: "Normal", condition: "Lightly Played", price: 6, currency: "USD" },
          ],
        }),
      ],
    }).getSnapshotByProviderId("op01-001::Normal");

    expect(snapshot!.rawMarketPrice).toBe(5); // 10 USD at 0.5
  });

  it("prices only the printing that was asked for", async () => {
    const snapshot = await marketProvider({
      data: [
        card({
          variants: [
            { printing: "Normal", condition: "Near Mint", price: 10, currency: "USD" },
            { printing: "Foil", condition: "Near Mint", price: 200, currency: "USD" },
          ],
        }),
      ],
    }).getSnapshotByProviderId("op01-001::Normal");

    expect(snapshot!.rawMarketPrice).toBe(5);
  });
});

describe("grade tier keys", () => {
  it("builds a key from the v2 grading block", () => {
    expect(tierKeyFor({ grading: { company: "PSA", grade: 9 } })).toBe("PSA_9");
    expect(tierKeyFor({ grading: { company: "BGS", grade: 9.5 } })).toBe("BGS_9_5");
  });

  /**
   * A PSA 9 with an OC qualifier does not sell for what a clean PSA 9 sells
   * for. Folding them together would put the cheaper card's price on the
   * dearer card's rung.
   */
  it("keeps a qualified grade separate from a clean one", () => {
    expect(tierKeyFor({ grading: { company: "PSA", grade: 9, qualifier: "OC" } })).toBe("PSA_9_OC");
  });

  it("returns null rather than guessing when the block is incomplete", () => {
    expect(tierKeyFor({ grading: { company: "PSA" } })).toBeNull();
    expect(tierKeyFor({ grading: { grade: 9 } })).toBeNull();
    expect(tierKeyFor({})).toBeNull();
  });

  it("round-trips the composite provider id", () => {
    expect(splitProviderCardId("abc::Foil")).toEqual(["abc", "Foil"]);
    expect(splitProviderCardId("abc")).toEqual(["abc", null]);
  });
});

/**
 * The bug this closes: `catalogueSync` ran EVERY card from EVERY provider
 * through PokeTrace's six-value variant enum. With two providers that is
 * not a misnomer, it is a defect — every One Piece card would map to null
 * and be skipped, and the sync would report a clean run that catalogued
 * nothing.
 */
describe("variant vocabulary is chosen by game", () => {
  it("still reads PokéTrace's edition-bearing enum for Pokémon", () => {
    expect(mapProviderVariant("pokemon", "1st_Edition_Holofoil")).toEqual({ edition: "1st", variant: "holo", finish: "na" });
  });

  it("reads the simple Normal/Foil axis for a game that has one", () => {
    expect(mapProviderVariant("onepiece", "Normal")).toEqual({ edition: "na", variant: "normal", finish: "na" });
    expect(mapProviderVariant("onepiece", "Foil")).toEqual({ edition: "na", variant: "holo", finish: "na" });
  });

  it("does not let one game's vocabulary answer for another", () => {
    // PokéTrace's spelling means nothing to One Piece, and One Piece's
    // means nothing to PokéTrace. Both must be refused rather than
    // approximated onto the nearest-looking value.
    expect(mapProviderVariant("onepiece", "1st_Edition_Holofoil")).toBeNull();
    expect(mapProviderVariant("pokemon", "Foil")).toBeNull();
  });

  it("skips an unknown string rather than defaulting it to normal", () => {
    // Mapping an unknown onto "normal" would put the cheap printing's price
    // on the expensive printing's row — the identity collapse, recreated in
    // a new game on day one.
    expect(mapProviderVariant("onepiece", "Manga Alternate Art Parallel")).toBeNull();
    expect(mapProviderVariant("onepiece", null)).toBeNull();
  });
});

/**
 * REGRESSION GUARDS FOR A LIVE 400 — 2026-09-19.
 *
 * The first version of this adapter was written from documentation and was
 * wrong in two ways at once. A real call against a real key returned
 * `400 Bad Request`, which is how we found out.
 *
 * What makes this worth a dedicated block rather than a quiet fix: the
 * failure mode was not a crash. Every card in every game would have come
 * back with an empty ladder, and the tool would have reported "JustTCG has
 * no graded data for One Piece" — confidently, uniformly, and plausibly,
 * because that was the answer we half expected. A wrong negative that
 * matches your prior is the most expensive kind.
 */
describe("the v2 request shape, pinned against the live 400", () => {
  function captureUrl(): { provider: JustTcgMarketProvider; seen: () => string } {
    let url = "";
    const provider = new JustTcgMarketProvider({
      apiKey: "tcg_test",
      fetchImpl: (async (u: string) => {
        url = String(u);
        return jsonResponse({ data: [card({ variants: [] })] });
      }) as unknown as typeof fetch,
    });
    return { provider, seen: () => url };
  }

  it("sends card_id, not cardId — v2 is snake_case throughout", async () => {
    const { provider, seen } = captureUrl();
    await provider.getSnapshotByProviderId("op01-001::Normal");

    const params = new URL(seen()).searchParams;
    expect(params.get("card_id")).toBe("op01-001");
    expect(params.has("cardId")).toBe(false);
  });

  /**
   * `graded` is an enum, not a boolean, and it defaults to `exclude`. So
   * `graded=true` was not merely rejected — had it been silently ignored
   * instead, the adapter would have asked for raw prices only and reported
   * an empty ladder as fact.
   */
  it("sends graded as an enum value, never a boolean", async () => {
    const { provider, seen } = captureUrl();
    await provider.getSnapshotByProviderId("op01-001::Normal");

    const graded = new URL(seen()).searchParams.get("graded");
    expect(["exclude", "only", "include"]).toContain(graded);
    expect(graded).not.toBe("true");
    // `include` specifically: a lookup that omitted graded entirely would
    // get the default, which is `exclude`.
    expect(graded).toBe("include");
  });

  /**
   * The docs say the default region is "NA"; the SDK says "US". Rather
   * than find out which is true in production, the request names one.
   */
  it("names the region explicitly rather than trusting a disputed default", async () => {
    const { provider, seen } = captureUrl();
    await provider.getSnapshotByProviderId("op01-001::Normal");

    expect(new URL(seen()).searchParams.get("regions")).toBe("US");
  });
});

/**
 * v1 put `price` flat on the variant; v2 moved it into a `markets` array,
 * one entry per region. Reading `variant.price` against a v2 response finds
 * nothing AT ALL — silently, producing a priceless card rather than an
 * error. Both shapes are read so the adapter cannot be quietly blinded by
 * which version it is pointed at.
 */
describe("prices are read from wherever the version in use puts them", () => {
  it("reads a v2 price out of the markets array", async () => {
    const snapshot = await marketProvider({
      data: [
        card({
          variants: [
            { printing: "Normal", condition: "Near Mint", markets: [{ region: "US", price: 10, currency: "USD" }] },
            { type: "graded", grading: { company: "PSA", grade: 10 }, markets: [{ region: "US", price: 400, currency: "USD" }] },
          ],
        }),
      ],
    }).getSnapshotByProviderId("op01-001::Normal");

    expect(snapshot!.rawMarketPrice).toBe(5);
    expect(snapshot!.psa10).toBe(200);
  });

  it("still reads a v1 flat price, so pointing at v1 degrades honestly", () => {
    expect(variantPrice({ price: 12, currency: "USD" })).toEqual({ price: 12, currency: "USD" });
  });

  it("returns null rather than zero when no market carries a usable price", () => {
    expect(variantPrice({ markets: [{ region: "US", price: 0 }] })).toBeNull();
    expect(variantPrice({ markets: [] })).toBeNull();
    expect(variantPrice({})).toBeNull();
  });
});

/**
 * SEALED PRODUCT. Found on a live call: two of the first three One Piece
 * results were `Romance Dawn - Booster Box Case (Wave 1 - Blue)` and
 * `(Wave 2 - White)`. Without a filter the tool would put booster box cases
 * in the grading universe and work out the PSA 9 value of a sealed case.
 *
 * There is no product-type field. JustTCG encodes sealed as a CONDITION.
 */
describe("sealed product never enters the catalogue", () => {
  it("asks the API for the five singles conditions and omits Sealed", async () => {
    let seen = "";
    const provider = catalogueProvider({ data: [], meta: { hasMore: false } }, (u) => {
      seen = u;
    });

    await provider.fetchPage(null, 20);

    const condition = new URL(seen).searchParams.get("condition");
    expect(condition).toBe("NM,LP,MP,HP,DMG");
    expect(condition).not.toMatch(/sealed/i);
  });

  /**
   * Belt and braces. The docs state plainly that the `language` filter
   * "never drops a card" and say nothing equivalent for `condition`, so a
   * sealed row arriving anyway is a live possibility rather than paranoia.
   */
  it("drops a card whose only variants are sealed, even if the API returns it", async () => {
    const provider = catalogueProvider({
      data: [
        card({
          name: "Romance Dawn - Booster Box Case (Wave 1 - Blue)",
          variants: [{ printing: "Normal", condition: "Sealed", price: 900 }],
        }),
      ],
      meta: { hasMore: false },
    });

    const page = await provider.fetchPage(null, 20);
    expect(page.cards).toHaveLength(0);
  });

  it("keeps a real card while ignoring a sealed variant attached to it", async () => {
    const provider = catalogueProvider({
      data: [
        card({
          variants: [
            { printing: "Normal", condition: "Near Mint", price: 4 },
            { printing: "Sealed Case", condition: "S", price: 900 },
          ],
        }),
      ],
      meta: { hasMore: false },
    });

    const page = await provider.fetchPage(null, 20);
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]!.providerVariant).toBe("Normal");
  });
});
