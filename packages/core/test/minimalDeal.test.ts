import { describe, it, expect } from "vitest";
import { minimalDealInputs, calculateDeal, type FxSnapshot } from "../src/deal/index.js";

/**
 * THE QUICK OFFER MUST NOT BE ABLE TO INVENT A NUMBER.
 *
 * This is the whole test. A "make an offer from the pipeline" shortcut is
 * exactly the kind of convenience that ends up shipping defaults — a zero
 * here, an assumed postage there — and every one of them would flow into a
 * profit figure the operator never entered.
 */
const FX: FxSnapshot = { rates: { GBP: 1, USD: 0.79 }, source: "LIVE", capturedAt: "2026-09-12T00:00:00.000Z" };

describe("the minimal deal behind a quick offer", () => {
  it("populates the offer and nothing else", () => {
    const inputs = minimalDealInputs({ strategy: "GRADE", graderId: "PSA", offerAmount: 31.5, offerCurrency: "GBP", fx: FX });

    expect(inputs.acquisition.price.amount).toBe(31.5);
    for (const field of ["sellerPostage", "importCharges", "otherAcquisitionCosts"] as const) {
      expect(inputs.acquisition[field]!.amount).toBeNull();
      expect(inputs.acquisition[field]!.provenance).toBe("UNKNOWN");
    }
    expect(inputs.grading!.serviceFee.amount).toBeNull();
    expect(inputs.resale[0].value.amount).toBeNull();
  });

  it("records the offer as an ESTIMATE — an offer is not a payment", () => {
    const inputs = minimalDealInputs({ strategy: "FLIP", offerAmount: 20, offerCurrency: "GBP", fx: FX });
    expect(inputs.acquisition.price.provenance).toBe("ESTIMATE");
    expect(inputs.acquisition.price.provenance).not.toBe("CONFIRMED");
  });

  it("calculates, and names every cost it does not have", () => {
    const inputs = minimalDealInputs({ strategy: "GRADE", graderId: "PSA", offerAmount: 30, offerCurrency: "GBP", fx: FX });
    const result = calculateDeal(inputs);

    // The offer is the acquisition total so far, and it is the ONLY figure.
    expect(result.acquisition.total).toBe(30);

    const missing = result.scenarios[0].missingInputs;
    expect(missing).toContain("Postage from seller");
    expect(missing).toContain("Grading service fee");
    expect(missing).toContain("Resale value (raw)");
    expect(result.scenarios[0].isComplete).toBe(false);
    // Above all: no profit was produced from a deal with no resale value.
    expect(result.scenarios[0].netProfit).toBeNull();
  });

  it("carries a foreign offer currency through to the calculator", () => {
    const inputs = minimalDealInputs({ strategy: "FLIP", offerAmount: 100, offerCurrency: "USD", fx: FX });
    expect(calculateDeal(inputs).acquisition.total).toBe(79);
  });
});
