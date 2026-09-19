import { describe, it, expect } from "vitest";
import {
  computeGradedBasis,
  DEFAULT_GRADING_BATCH,
  DEFAULT_GRADING_CONSUMABLES,
  DEFAULT_GRADING_SERVICES,
  type GradingService,
} from "../src/index.js";

const PSA_REGULAR = DEFAULT_GRADING_SERVICES.find((s) => s.id === "PSA_REGULAR")!;
const PSA_STANDARD = DEFAULT_GRADING_SERVICES.find((s) => s.id === "PSA_STANDARD")!;

describe("grading services are DATA, not constants", () => {
  /**
   * These pin PSA'S PUBLISHED PRICES, checked 2026-09-19. Before that date
   * the fees here were £23 and £65, sourced from nobody and dated never, and
   * every economic decision this tool has made rested on them. Both were
   * wrong. Each service now carries a `pricedUsd` and a `verifiedAt`, and
   * these tests fail if a figure is ever changed without one.
   */
  it("prices PSA Priority from PSA's published $79.99, not a typed-in number", () => {
    expect(PSA_REGULAR.pricedUsd).toBe(79.99);
    expect(PSA_REGULAR.feePerCard).toBeCloseTo(79.99 * 0.7403, 1);
    expect(PSA_REGULAR.declaredValueCapUsd).toBe(1500);
    expect(PSA_REGULAR.verifiedAt).toBe("2026-09-19");
    expect(PSA_REGULAR.sourceUrl).toContain("psacard.com");
  });

  it("prices PSA Standard from PSA's published $59.99, as the cheapest tier on offer", () => {
    expect(PSA_STANDARD.pricedUsd).toBe(59.99);
    expect(PSA_STANDARD.feePerCard).toBeCloseTo(59.99 * 0.7403, 1);
    expect(PSA_STANDARD.declaredValueCapUsd).toBe(1000);
    expect(PSA_STANDARD.feePerCard).toBeLessThan(PSA_REGULAR.feePerCard);
    // Cheaper costs time: 95 business days against Priority's 75.
    expect(PSA_STANDARD.estimatedTurnaroundBusinessDays).toBeGreaterThan(
      PSA_REGULAR.estimatedTurnaroundBusinessDays,
    );
  });

  /**
   * The tier the tool reached for on every cheap card. PSA lists it as not
   * accepting submissions, so every figure produced against it described a
   * service that could not be bought.
   */
  it("keeps PSA Value switched off, with the reason recorded rather than implied", () => {
    const value = DEFAULT_GRADING_SERVICES.find((s) => s.id === "PSA_VALUE")!;

    expect(value.enabled).toBe(false);
    expect(value.unavailableReason).toBeTruthy();
    expect(value.pricedUsd).toBeNull();
  });

  it("never enables a service whose fee has no published source", () => {
    for (const service of DEFAULT_GRADING_SERVICES.filter((s) => s.enabled)) {
      expect(service.pricedUsd, `${service.id} is enabled with no published price`).toBeTruthy();
      expect(service.verifiedAt, `${service.id} is enabled with no verification date`).toBeTruthy();
    }
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

    // 100 + 3 + 2 + 1 + 59.22 + 4.70 + 0.10 + 0.20 = 170.22
    // The fee moved from £65 to PSA's published $79.99 on 2026-09-19.
    expect(basis.total).toBeCloseTo(100 + 3 + 2 + 1 + PSA_REGULAR.feePerCard + 4.7 + 0.1 + 0.2, 2);
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
    const value = computeGradedBasis({ rawPurchasePrice: 100, sellerPostage: 0, service: PSA_STANDARD });
    // Derived from the services themselves rather than hardcoded. The old
    // £65-vs-£23 gap was a literal here, so correcting the fees broke a test
    // that was really asserting the fee constants twice over.
    expect(value.total).toBeCloseTo(regular.total - (PSA_REGULAR.feePerCard - PSA_STANDARD.feePerCard), 2);
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
