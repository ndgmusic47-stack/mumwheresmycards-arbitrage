import { describe, it, expect } from "vitest";
import {
  computeSellingFees,
  computeNetSaleProceeds,
  DEFAULT_EXIT_MARKET_FEE_MODEL,
  DEFAULT_SELLING_COSTS,
} from "../src/index.js";

/**
 * eBay UK BUSINESS SELLER fee model. These numbers are the commercial
 * assumptions the whole engine rests on, so they're asserted explicitly
 * rather than via round-trip helpers — if someone changes a default, a test
 * should say so out loud.
 */
describe("computeSellingFees — eBay UK business seller", () => {
  it("charges the 10.9% variable final value fee on the buyer's total payment", () => {
    const fees = computeSellingFees({ itemPrice: 100 }, DEFAULT_EXIT_MARKET_FEE_MODEL);
    expect(fees.finalValueFee).toBeCloseTo(10.9, 2);
  });

  it("charges the 0.35% regulatory operating fee", () => {
    const fees = computeSellingFees({ itemPrice: 100 }, DEFAULT_EXIT_MARKET_FEE_MODEL);
    expect(fees.regulatoryOperatingFee).toBeCloseTo(0.35, 2);
  });

  it("charges the £0.40 per-order fee above the £10 threshold", () => {
    const fees = computeSellingFees({ itemPrice: 50 }, DEFAULT_EXIT_MARKET_FEE_MODEL);
    expect(fees.perOrderFee).toBe(0.4);
  });

  it("applies the below-threshold per-order fee at or under £10", () => {
    const fees = computeSellingFees({ itemPrice: 9.5 }, DEFAULT_EXIT_MARKET_FEE_MODEL);
    // Defaults to the same £0.40 — deliberately conservative, since the
    // published reference only defines the above-£10 fee.
    expect(fees.perOrderFee).toBe(DEFAULT_EXIT_MARKET_FEE_MODEL.perOrderFeeBelowThreshold);
  });

  it("charges variable fees on item price PLUS buyer-paid shipping, not item price alone", () => {
    const withShipping = computeSellingFees({ itemPrice: 100, buyerPaidShipping: 20 });
    const withoutShipping = computeSellingFees({ itemPrice: 100 });

    expect(withShipping.buyerPayment).toBe(120);
    expect(withShipping.finalValueFee).toBeCloseTo(120 * 0.109, 2);
    expect(withShipping.finalValueFee).toBeGreaterThan(withoutShipping.finalValueFee);
  });

  it("adds 20% VAT on top of the (VAT-exclusive) published fees", () => {
    const fees = computeSellingFees({ itemPrice: 100 });
    expect(fees.feeVat).toBeCloseTo(fees.feesExVat * 0.2, 2);
  });

  it("treats fee VAT as a real cost when it is NOT recoverable (the default)", () => {
    const fees = computeSellingFees({ itemPrice: 100 }, DEFAULT_EXIT_MARKET_FEE_MODEL);

    expect(DEFAULT_EXIT_MARKET_FEE_MODEL.sellerFeeVatRecoverable).toBe(false);
    expect(fees.nonRecoverableFeeVat).toBeCloseTo(fees.feeVat, 2);
    expect(fees.totalSellingFees).toBeCloseTo(fees.feesExVat + fees.feeVat, 2);
  });

  it("excludes fee VAT from economic cost when it IS recoverable", () => {
    const fees = computeSellingFees(
      { itemPrice: 100 },
      { ...DEFAULT_EXIT_MARKET_FEE_MODEL, sellerFeeVatRecoverable: true },
    );

    expect(fees.feeVat).toBeGreaterThan(0); // still charged by eBay...
    expect(fees.nonRecoverableFeeVat).toBe(0); // ...but reclaimed, so not a cost
    expect(fees.totalSellingFees).toBeCloseTo(fees.feesExVat, 2);
  });

  it("recoverable VAT is strictly cheaper than non-recoverable", () => {
    const notRecoverable = computeSellingFees({ itemPrice: 250 });
    const recoverable = computeSellingFees(
      { itemPrice: 250 },
      { ...DEFAULT_EXIT_MARKET_FEE_MODEL, sellerFeeVatRecoverable: true },
    );
    expect(recoverable.totalSellingFees).toBeLessThan(notRecoverable.totalSellingFees);
  });

  it("defaults promoted listings and international selling fees to zero", () => {
    const fees = computeSellingFees({ itemPrice: 100 });
    expect(fees.promotedListingsFee).toBe(0);
    expect(fees.internationalFee).toBe(0);
  });

  it("applies promoted listings and international fees when configured", () => {
    const fees = computeSellingFees(
      { itemPrice: 100 },
      { ...DEFAULT_EXIT_MARKET_FEE_MODEL, promotedListingsPct: 0.05, internationalFeePct: 0.013 },
    );
    expect(fees.promotedListingsFee).toBeCloseTo(5, 2);
    expect(fees.internationalFee).toBeCloseTo(1.3, 2);
  });

  it("has NO separate payment-processing percentage — it is bundled into the FVF", () => {
    // Guards against the old model's fabricated `paymentProcessingPct`.
    expect(Object.keys(DEFAULT_EXIT_MARKET_FEE_MODEL)).not.toContain("paymentProcessingPct");
  });

  it("no longer uses the old 13.25% FVF or £0.30 order fee", () => {
    expect(DEFAULT_EXIT_MARKET_FEE_MODEL.finalValueFeePct).toBe(0.109);
    expect(DEFAULT_EXIT_MARKET_FEE_MODEL.perOrderFee).toBe(0.4);
  });

  it("computes a full worked example correctly", () => {
    // £100 item, no buyer-paid shipping:
    //   FVF          100 * 0.109  = 10.90
    //   regulatory   100 * 0.0035 =  0.35
    //   per order                 =  0.40
    //   ex-VAT total              = 11.65
    //   VAT @20%                  =  2.33
    //   total                     = 13.98
    const fees = computeSellingFees({ itemPrice: 100 });
    expect(fees.feesExVat).toBeCloseTo(11.65, 2);
    expect(fees.feeVat).toBeCloseTo(2.33, 2);
    expect(fees.totalSellingFees).toBeCloseTo(13.98, 2);
  });
});

describe("computeNetSaleProceeds", () => {
  it("deducts fees and our own fulfilment costs from the buyer's payment", () => {
    const sale = computeNetSaleProceeds(
      { itemPrice: 100, outboundPostage: 1.55, insurance: 0, packaging: 0.75 },
      DEFAULT_EXIT_MARKET_FEE_MODEL,
      DEFAULT_SELLING_COSTS,
    );

    expect(sale.buyerPayment).toBe(100);
    expect(sale.totalDeductions).toBeCloseTo(13.98 + 1.55 + 0.75, 2);
    expect(sale.netProceeds).toBeCloseTo(100 - 13.98 - 1.55 - 0.75, 2);
  });

  it("includes buyer-paid shipping in both the payment and the fee base", () => {
    const sale = computeNetSaleProceeds({ itemPrice: 100, buyerPaidShipping: 5 });
    expect(sale.buyerPayment).toBe(105);
    expect(sale.fees.finalValueFee).toBeCloseTo(105 * 0.109, 2);
  });

  it("uses graded selling costs when they are passed explicitly", () => {
    const slab = computeNetSaleProceeds({
      itemPrice: 400,
      outboundPostage: DEFAULT_SELLING_COSTS.outboundPostageGraded,
      insurance: DEFAULT_SELLING_COSTS.saleInsuranceGraded,
    });
    expect(slab.outboundPostage).toBe(DEFAULT_SELLING_COSTS.outboundPostageGraded);
    expect(slab.insurance).toBe(DEFAULT_SELLING_COSTS.saleInsuranceGraded);
  });

  it("rejects a negative item price rather than silently producing nonsense", () => {
    expect(() => computeNetSaleProceeds({ itemPrice: -1 })).toThrow();
  });
});
