import { describe, it, expect } from "vitest";
import { trimOutliersIQR, median } from "../src/market/outliers.js";

describe("trimOutliersIQR", () => {
  it("removes a clear high outlier from an otherwise tight cluster", () => {
    const values = [100, 105, 98, 102, 101, 99, 5000];
    const result = trimOutliersIQR(values);
    expect(result.excluded).toContain(5000);
    expect(result.trimmed).not.toContain(5000);
    expect(result.excludedCount).toBe(1);
  });

  it("removes a clear low outlier", () => {
    const values = [100, 105, 98, 102, 101, 99, 1];
    const result = trimOutliersIQR(values);
    expect(result.excluded).toContain(1);
  });

  it("does not trim anything from a tight, consistent dataset", () => {
    const values = [100, 101, 99, 102, 98, 100, 101];
    const result = trimOutliersIQR(values);
    expect(result.excludedCount).toBe(0);
    expect(result.trimmed).toHaveLength(values.length);
  });

  it("skips trimming entirely for fewer than 4 samples (too thin to judge)", () => {
    const values = [10, 1000, 5];
    const result = trimOutliersIQR(values);
    expect(result.excludedCount).toBe(0);
    expect(result.trimmed).toEqual(values);
  });

  it("never returns an empty trimmed set even in a degenerate case", () => {
    const values = [50, 50, 50, 50];
    const result = trimOutliersIQR(values);
    expect(result.trimmed.length).toBeGreaterThan(0);
  });
});

describe("median", () => {
  it("returns the middle value for an odd-length array", () => {
    expect(median([1, 5, 3])).toBe(3);
  });

  it("averages the two middle values for an even-length array", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns 0 for an empty array", () => {
    expect(median([])).toBe(0);
  });
});
