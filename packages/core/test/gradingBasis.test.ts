import { describe, it, expect } from "vitest";
import {
  computeGradedBasis,
  DEFAULT_GRADING_BATCH,
  DEFAULT_GRADING_CONSUMABLES,
  DEFAULT_GRADING_SERVICES,
  type GradingService,
} from "../src/index.js";

const PSA_REGULAR = DEFAULT_GRADING_SERVICES.find((s) => s.id === "PSA_REGULAR")!;
const PSA_VALUE = DEFAULT_GRADING_SERVICES.find((s) => s.id === "PSA_VALUE")!;

describe("grading services are DATA, not constants", () => {
  it("configures PSA Regular at £65 with a $1,500 final-value cap", () => {
    expect(PSA_REGULAR.feePerCard).toBe(65);
    expect(PSA_REGULAR.declaredValueCapUsd).toBe(1500);
    expect(PSA_REGULAR.estimatedTurnaroundBusinessDays).toBeGreaterThanOrEqual(70);
  });

  it("configures PSA Value at £23 with a much longer turnaround and lower cap", () => {
    expect(PSA_VALUE.feePerCard).toBe(23);
    expect(PSA_VALUE.declaredValueCapUsd).toBe(500);
    expect(PSA_VALUE.estimatedTurnaroundBusinessDays).toBeGreaterThan(
      PSA_REGULAR.estimatedTurnaroundBusinessDays,
    );
  });

  it("uses whichever service it is given, never a hardcoded £65", () => {
    const custom: GradingService = { ...PSA_REGULAR, id: "CUSTOM", feePerCard: 12.5 };
    const basis = computeGradedBasis({ rawPurchasePrice: 100, sellerPostage: 0, service: custom });
    expect(basis.gradingFee).toBe(12.5);
  });
});

describe("computeGradedBasis — batch-allocated logistics", () => {
  it("divides shared batch logistics across the batch, not per card", () => {
    const basis = computeGradedBasis({
      rawPurchasePrice: 100,
      sellerPostage: 0,
      service: PSA_REGULAR,
      batch: DEFAULT_GRADING_BATCH,
    });

    // (15 outbound + 20 return + 12 insurance) / 10 cards = £4.70 per card
    const expectedShared =
      (DEFAULT_GRADING_BATCH.batchOutboundPostage +
        DEFAULT_GRADING_BATCH.batchReturnPostage +
        DEFAULT_GRADING_BATCH.batchInsurance) /
      DEFAULT_GRADING_BATCH.batchSize;

    expect(basis.perCardSharedLogistics).toBeCloseTo(expectedShared, 2);
    expect(basis.perCardSharedLogistics).toBeCloseTo(4.7, 2);
  });

  it("defaults to a 10-card batch, matching the operational assumption", () => {
    expect(DEFAULT_GRADING_BATCH.batchSize).toBe(10);
  });

  it("charges a bigger share per card when the batch is smaller", () => {
    const bigBatch = computeGradedBasis({
      rawPurchasePrice: 100,
      sellerPostage: 0,
      service: PSA_REGULAR,
      batch: { ...DEFAULT_GRADING_BATCH, batchSize: 20 },
    });
    const singleCard = computeGradedBasis({
      rawPurchasePrice: 100,
      sellerPostage: 0,
      service: PSA_REGULAR,
      batch: { ...DEFAULT_GRADING_BATCH, batchSize: 1 },
    });

    expect(bigBatch.perCardSharedLogistics).toBeLessThan(singleCard.perCardSharedLogistics);
    expect(singleCard.perCardSharedLogistics).toBeCloseTo(47, 2);
  });

  it("does NOT charge full batch postage to every card (the old per-card bug)", () => {
    const basis = computeGradedBasis({
      rawPurchasePrice: 100,
      sellerPostage: 0,
      service: PSA_REGULAR,
      batch: DEFAULT_GRADING_BATCH,
    });

    // The old model charged ~£8 outbound + ~£7 return + £3 insurance PER
    // CARD (£18); batch allocation at 10 cards is £4.70.
    expect(basis.perCardSharedLogistics).toBeLessThan(18);
  });

  it("keeps sleeve and Card Saver as genuine PER-CARD consumables", () => {
    const tenCardBatch = computeGradedBasis({
      rawPurchasePrice: 100,
      sellerPostage: 0,
      service: PSA_REGULAR,
      batch: DEFAULT_GRADING_BATCH,
      consumables: DEFAULT_GRADING_CONSUMABLES,
    });
    const hundredCardBatch = computeGradedBasis({
      rawPurchasePrice: 100,
      sellerPostage: 0,
      service: PSA_REGULAR,
      batch: { ...DEFAULT_GRADING_BATCH, batchSize: 100 },
      consumables: DEFAULT_GRADING_CONSUMABLES,
    });

    // Unchanged by batch size — they are not shared costs.
    expect(tenCardBatch.sleeve).toBe(DEFAULT_GRADING_CONSUMABLES.sleeveCost);
    expect(hundredCardBatch.sleeve).toBe(DEFAULT_GRADING_CONSUMABLES.sleeveCost);
    expect(tenCardBatch.cardSaver).toBe(DEFAULT_GRADING_CONSUMABLES.cardSaverCost);
  });

  it("totals every component of the basis", () => {
    const basis = computeGradedBasis({
      rawPurchasePrice: 100,
      sellerPostage: 3,
      importTax: 2,
      acquisitionFees: 1,
      service: PSA_REGULAR,
      batch: DEFAULT_GRADING_BATCH,
      consumables: DEFAULT_GRADING_CONSUMABLES,
    });

    // 100 + 3 + 2 + 1 + 65 + 4.70 + 0.10 + 0.20 = 176.00
    expect(basis.total).toBeCloseTo(176, 2);
  });

  it("carries an upcharge reserve only when one is passed", () => {
    const withReserve = computeGradedBasis({
      rawPurchasePrice: 100,
      sellerPostage: 0,
      service: PSA_REGULAR,
      upchargeReserve: 40,
    });
    const withoutReserve = computeGradedBasis({
      rawPurchasePrice: 100,
      sellerPostage: 0,
      service: PSA_REGULAR,
    });

    expect(withReserve.total - withoutReserve.total).toBeCloseTo(40, 2);
    expect(withoutReserve.upchargeReserve).toBe(0);
  });

  it("cheaper service produces a lower basis, all else equal", () => {
    const regular = computeGradedBasis({ rawPurchasePrice: 100, sellerPostage: 0, service: PSA_REGULAR });
    const value = computeGradedBasis({ rawPurchasePrice: 100, sellerPostage: 0, service: PSA_VALUE });
    expect(value.total).toBeCloseTo(regular.total - (65 - 23), 2);
  });

  it("rejects a zero batch size rather than dividing by zero", () => {
    expect(() =>
      computeGradedBasis({
        rawPurchasePrice: 100,
        sellerPostage: 0,
        service: PSA_REGULAR,
        batch: { ...DEFAULT_GRADING_BATCH, batchSize: 0 },
      }),
    ).toThrow();
  });
});
