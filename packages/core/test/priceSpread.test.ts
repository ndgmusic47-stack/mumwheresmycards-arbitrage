import { describe, expect, it } from "vitest";
import { computeMedianPriceSpread } from "../src/market/priceSpread.js";

describe("computeMedianPriceSpread (SOURCING WORKFLOW item 11)", () => {
  it("reports RISING when the 7-day median sits meaningfully above the 30-day one", () => {
    const result = computeMedianPriceSpread({ median7d: 110, median30d: 100 });
    expect(result.delta).toBe(10);
    expect(result.deltaFraction).toBe(0.1);
    expect(result.direction).toBe("RISING");
  });

  it("reports FALLING when the 7-day median sits meaningfully below the 30-day one", () => {
    const result = computeMedianPriceSpread({ median7d: 85, median30d: 100 });
    expect(result.delta).toBe(-15);
    expect(result.deltaFraction).toBe(-0.15);
    expect(result.direction).toBe("FALLING");
  });

  it("reports STABLE for a small difference within the 2% noise threshold", () => {
    const result = computeMedianPriceSpread({ median7d: 101, median30d: 100 });
    expect(result.direction).toBe("STABLE");
  });

  it("treats exactly the 2% threshold as RISING, not STABLE (STABLE requires strictly less than the threshold)", () => {
    const result = computeMedianPriceSpread({ median7d: 102, median30d: 100 });
    expect(result.deltaFraction).toBe(0.02);
    expect(result.direction).toBe("RISING");
  });

  it("returns nulls when either median is missing", () => {
    expect(computeMedianPriceSpread({ median7d: null, median30d: 100 })).toEqual({
      delta: null,
      deltaFraction: null,
      direction: null,
    });
    expect(computeMedianPriceSpread({ median7d: 100, median30d: null })).toEqual({
      delta: null,
      deltaFraction: null,
      direction: null,
    });
  });

  it("returns nulls rather than dividing by a zero/negative 30-day median", () => {
    const result = computeMedianPriceSpread({ median7d: 100, median30d: 0 });
    expect(result.delta).toBeNull();
    expect(result.deltaFraction).toBeNull();
    expect(result.direction).toBeNull();
  });
});
