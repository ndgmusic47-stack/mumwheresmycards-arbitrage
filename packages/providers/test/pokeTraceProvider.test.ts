import { describe, it, expect, vi } from "vitest";
import { PokeTraceProvider } from "../src/market/PokeTraceProvider.js";

function fetchReturning(body: unknown, status = 200, headers: Record<string, string> = {}): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : status === 429 ? "Too Many Requests" : "OK",
    headers: new Headers(headers),
    json: async () => body,
  }) as unknown as typeof fetch;
}

/**
 * These fixtures use the VERIFIED PokeTrace Card/TierPrice shape from the
 * real OpenAPI spec (prices[source][tier] -> {avg, saleCount, ...}) with
 * "raw"/"psa_N" as the tier keys under test — the most-likely candidates
 * per PokeTraceProvider's documented-gap comment. If PokeTrace's real
 * casing differs once verified against a live key, only the adapter's
 * candidate list needs updating, not these tests' intent.
 */
function pokeTraceCard(overrides: Record<string, unknown> = {}) {
  return {
    id: "pt_charizard_bs_4_102_1st_holo",
    name: "Charizard",
    market: "US",
    updatedAt: "2026-08-20T00:00:00.000Z",
    prices: {
      ebay: {
        raw: { avg: 3200, low: 2800, high: 3600, saleCount: 14, confidence: 0.82, median7d: 2900 },
        psa_9: { avg: 10800, saleCount: 6 },
        psa_10: { avg: 32000, saleCount: 2 },
      },
    },
    ...overrides,
  };
}

describe("PokeTraceProvider", () => {
  it("maps a real-shaped GET /cards/{id} response into a GBP MarketSnapshotResult", async () => {
    const fetchImpl = fetchReturning(pokeTraceCard());
    const provider = new PokeTraceProvider({
      apiKey: "key",
      baseUrl: "https://api.poketrace.com",
      fetchImpl,
      fxRates: { GBP: 1, USD: 0.8, EUR: 0.86 },
    });

    const snapshot = await provider.getSnapshotByProviderId("pt_charizard_bs_4_102_1st_holo");

    expect(snapshot).not.toBeNull();
    expect(snapshot!.providerCardId).toBe("pt_charizard_bs_4_102_1st_holo");
    expect(snapshot!.sourceCurrency).toBe("USD");
    expect(snapshot!.rawMarketPrice).toBeCloseTo(3200 * 0.8, 1); // GBP-converted
    expect(snapshot!.rawQsv).toBeCloseTo(2900 * 0.8, 1); // median7d preferred over avg for QSV
    expect(snapshot!.psa9).toBeCloseTo(10800 * 0.8, 1);
    expect(snapshot!.psa10).toBeCloseTo(32000 * 0.8, 1);
    expect(snapshot!.sampleSize).toBe(14);
  });

  it("converts EUR-market cards using the EUR rate", async () => {
    const fetchImpl = fetchReturning(
      pokeTraceCard({
        market: "EU",
        prices: { cardmarket: { raw: { avg: 100, saleCount: 5 } } },
      }),
    );
    const provider = new PokeTraceProvider({
      apiKey: "key",
      baseUrl: "https://api.poketrace.com",
      fetchImpl,
      fxRates: { GBP: 1, USD: 0.8, EUR: 0.86 },
    });

    const snapshot = await provider.getSnapshotByProviderId("card-eu");
    expect(snapshot!.sourceCurrency).toBe("EUR");
    expect(snapshot!.rawMarketPrice).toBeCloseTo(86, 1);
  });

  it("prefers the 'ebay' price source over others when multiple sources are present", async () => {
    const fetchImpl = fetchReturning(
      pokeTraceCard({
        prices: {
          tcgplayer: { raw: { avg: 999, saleCount: 1 } },
          ebay: { raw: { avg: 100, saleCount: 10 } },
        },
      }),
    );
    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    const snapshot = await provider.getSnapshotByProviderId("card-multi-source");
    expect(snapshot!.rawMarketPrice).toBeCloseTo(100 * 0.79, 1); // default USD rate
  });

  it("returns null on a 404 (no data for this provider card id) rather than throwing", async () => {
    const fetchImpl = fetchReturning({}, 404);
    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    expect(await provider.getSnapshotByProviderId("unknown")).toBeNull();
  });

  it("returns null when no recognizable tier keys are present in any source (documented-gap safety net)", async () => {
    const fetchImpl = fetchReturning(pokeTraceCard({ prices: { ebay: { some_unexpected_tier: { avg: 5 } } } }));
    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    expect(await provider.getSnapshotByProviderId("card-unrecognized-tiers")).toBeNull();
  });

  it("throws on a non-404, non-429 error response", async () => {
    const fetchImpl = fetchReturning({}, 500);
    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    await expect(provider.getSnapshotByProviderId("card")).rejects.toThrow();
  });

  it("retries with backoff on a 429 and succeeds on the next attempt", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: new Headers({ "Retry-After": "0" }),
        json: async () => ({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        json: async () => pokeTraceCard(),
      }) as unknown as typeof fetch;

    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    const snapshot = await provider.getSnapshotByProviderId("pt_charizard_bs_4_102_1st_holo");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(snapshot).not.toBeNull();
  });

  it("gives up and throws after exceeding the max retry count on persistent 429s", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: new Headers({ "Retry-After": "0" }),
      json: async () => ({}),
    }) as unknown as typeof fetch;

    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    await expect(provider.getSnapshotByProviderId("card")).rejects.toThrow(/Rate limit exceeded/);
  });
});
