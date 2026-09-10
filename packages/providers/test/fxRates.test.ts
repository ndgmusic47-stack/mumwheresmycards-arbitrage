import { describe, it, expect } from "vitest";
import {
  parseGbpBasedRates,
  fetchLiveFxRates,
  isFxRefreshDue,
  isPlausibleRate,
  FX_REFRESH_AFTER_HOURS,
  type FxRatesMeta,
} from "../src/market/FxRatesProvider.js";
import { convertToGbp, DEFAULT_FX_RATES } from "@mwmc/core";

/**
 * REGRESSION GUARD for the live FX feed (2026-09-10).
 *
 * THIS CODE WAS WRITTEN BLIND. The sandbox it was developed in cannot reach
 * the FX provider, so the parsing was written against documentation rather
 * than a verified live response. That makes these tests the only thing
 * standing between a misread response and every price in the tool being
 * wrong by a constant factor — which is exactly the failure mode that is
 * hardest to notice, because everything stays internally consistent.
 *
 * THE INVERSION IS THE DANGEROUS PART. We query with GBP as the base, so
 * `rates.USD` means "1 GBP buys N dollars" (~1.27). FxRates stores the
 * opposite: "1 dollar is worth N pounds" (~0.79). Storing the API's number
 * directly would inflate every USD-priced card by ~1.6x and every grading
 * profit with it. The first test below exists solely to pin that down.
 */
describe("the GBP inversion — the one that would silently inflate every price", () => {
  it("turns '1 GBP buys 1.2658 USD' into 'USD is worth 0.79 GBP'", () => {
    const table = parseGbpBasedRates({ base: "GBP", rates: { USD: 1.2658, EUR: 1.1628 } });
    expect(table).not.toBeNull();
    expect(table!.USD).toBeCloseTo(0.79, 3);
    expect(table!.EUR).toBeCloseTo(0.86, 3);
  });

  it("produces a rate BELOW 1 for a currency weaker than sterling — never above", () => {
    const table = parseGbpBasedRates({ base: "GBP", rates: { USD: 1.3, EUR: 1.2 } })!;
    expect(table.USD).toBeLessThan(1);
    expect(table.EUR).toBeLessThan(1);
  });

  it("feeds convertToGbp correctly end to end: $100 becomes about £79", () => {
    const table = parseGbpBasedRates({ base: "GBP", rates: { USD: 1.2658, EUR: 1.1628 } })!;
    expect(convertToGbp(100, "USD", table)).toBeCloseTo(79, 0);
    expect(convertToGbp(100, "EUR", table)).toBeCloseTo(86, 0);
  });

  it("always pins GBP to exactly 1", () => {
    expect(parseGbpBasedRates({ base: "GBP", rates: { USD: 1.27, EUR: 1.16 } })!.GBP).toBe(1);
  });
});

describe("it refuses anything it does not fully understand", () => {
  it("rejects a response based on a currency other than GBP", () => {
    // If the request didn't do what we think, the numbers mean something
    // else entirely — refuse rather than convert with them.
    expect(parseGbpBasedRates({ base: "USD", rates: { GBP: 0.79 } })).toBeNull();
  });

  it("rejects a partial table rather than filling the gap", () => {
    expect(parseGbpBasedRates({ base: "GBP", rates: { USD: 1.27 } })).toBeNull();
  });

  it("rejects rates that are not numbers", () => {
    expect(parseGbpBasedRates({ base: "GBP", rates: { USD: "1.27", EUR: 1.16 } })).toBeNull();
  });

  it("rejects implausible values that are clearly not exchange rates", () => {
    expect(parseGbpBasedRates({ base: "GBP", rates: { USD: 0, EUR: 1.16 } })).toBeNull();
    expect(parseGbpBasedRates({ base: "GBP", rates: { USD: 200, EUR: 1.16 } })).toBeNull();
    expect(parseGbpBasedRates({ base: "GBP", rates: { USD: NaN, EUR: 1.16 } })).toBeNull();
  });

  it("rejects junk shapes without throwing", () => {
    for (const junk of [null, undefined, 42, "rates", [], {}, { rates: null }, { rates: "USD" }]) {
      expect(() => parseGbpBasedRates(junk)).not.toThrow();
      expect(parseGbpBasedRates(junk)).toBeNull();
    }
  });

  it("accepts the shape with no `base` field at all, since both documented forms vary", () => {
    expect(parseGbpBasedRates({ rates: { USD: 1.27, EUR: 1.16 } })).not.toBeNull();
  });

  it("isPlausibleRate bounds are wide enough for any real move, tight enough to catch nonsense", () => {
    expect(isPlausibleRate(0.79)).toBe(true);
    expect(isPlausibleRate(1.27)).toBe(true);
    expect(isPlausibleRate(0)).toBe(false);
    expect(isPlausibleRate(-1)).toBe(false);
    expect(isPlausibleRate(1000)).toBe(false);
    expect(isPlausibleRate("0.79")).toBe(false);
  });
});

describe("a failed refresh never damages the table it already has", () => {
  const previous = { GBP: 1, USD: 0.79, EUR: 0.86 };

  it("returns the previous rates on a non-200", async () => {
    const result = await fetchLiveFxRates(previous, {
      fetchImpl: (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch,
    });
    expect(result.source).toBe("FALLBACK");
    expect(result.rates).toEqual(previous);
    expect(result.error).toContain("503");
  });

  it("returns the previous rates when the network throws", async () => {
    const result = await fetchLiveFxRates(previous, {
      fetchImpl: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(result.source).toBe("FALLBACK");
    expect(result.rates).toEqual(previous);
  });

  it("returns the previous rates when the body parses but makes no sense", async () => {
    const result = await fetchLiveFxRates(previous, {
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ message: "quota exceeded" }) })) as unknown as typeof fetch,
    });
    expect(result.source).toBe("FALLBACK");
    expect(result.rates).toEqual(previous);
    expect(result.error).toContain("usable");
  });

  it("never throws, whatever the fetch does", async () => {
    await expect(
      fetchLiveFxRates(previous, {
        fetchImpl: (async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } })) as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ source: "FALLBACK" });
  });

  it("reports LIVE and the new table on success", async () => {
    const result = await fetchLiveFxRates(previous, {
      fetchImpl: (async () => ({ ok: true, status: 200, json: async () => ({ base: "GBP", rates: { USD: 1.3333, EUR: 1.25 } }) })) as unknown as typeof fetch,
    });
    expect(result.source).toBe("LIVE");
    expect(result.rates.USD).toBeCloseTo(0.75, 3);
    expect(result.rates.EUR).toBeCloseTo(0.8, 3);
  });

  it("requests GBP as the base — the inversion above depends on it", async () => {
    let requested = "";
    await fetchLiveFxRates(previous, {
      fetchImpl: (async (url: string) => {
        requested = url;
        return { ok: true, status: 200, json: async () => ({ base: "GBP", rates: { USD: 1.27, EUR: 1.16 } }) };
      }) as unknown as typeof fetch,
    });
    expect(requested).toContain("from=GBP");
    expect(requested).toContain("USD");
    expect(requested).toContain("EUR");
  });
});

describe("it calls the provider about once a day, not every scan", () => {
  const now = new Date("2026-09-10T12:00:00.000Z");
  const meta = (lastFetchedAt: string | null): FxRatesMeta => ({
    lastFetchedAt,
    lastSuccessAt: lastFetchedAt,
    source: "LIVE",
  });

  it("is due when it has never run", () => {
    expect(isFxRefreshDue(null, now)).toBe(true);
    expect(isFxRefreshDue(meta(null), now)).toBe(true);
  });

  it("is NOT due half an hour later — that is the 30-minute cron, not a new day", () => {
    expect(isFxRefreshDue(meta("2026-09-10T11:30:00.000Z"), now)).toBe(false);
  });

  it(`is due after ${FX_REFRESH_AFTER_HOURS} hours`, () => {
    expect(isFxRefreshDue(meta("2026-09-09T15:59:00.000Z"), now)).toBe(true);
    expect(isFxRefreshDue(meta("2026-09-09T16:30:00.000Z"), now)).toBe(false);
  });

  it("does not drift past a whole day: 20h means every calendar day gets one", () => {
    // A 24h gate plus a 30-minute cron creeps later each day until a day is
    // skipped. 20h cannot.
    expect(FX_REFRESH_AFTER_HOURS).toBeLessThan(24);
  });

  it("treats an unparseable timestamp as due rather than never refreshing again", () => {
    expect(isFxRefreshDue(meta("not-a-date"), now)).toBe(true);
  });

  it("accepts a D1 space-separated datetime", () => {
    expect(isFxRefreshDue(meta("2026-09-10 11:30:00"), now)).toBe(false);
    expect(isFxRefreshDue(meta("2026-09-08 11:30:00"), now)).toBe(true);
  });
});

describe("the hardcoded fallback table is still sane", () => {
  it("is what the tool falls back to, so it must at least be the right shape", () => {
    expect(DEFAULT_FX_RATES.GBP).toBe(1);
    expect(isPlausibleRate(DEFAULT_FX_RATES.USD)).toBe(true);
    expect(isPlausibleRate(DEFAULT_FX_RATES.EUR)).toBe(true);
  });
});
