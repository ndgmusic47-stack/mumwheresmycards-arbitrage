import { describe, it, expect, vi } from "vitest";
import { resolveCardPrinting } from "@mwmc/core";
import { PokeTraceProvider } from "../src/market/PokeTraceProvider.js";

const printing = resolveCardPrinting({
  game: "pokemon",
  name: "Charizard",
  setName: "Base Set",
  setCode: "BS",
  cardNumber: "4/102",
  year: 1999,
  language: "EN",
  edition: "1st",
  variant: "holo",
  finish: "shadowless",
  rarity: "Holo Rare",
}).printing!;

function fetchReturning(body: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("PokeTraceProvider", () => {
  it("maps sold comps into a MarketSnapshotResult with median prices per grade", async () => {
    const fetchImpl = fetchReturning({
      comps: [
        { price: 100, grade: "raw", soldAt: "2026-08-01T00:00:00.000Z" },
        { price: 110, grade: "raw", soldAt: "2026-08-05T00:00:00.000Z" },
        { price: 105, grade: "raw", soldAt: "2026-08-10T00:00:00.000Z" },
        { price: 108, grade: "raw", soldAt: "2026-08-12T00:00:00.000Z" },
        { price: 300, grade: "PSA9", soldAt: "2026-08-11T00:00:00.000Z" },
        { price: 900, grade: "PSA10", soldAt: "2026-08-15T00:00:00.000Z" },
      ],
      psaPopulation: { psa9: 100, psa10: 20 },
      gemRate: 0.05,
    });

    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.example", fetchImpl });
    const snapshot = await provider.getSnapshot(printing);

    expect(snapshot).not.toBeNull();
    expect(snapshot!.rawMarketPrice).toBeCloseTo(106.5, 1); // median of 100,105,108,110
    expect(snapshot!.psa9).toBe(300);
    expect(snapshot!.psa10).toBe(900);
    expect(snapshot!.sampleSize).toBe(6);
    expect(snapshot!.historicalGemRate).toBe(0.05);
  });

  it("excludes IQR outliers from raw comps before computing rawMarketPrice", async () => {
    const fetchImpl = fetchReturning({
      comps: [
        { price: 100, grade: "raw", soldAt: "2026-08-01T00:00:00.000Z" },
        { price: 102, grade: "raw", soldAt: "2026-08-02T00:00:00.000Z" },
        { price: 98, grade: "raw", soldAt: "2026-08-03T00:00:00.000Z" },
        { price: 101, grade: "raw", soldAt: "2026-08-04T00:00:00.000Z" },
        { price: 5000, grade: "raw", soldAt: "2026-08-05T00:00:00.000Z" }, // outlier
      ],
    });

    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.example", fetchImpl });
    const snapshot = await provider.getSnapshot(printing);

    expect(snapshot!.outliersExcluded).toBeGreaterThanOrEqual(1);
    expect(snapshot!.rawMarketPrice).toBeLessThan(200);
  });

  it("returns null on a 404 (no data for this printing) rather than throwing", async () => {
    const fetchImpl = fetchReturning({}, 404);
    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.example", fetchImpl });
    expect(await provider.getSnapshot(printing)).toBeNull();
  });

  it("returns null when comps array is empty", async () => {
    const fetchImpl = fetchReturning({ comps: [] });
    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.example", fetchImpl });
    expect(await provider.getSnapshot(printing)).toBeNull();
  });

  it("throws on a non-404 error response", async () => {
    const fetchImpl = fetchReturning({}, 500);
    const provider = new PokeTraceProvider({ apiKey: "key", baseUrl: "https://api.poketrace.example", fetchImpl });
    await expect(provider.getSnapshot(printing)).rejects.toThrow();
  });
});
