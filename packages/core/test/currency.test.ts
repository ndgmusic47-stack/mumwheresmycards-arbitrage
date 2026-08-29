import { describe, it, expect } from "vitest";
import { convertToGbp, DEFAULT_FX_RATES } from "../src/market/currency.js";

describe("convertToGbp", () => {
  it("passes GBP amounts through unchanged", () => {
    expect(convertToGbp(100, "GBP")).toBe(100);
    expect(convertToGbp(100, "gbp")).toBe(100);
  });

  it("converts USD to GBP using the provided rate", () => {
    expect(convertToGbp(100, "USD", { GBP: 1, USD: 0.8 })).toBe(80);
  });

  it("converts EUR to GBP using the provided rate", () => {
    expect(convertToGbp(100, "EUR", { GBP: 1, EUR: 0.86 })).toBe(86);
  });

  it("is case-insensitive on the currency code", () => {
    expect(convertToGbp(100, "usd", { GBP: 1, USD: 0.79 })).toBe(79);
  });

  it("returns null for a null amount without throwing", () => {
    expect(convertToGbp(null, "USD")).toBeNull();
  });

  it("throws for a currency with no configured rate", () => {
    expect(() => convertToGbp(100, "JPY", { GBP: 1 })).toThrow(/no FX rate configured/);
  });

  it("uses DEFAULT_FX_RATES when no table is supplied", () => {
    expect(convertToGbp(100, "USD")).toBe(Math.round(100 * DEFAULT_FX_RATES.USD * 100) / 100);
  });
});
