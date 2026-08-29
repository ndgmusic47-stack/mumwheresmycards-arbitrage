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

  it("fetchSets maps a GET /sets response and parses a 4-digit year out of varied date shapes", async () => {
    const fetchImpl = fetchReturning({
      sets: [
        { code: "base-set", name: "Base Set", releaseYear: 1999 },
        { code: "evolving-skies", name: "Evolving Skies", releaseDate: "2021-08-27" },
      ],
    });

    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    const sets = await provider.fetchSets();
    expect(sets.find((s) => s.setCode === "base-set")?.year).toBe(1999);
    expect(sets.find((s) => s.setCode === "evolving-skies")?.year).toBe(2021);
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = fetchReturning({}, 500);
    const provider = new PokeTraceCatalogueProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    await expect(provider.fetchPage(null)).rejects.toThrow();
  });
});
