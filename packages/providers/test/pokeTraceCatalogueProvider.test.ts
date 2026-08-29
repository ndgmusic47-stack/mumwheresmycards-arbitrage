import { describe, it, expect, vi } from "vitest";
import { PokeTraceCatalogueProvider } from "../src/catalogue/PokeTraceCatalogueProvider.js";

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: "OK",
    headers: new Headers(),
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("PokeTraceCatalogueProvider", () => {
  it("maps a real-shaped GET /cards response into CatalogueCardDTOs (CONFIRMED live field names)", async () => {
    // CONFIRMED against a live authenticated call (PHASE 1 smoke test —
    // apps/worker/scripts/poketrace-smoke-test.ts): `data` is the array of
    // cards directly (no envelope unwrap needed here, unlike the single-card
    // detail endpoint), and `set` is an object `{ slug, name }`, not a flat
    // string — the previous code treated it as a string and every real
    // card's setCode silently came out as "[object Object]".
    const fetchImpl = fetchReturning({
      data: [
        {
          id: "pt_1",
          name: "Charizard",
          set: { slug: "base-set", name: "Base Set" },
          cardNumber: "4/102",
          variant: "1st_Edition_Holofoil",
          rarity: "Rare Holo",
          game: "pokemon",
          market: "US",
          currency: "USD",
          lastUpdated: "2026-08-20T00:00:00.000Z",
        },
      ],
      pagination: { nextCursor: "abc123", hasMore: true },
    });

    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    const page = await provider.fetchPage(null, 20);

    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]!.providerCardId).toBe("pt_1");
    expect(page.cards[0]!.setCode).toBe("base-set");
    expect(page.cards[0]!.setName).toBe("Base Set");
    expect(page.cards[0]!.providerVariant).toBe("1st_Edition_Holofoil");
    // CONFIRMED live (second smoke test): nextCursor/hasMore are nested
    // under `pagination`, e.g. { hasMore: true, nextCursor: "Mg==", count: 2 }
    // — not at the top level, which is what the code read before this fix.
    expect(page.nextCursor).toBe("abc123");
    expect(page.hasMore).toBe(true);
  });

  it("falls back to flat setCode/setName candidates if `set` isn't an object (defensive, not seen live)", async () => {
    const fetchImpl = fetchReturning({
      cards: [{ id: "pt_1", name: "Charizard", setCode: "base-set", setName: "Base Set" }],
      nextCursor: "abc123",
      hasMore: true,
    });

    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    const page = await provider.fetchPage(null, 20);

    expect(page.cards[0]!.setCode).toBe("base-set");
    expect(page.cards[0]!.setName).toBe("Base Set");
    expect(page.nextCursor).toBe("abc123");
    expect(page.hasMore).toBe(true);
  });

  it("defensively reads alternate field-name candidates (e.g. 'items' instead of 'cards')", async () => {
    const fetchImpl = fetchReturning({
      items: [{ id: "pt_2", name: "Umbreon VMAX", setCode: "evolving-skies", variant: "Holofoil" }],
      has_more: false,
    });

    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    const page = await provider.fetchPage(null, 20);
    expect(page.cards).toHaveLength(1);
    expect(page.cards[0]!.providerCardId).toBe("pt_2");
    expect(page.hasMore).toBe(false);
  });

  it("passes the cursor through as an opaque query parameter", async () => {
    const fetchImpl = fetchReturning({ cards: [], hasMore: false });
    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    await provider.fetchPage("some-opaque-cursor", 20);
    const calledUrl = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(calledUrl).toContain("cursor=some-opaque-cursor");
  });

  it("caps the page limit at 20 per the documented API maximum", async () => {
    const fetchImpl = fetchReturning({ cards: [], hasMore: false });
    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    await provider.fetchPage(null, 500);
    const calledUrl = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(calledUrl).toContain("limit=20");
  });

  it("fetchSets maps a real-shaped GET /sets response (CONFIRMED live field names: slug/name/releaseDate)", async () => {
    const fetchImpl = fetchReturning({
      data: [
        { slug: "151", name: "151", releaseDate: null, cardCount: 403 },
        { slug: "evolving-skies", name: "Evolving Skies", releaseDate: "2021-08-27", cardCount: 237 },
      ],
      pagination: { hasMore: false, nextCursor: null, count: 2 },
    });

    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    const sets = await provider.fetchSets();

    expect(sets).toHaveLength(2);
    // CONFIRMED live: PokeTrace returns `releaseDate: null` for at least some
    // real sets — this must stay null (not fabricated), never fall through
    // to some other guessed value.
    expect(sets.find((s) => s.setCode === "151")?.year).toBeNull();
    expect(sets.find((s) => s.setCode === "evolving-skies")?.year).toBe(2021);
  });

  it("fetchSets still parses alternate field-name candidates (defensive, not seen live)", async () => {
    const fetchImpl = fetchReturning({
      sets: [{ code: "base-set", name: "Base Set", releaseYear: 1999 }],
    });
    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    const sets = await provider.fetchSets();
    expect(sets.find((s) => s.setCode === "base-set")?.year).toBe(1999);
  });

  it("fetchSets pages through ALL sets rather than stopping at the first page (CONFIRMED live: GET /sets paginates too)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => ({
          data: [{ slug: "base-set", name: "Base Set", releaseDate: "1999-01-09" }],
          pagination: { hasMore: true, nextCursor: "Mg==", count: 1 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => ({
          data: [{ slug: "jungle", name: "Jungle", releaseDate: "1999-06-16" }],
          pagination: { hasMore: false, nextCursor: null, count: 1 },
        }),
      }) as unknown as typeof fetch;

    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    const sets = await provider.fetchSets();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sets.map((s) => s.setCode)).toEqual(["base-set", "jungle"]);
    const secondCallUrl = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string;
    expect(secondCallUrl).toContain("cursor=Mg%3D%3D");
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = fetchReturning({}, 500);
    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    await expect(provider.fetchPage(null)).rejects.toThrow();
  });
});
