import { describe, it, expect } from "vitest";
import {
  rateFor,
  resolveMoney,
  conversionSpreadMissing,
  MoneyInputError,
  type FxSnapshot,
} from "../src/deal/money.js";

/**
 * THE CONVERSION SPREAD — the gap between the published rate and what the
 * money actually costs.
 *
 * `rates` are mid-market. Nobody transacts at mid-market. Without this,
 * every foreign purchase in the system is understated by whatever the bank
 * takes, and it is understated in the direction that makes a deal look
 * better than it is.
 */
describe("conversion spread", () => {
  const midMarket: FxSnapshot = { rates: { GBP: 1, USD: 0.79 }, source: "LIVE", capturedAt: "2026-09-12T00:00:00Z" };
  const withSpread: FxSnapshot = { ...midMarket, conversionSpreadPct: 0.03 };

  it("widens the rate against the buyer, because these are costs being paid", () => {
    // 3% worse than mid-market means MORE pounds per dollar, not fewer.
    expect(rateFor("USD", withSpread)).toBeCloseTo(0.79 * 1.03, 10);
    expect(rateFor("USD", withSpread)!).toBeGreaterThan(rateFor("USD", midMarket)!);
  });

  it("leaves GBP at exactly 1 — nothing is being converted", () => {
    expect(rateFor("GBP", withSpread)).toBe(1);
  });

  it("treats an unset spread as mid-market, and reports it as unset", () => {
    expect(rateFor("USD", midMarket)).toBe(0.79);
    expect(conversionSpreadMissing(midMarket)).toBe(true);
  });

  it("distinguishes a configured zero from an unset spread", () => {
    // "I convert at mid-market" is a claim someone can make; it must not be
    // confused with never having been asked.
    const explicitZero: FxSnapshot = { ...midMarket, conversionSpreadPct: 0 };
    expect(conversionSpreadMissing(explicitZero)).toBe(false);
    expect(rateFor("USD", explicitZero)).toBe(0.79);
  });

  it("rejects a negative spread rather than quietly flattering the cost", () => {
    const negative: FxSnapshot = { ...midMarket, conversionSpreadPct: -0.02 };
    expect(() => rateFor("USD", negative)).toThrow(MoneyInputError);
  });

  it("applies to the resolved amount, so a $100 card costs more than mid-market", () => {
    const resolved = resolveMoney("Purchase price", { amount: 100, currency: "USD", provenance: "CONFIRMED" }, withSpread);
    expect(resolved.gbp).toBe(81.37); // 100 * 0.79 * 1.03 = 81.37
    expect(resolveMoney("Purchase price", { amount: 100, currency: "USD", provenance: "CONFIRMED" }, midMarket).gbp).toBe(79);
  });
});
