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
 * CONFIRMED against a live authenticated call (PHASE 1 smoke test —
 * apps/worker/scripts/poketrace-smoke-test.ts, run against a real
 * Charizard lookup): PokeTrace wraps `GET /cards/{id}` as `{ data: {...} }`,
 * the raw/ungraded tier's real key is "NEAR_MINT", the four PSA tiers this
 * project uses are "PSA_7"/"PSA_8"/"PSA_9"/"PSA_10", each card carries its
 * own `currency` field directly, and the real per-card timestamp field is
 * `lastUpdated` (not `updatedAt`). These fixtures use that real shape —
 * see `envelope()` below for the wrapper.
 */
function pokeTraceCard(overrides: Record<string, unknown> = {}) {
  return {
    id: "pt_charizard_bs_4_102_1st_holo",
    name: "Charizard",
    market: "US",
    currency: "USD",
    lastUpdated: "2026-08-20T00:00:00.000Z",
    prices: {
      ebay: {
        NEAR_MINT: { avg: 3200, low: 2800, high: 3600, saleCount: 14, confidence: 0.82, median7d: 2900 },
        PSA_9: { avg: 10800, saleCount: 6 },
        PSA_10: { avg: 32000, saleCount: 2 },
      },
    },
    ...overrides,
  };
}

/** The confirmed-live envelope PokeTrace wraps a single card in. */
function envelope(card: Record<string, unknown>) {
  return { data: card };
}

describe("PokeTraceProvider", () => {
  it("maps a real-shaped GET /cards/{id} response into a GBP MarketSnapshotResult", async () => {
    const fetchImpl = fetchReturning(envelope(pokeTraceCard()));
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
    expect(snapshot!.priceTimestamp).toBe("2026-08-20T00:00:00.000Z"); // from `lastUpdated`, not fabricated "now"
  });

  it("unwraps PokeTrace's { data: {...} } envelope before reading any field (CONFIRMED live)", async () => {
    // Same fixture, but asserting specifically on the envelope-handling —
    // a regression here would silently make every field below look "missing".
    const fetchImpl = fetchReturning(envelope(pokeTraceCard({ id: "pt_envelope_check" })));
    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.com", fetchImpl });
    const snapshot = await provider.getSnapshotByProviderId("pt_envelope_check");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.rawMarketPrice).not.toBeNull();
  });

  it("uses the confirmed `currency` field directly rather than deriving it from `market`", async () => {
    const fetchImpl = fetchReturning(
      envelope(pokeTraceCard({ market: "US", currency: "EUR", prices: { ebay: { NEAR_MINT: { avg: 100, saleCount: 5 } } } })),
    );
    const provider = new PokeTraceProvider({
      apiKey: "key",
      baseUrl: "https://api.poketrace.com",
      fetchImpl,
      fxRates: { GBP: 1, USD: 0.8, EUR: 0.86 },
    });
    const snapshot = await provider.getSnapshotByProviderId("card-explicit-currency");
    // market says US, but the real `currency` field (EUR) wins.
    expect(snapshot!.sourceCurrency).toBe("EUR");
    expect(snapshot!.rawMarketPrice).toBeCloseTo(86, 1);
  });

  it("falls back to deriving currency from `market` only when `currency` is absent", async () => {
    const fetchImpl = fetchReturning(
      envelope(
        pokeTraceCard({
          market: "EU",
          currency: undefined,
          prices: { cardmarket: { NEAR_MINT: { avg: 100, saleCount: 5 } } },
        }),
      ),
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
      envelope(
        pokeTraceCard({
          prices: {
            tcgplayer: { NEAR_MINT: { avg: 999, saleCount: 1 } },
            ebay: { NEAR_MINT: { avg: 100, saleCount: 10 } },
          },
        }),
      ),
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

  it("returns null when no recognizable tier keys are present in any source (safety net for other, unused grading tiers)", async () => {
    // The real API returns MANY tiers this project doesn't use yet (BGS/CGC/SGC/TAG
    // grading companies, half-point PSA grades) — this proves we don't fabricate a
    // snapshot when only unrecognized tiers like these are present.
    const fetchImpl = fetchReturning(envelope(pokeTraceCard({ prices: { ebay: { BGS_9_5: { avg: 5 } } } })));
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
        json: async () => envelope(pokeTraceCard()),
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
