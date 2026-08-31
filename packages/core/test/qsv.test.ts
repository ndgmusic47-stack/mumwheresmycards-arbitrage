import { describe, it, expect } from "vitest";
import { computeQsv, DEFAULT_QSV_SETTINGS } from "../src/index.js";

describe("computeQsv — conservative executable sale value", () => {
  it("takes the LOWER of the 7-day and 30-day sold medians", () => {
    const sevenLower = computeQsv({ median7d: 100, median30d: 120, baseConfidence: 0.8 });
    const thirtyLower = computeQsv({ median7d: 120, median30d: 100, baseConfidence: 0.8 });

    expect(sevenLower.medianUsed).toBe(100);
    expect(thirtyLower.medianUsed).toBe(100);
  });

  it("applies the 8% quick-sale haircut", () => {
    const result = computeQsv({ median7d: 100, median30d: 120, baseConfidence: 0.8 });
    expect(DEFAULT_QSV_SETTINGS.quickSaleHaircutPct).toBe(0.08);
    expect(result.qsv).toBeCloseTo(92, 2); // 100 * 0.92
  });

  it("does not value a spiking card at the spike", () => {
    // A card whose last week ran hot still gets valued off the calmer window.
    const spiking = computeQsv({ median7d: 500, median30d: 200, baseConfidence: 0.9 });
    expect(spiking.qsv).toBeCloseTo(184, 2); // 200 * 0.92, not 500
  });

  it("reports the strongest basis when both medians exist", () => {
    const result = computeQsv({ median7d: 100, median30d: 110, baseConfidence: 0.8 });
    expect(result.basis).toBe("BOTH_SOLD_MEDIANS");
    expect(result.isHighConfidenceQsv).toBe(true);
    expect(result.confidence).toBe(0.8); // no penalty
  });

  it("falls back to the 7-day median alone with REDUCED confidence", () => {
    const result = computeQsv({ median7d: 100, median30d: null, baseConfidence: 0.8 });

    expect(result.basis).toBe("SEVEN_DAY_SOLD_MEDIAN_ONLY");
    expect(result.qsv).toBeCloseTo(92, 2);
    expect(result.isHighConfidenceQsv).toBe(true);
    expect(result.confidence).toBeLessThan(0.8);
    expect(result.confidence).toBeCloseTo(0.8 * DEFAULT_QSV_SETTINGS.singleMedianConfidenceMultiplier, 4);
  });

  it("falls back to the 30-day median alone with REDUCED confidence", () => {
    const result = computeQsv({ median7d: null, median30d: 200, baseConfidence: 0.9 });

    expect(result.basis).toBe("THIRTY_DAY_SOLD_MEDIAN_ONLY");
    expect(result.qsv).toBeCloseTo(184, 2);
    expect(result.confidence).toBeLessThan(0.9);
  });

  it("uses a market reference when NO median exists, but never calls it high-confidence QSV", () => {
    const result = computeQsv({
      median7d: null,
      median30d: null,
      fallbackReference: 150,
      baseConfidence: 0.9,
    });

    expect(result.basis).toBe("FALLBACK_MARKET_REFERENCE");
    expect(result.qsv).toBeCloseTo(138, 2); // still haircut
    expect(result.isHighConfidenceQsv).toBe(false);
    expect(result.confidence).toBeLessThanOrEqual(DEFAULT_QSV_SETTINGS.fallbackConfidenceCeiling);
  });

  it("returns no QSV at all when there is no data of any kind", () => {
    const result = computeQsv({ median7d: null, median30d: null, baseConfidence: 0.9 });

    expect(result.qsv).toBeNull();
    expect(result.basis).toBe("NO_DATA");
    expect(result.isHighConfidenceQsv).toBe(false);
    expect(result.confidence).toBe(0);
  });

  it("ignores zero and negative medians rather than treating them as real prices", () => {
    const result = computeQsv({ median7d: 0, median30d: -5, fallbackReference: 100, baseConfidence: 0.7 });
    expect(result.basis).toBe("FALLBACK_MARKET_REFERENCE");
  });

  it("honours a configured haircut other than the default", () => {
    const result = computeQsv(
      { median7d: 100, median30d: 100, baseConfidence: 0.8 },
      { ...DEFAULT_QSV_SETTINGS, quickSaleHaircutPct: 0.2 },
    );
    expect(result.qsv).toBeCloseTo(80, 2);
  });

  it("always keeps the underlying medians visible for audit", () => {
    const result = computeQsv({ median7d: 111, median30d: 222, baseConfidence: 0.8 });
    expect(result.median7d).toBe(111);
    expect(result.median30d).toBe(222);
    expect(result.haircutPct).toBe(0.08);
  });
});
