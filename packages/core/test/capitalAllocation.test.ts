import { describe, it, expect } from "vitest";
import { allocateCapital, type CapitalAllocationCandidate } from "../src/calc/capitalAllocation.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec item 28 (deterministic capital
 * allocation module). See capitalAllocation.ts's own doc comment for the
 * full design rationale (why profitPerCapitalDay is the ranking metric, why
 * concentration caps exist, why this is a greedy allocator not an exact
 * optimiser).
 */

function candidate(overrides: Partial<CapitalAllocationCandidate> = {}): CapitalAllocationCandidate {
  return {
    id: "c1",
    cardPrintingHash: "hash-1",
    strategy: "FLIP",
    totalAcquisitionCost: 100,
    profitPerCapitalDay: 1,
    ...overrides,
  };
}

describe("allocateCapital", () => {
  it("accepts the single most capital-efficient candidate first", () => {
    const result = allocateCapital(
      [
        candidate({ id: "slow", cardPrintingHash: "h1", totalAcquisitionCost: 100, profitPerCapitalDay: 0.5 }),
        candidate({ id: "fast", cardPrintingHash: "h2", totalAcquisitionCost: 100, profitPerCapitalDay: 5 }),
      ],
      { totalAvailableCapital: 100, maxSingleOpportunityFraction: 1, maxPerCardFraction: 1 },
    );

    expect(result.accepted.map((d) => d.id)).toEqual(["fast"]);
    expect(result.skipped[0]!.id).toBe("slow");
    expect(result.skipped[0]!.skipReason).toBe("EXCEEDS_REMAINING_BUDGET");
  });

  it("greedily fills the budget across several affordable candidates, most efficient first", () => {
    const result = allocateCapital(
      [
        candidate({ id: "a", cardPrintingHash: "h1", totalAcquisitionCost: 40, profitPerCapitalDay: 3 }),
        candidate({ id: "b", cardPrintingHash: "h2", totalAcquisitionCost: 40, profitPerCapitalDay: 2 }),
        candidate({ id: "c", cardPrintingHash: "h3", totalAcquisitionCost: 40, profitPerCapitalDay: 1 }),
      ],
      { totalAvailableCapital: 100, maxSingleOpportunityFraction: 1, maxPerCardFraction: 1 },
    );

    // a (40) + b (40) = 80, leaves 20 remaining — not enough for c (40).
    expect(result.accepted.map((d) => d.id)).toEqual(["a", "b"]);
    expect(result.capitalAllocated).toBe(80);
    expect(result.capitalRemaining).toBe(20);
    expect(result.skipped.map((d) => d.id)).toEqual(["c"]);
  });

  it("ranks candidates with a known profitPerCapitalDay ahead of any candidate with an unknown one", () => {
    const result = allocateCapital(
      [
        candidate({ id: "unknown", cardPrintingHash: "h1", totalAcquisitionCost: 50, profitPerCapitalDay: null }),
        candidate({ id: "known", cardPrintingHash: "h2", totalAcquisitionCost: 50, profitPerCapitalDay: 0.01 }),
      ],
      { totalAvailableCapital: 50, maxSingleOpportunityFraction: 1, maxPerCardFraction: 1 },
    );

    // Only one fits — it must be the KNOWN one, never assumed worse than an
    // unknown figure (unknown is not treated as infinite either).
    expect(result.accepted.map((d) => d.id)).toEqual(["known"]);
  });

  it("still considers unknown-efficiency candidates when budget is left over", () => {
    const result = allocateCapital(
      [candidate({ id: "unknown", cardPrintingHash: "h1", totalAcquisitionCost: 50, profitPerCapitalDay: null })],
      { totalAvailableCapital: 100, maxSingleOpportunityFraction: 1, maxPerCardFraction: 1 },
    );

    expect(result.accepted.map((d) => d.id)).toEqual(["unknown"]);
  });

  it("enforces the per-opportunity concentration cap even when capital is otherwise available", () => {
    const result = allocateCapital(
      [candidate({ id: "big", cardPrintingHash: "h1", totalAcquisitionCost: 60 })],
      { totalAvailableCapital: 100, maxSingleOpportunityFraction: 0.5, maxPerCardFraction: 1 },
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.skipped[0]!.skipReason).toBe("EXCEEDS_SINGLE_OPPORTUNITY_CAP");
  });

  it("enforces the per-card concentration cap across multiple listings of the same printing", () => {
    const result = allocateCapital(
      [
        candidate({ id: "listing1", cardPrintingHash: "same-card", totalAcquisitionCost: 20, profitPerCapitalDay: 5 }),
        candidate({ id: "listing2", cardPrintingHash: "same-card", totalAcquisitionCost: 20, profitPerCapitalDay: 4 }),
        candidate({ id: "listing3", cardPrintingHash: "same-card", totalAcquisitionCost: 20, profitPerCapitalDay: 3 }),
      ],
      { totalAvailableCapital: 100, maxSingleOpportunityFraction: 1, maxPerCardFraction: 0.3 },
    );

    // Cap is 30 (30% of 100). listing1 (20) fits; listing1+listing2 (40)
    // would breach it, so listing2 is skipped even though remaining budget
    // and its own single-opportunity cap would otherwise allow it.
    expect(result.accepted.map((d) => d.id)).toEqual(["listing1"]);
    expect(result.skipped.map((d) => ({ id: d.id, reason: d.skipReason }))).toEqual([
      { id: "listing2", reason: "EXCEEDS_PER_CARD_CAP" },
      { id: "listing3", reason: "EXCEEDS_PER_CARD_CAP" },
    ]);
  });

  it("respects a reserve fraction — reserved capital is never offered to the allocator", () => {
    const result = allocateCapital([candidate({ totalAcquisitionCost: 80 })], {
      totalAvailableCapital: 100,
      reserveFraction: 0.5,
      maxSingleOpportunityFraction: 1,
      maxPerCardFraction: 1,
    });

    expect(result.capitalReserved).toBe(50);
    expect(result.capitalOffered).toBe(50);
    expect(result.accepted).toHaveLength(0);
    expect(result.skipped[0]!.skipReason).toBe("EXCEEDS_REMAINING_BUDGET");
  });

  it("skips a candidate whose acquisition cost is zero, negative, or non-finite, never crashing", () => {
    const result = allocateCapital(
      [
        candidate({ id: "zero", totalAcquisitionCost: 0 }),
        candidate({ id: "negative", totalAcquisitionCost: -5 }),
        candidate({ id: "nan", totalAcquisitionCost: Number.NaN }),
      ],
      { totalAvailableCapital: 100 },
    );

    expect(result.accepted).toHaveLength(0);
    expect(result.skipped.every((d) => d.skipReason === "INVALID_ACQUISITION_COST")).toBe(true);
  });

  it("is fully deterministic regardless of input order (same accept set, same total allocated)", () => {
    const candidates = [
      candidate({ id: "a", cardPrintingHash: "h1", totalAcquisitionCost: 30, profitPerCapitalDay: 3 }),
      candidate({ id: "b", cardPrintingHash: "h2", totalAcquisitionCost: 30, profitPerCapitalDay: 2 }),
      candidate({ id: "c", cardPrintingHash: "h3", totalAcquisitionCost: 30, profitPerCapitalDay: 1 }),
    ];
    const settings = { totalAvailableCapital: 65, maxSingleOpportunityFraction: 1, maxPerCardFraction: 1 };

    const forward = allocateCapital(candidates, settings);
    const reversed = allocateCapital([...candidates].reverse(), settings);

    expect(forward.accepted.map((d) => d.id)).toEqual(reversed.accepted.map((d) => d.id));
    expect(forward.capitalAllocated).toBe(reversed.capitalAllocated);
  });

  it("treats a non-positive totalAvailableCapital as zero capital, never negative", () => {
    const result = allocateCapital([candidate()], { totalAvailableCapital: -50 });

    expect(result.totalAvailableCapital).toBe(0);
    expect(result.accepted).toHaveLength(0);
  });

  it("a candidate with no cardPrintingHash never breaches another candidate's per-card cap", () => {
    const result = allocateCapital(
      [
        candidate({ id: "a", cardPrintingHash: null, totalAcquisitionCost: 20, profitPerCapitalDay: 5 }),
        candidate({ id: "b", cardPrintingHash: null, totalAcquisitionCost: 20, profitPerCapitalDay: 4 }),
      ],
      { totalAvailableCapital: 100, maxSingleOpportunityFraction: 1, maxPerCardFraction: 0.3 },
    );

    // Each null-card candidate is keyed independently by its own id, so
    // neither one's cap consumption bleeds into the other's.
    expect(result.accepted.map((d) => d.id)).toEqual(["a", "b"]);
  });
});
