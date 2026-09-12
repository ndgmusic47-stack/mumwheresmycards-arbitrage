import { describe, it, expect } from "vitest";
import {
  calculateDeal,
  solveBreakEvenSalePrice,
  DEAL_CALC_VERSION,
  DealInputError,
  type DealInputs,
  type FxSnapshot,
  type MoneyInput,
} from "../src/deal/index.js";
import { DEFAULT_EXIT_MARKET_FEE_MODEL, computeSellingFees, type ExitMarketFeeModel } from "../src/calc/fees.js";

/**
 * THE DEAL CALCULATOR — reconciled by hand, penny for penny.
 *
 * Every expected figure below was worked out ON PAPER from the published fee
 * model before the test was written, not copied from what the code happened
 * to return. That distinction is the whole point of this file: a test that
 * records current behaviour proves only that behaviour has not changed, and
 * this is the code that decides whether real money gets spent.
 *
 * The fee model these reconciliations assume (DEFAULT_EXIT_MARKET_FEE_MODEL):
 *   final value fee     10.9% of the buyer's total payment
 *   regulatory op fee    0.35% of the same
 *   per-order fee       £0.40
 *   VAT on fees            20%, non-recoverable (operator not VAT registered)
 */

const FX: FxSnapshot = {
  rates: { GBP: 1, USD: 0.79, EUR: 0.86 },
  source: "LIVE",
  capturedAt: "2026-09-12T00:00:00.000Z",
};

const gbp = (amount: number | null, provenance: MoneyInput["provenance"] = "CONFIRMED"): MoneyInput => ({
  amount,
  currency: "GBP",
  provenance,
});
const usd = (amount: number, provenance: MoneyInput["provenance"] = "CONFIRMED"): MoneyInput => ({
  amount,
  currency: "USD",
  provenance,
});
const unknown = (): MoneyInput => ({ amount: null, provenance: "UNKNOWN" });

// ---------------------------------------------------------------------------
// WORKED EXAMPLE 1 — a domestic flip, every figure in sterling.
// ---------------------------------------------------------------------------
describe("worked example 1 — domestic flip, reconciled by hand", () => {
  const deal: DealInputs = {
    strategy: "FLIP",
    acquisition: {
      price: gbp(40),
      sellerPostage: gbp(3.5),
      importCharges: gbp(0),
      otherAcquisitionCosts: gbp(0),
    },
    sale: { buyerPaidShipping: gbp(0) },
    resale: [{ value: gbp(90), valuationSource: "eBay UK sold, 10 comps", valuationDate: "2026-09-11" }],
    fx: FX,
  };

  const result = calculateDeal(deal);
  const scenario = result.scenarios[0]!;

  it("acquisition totals £43.50 — £40.00 + £3.50, with two confirmed zeroes included", () => {
    expect(result.acquisition.total).toBe(43.5);
    expect(result.acquisition.lines).toHaveLength(4);
    expect(result.totalCostBeforeScenario).toBe(43.5);
  });

  it("selling fees are £12.64 on a £90 sale", () => {
    // 90 x 10.9%  = 9.81
    // 90 x 0.35%  = 0.32 (0.315 rounds up)
    // per order   = 0.40
    //             = 10.53 ex VAT, + 20% = 2.11, = 12.64
    expect(scenario.sellingFees).toBe(12.64);
    expect(scenario.buyerPayment).toBe(90);
  });

  it("fulfilment falls back to the configured raw defaults: £1.55 + £0.75 + £0.00 = £2.30", () => {
    expect(scenario.fulfilmentCosts).toBe(2.3);
  });

  it("net sale proceeds are £75.06", () => {
    // 90.00 - 12.64 - 1.55 - 0.75 - 0.00
    expect(scenario.netSaleProceeds).toBe(75.06);
  });

  it("net profit is £31.56 and return on cost is 72.55%", () => {
    // 75.06 - 43.50 = 31.56 ; 31.56 / 43.50 = 0.72551...
    expect(scenario.netProfit).toBe(31.56);
    expect(scenario.returnOnCost).toBe(0.7255);
  });

  it("break-even sale price is £53.50, and selling at exactly that yields zero profit", () => {
    expect(scenario.breakEvenSalePrice).toBe(53.5);

    const atBreakEven = calculateDeal({ ...deal, resale: [{ value: gbp(53.5) }] });
    expect(atBreakEven.scenarios[0]!.netProfit).toBe(0);
  });

  it("is complete, and carries the valuation provenance through", () => {
    expect(result.isComplete).toBe(true);
    expect(result.missingInputs).toEqual([]);
    expect(scenario.valuationSource).toBe("eBay UK sold, 10 comps");
    expect(scenario.valuationDate).toBe("2026-09-11");
    expect(result.calcVersion).toBe(DEAL_CALC_VERSION);
  });
});

// ---------------------------------------------------------------------------
// WORKED EXAMPLE 2 — foreign-currency purchase and a foreign-currency
// grading fee, inside one grading batch.
// ---------------------------------------------------------------------------
describe("worked example 2 — USD purchase + USD grading fee + a 10-card batch", () => {
  const deal: DealInputs = {
    strategy: "GRADE",
    acquisition: {
      price: usd(100), // $100 x 0.79 = £79.00
      sellerPostage: gbp(4),
      importCharges: gbp(0),
      otherAcquisitionCosts: gbp(0),
    },
    grading: {
      graderId: "PSA",
      serviceName: "Value",
      serviceFee: usd(32.99), // $32.99 x 0.79 = £26.0621 -> £26.06
      submissionPostage: gbp(15),
      returnPostage: gbp(20),
      batchInsurance: gbp(12),
      batchSize: 10,
      consumablesPerCard: gbp(0.3),
    },
    sale: { buyerPaidShipping: gbp(0) },
    resale: [{ gradeKey: "PSA_9", value: gbp(300) }],
    fx: FX,
  };

  const result = calculateDeal(deal);
  const scenario = result.scenarios[0]!;

  it("converts each foreign amount exactly once, at the deal's frozen rate", () => {
    const price = result.acquisition.lines.find((l) => l.key === "price")!;
    expect(price.gbp).toBe(79);
    expect(price.detail.originalAmount).toBe(100);
    expect(price.detail.originalCurrency).toBe("USD");
    expect(price.detail.rateToGbp).toBe(0.79);

    const fee = result.grading.lines.find((l) => l.key === "serviceFee")!;
    expect(fee.gbp).toBe(26.06);
    expect(fee.detail.rateToGbp).toBe(0.79);
  });

  it("acquisition is £83.00 and grading is £31.06", () => {
    // acquisition: 79.00 + 4.00 + 0 + 0
    // grading: 26.06 + (15/10) + (20/10) + (12/10) + 0.30
    //        = 26.06 + 1.50 + 2.00 + 1.20 + 0.30
    expect(result.acquisition.total).toBe(83);
    expect(result.grading.total).toBe(31.06);
    expect(result.totalCostBeforeScenario).toBe(114.06);
  });

  it("charges each batch cost ONCE, divided — never the whole batch per card", () => {
    const submission = result.grading.lines.find((l) => l.key === "submissionPostage")!;
    expect(submission.gbp).toBe(1.5);
    expect(submission.allocation).toEqual({ batchTotalGbp: 15, batchSize: 10, isActual: false });
  });

  it("net profit at PSA 9 is £137.21", () => {
    // fees on 300: 32.70 + 1.05 + 0.40 = 34.15 ex VAT, +20% = 6.83, = 40.98
    // proceeds: 300 - 40.98 - 4.50 - 2.50 - 0.75 = 251.27   (graded fulfilment defaults)
    // profit:   251.27 - 114.06 = 137.21
    expect(scenario.sellingFees).toBe(40.98);
    expect(scenario.fulfilmentCosts).toBe(7.75);
    expect(scenario.netSaleProceeds).toBe(251.27);
    expect(scenario.netProfit).toBe(137.21);
    expect(scenario.returnOnCost).toBe(1.203);
  });

  it("labels the outcome with the grader's own published label", () => {
    expect(scenario.gradeLabel).toBe("Mint 9");
    expect(result.graderScaleSourceUrl).toContain("psacard.com");
  });
});

describe("batch size genuinely changes the allocation", () => {
  const base: DealInputs = {
    strategy: "GRADE",
    acquisition: { price: gbp(50), sellerPostage: gbp(0), importCharges: gbp(0), otherAcquisitionCosts: gbp(0) },
    grading: {
      graderId: "PSA",
      serviceFee: gbp(22),
      submissionPostage: gbp(15),
      returnPostage: gbp(20),
      batchInsurance: gbp(12),
      batchSize: 10,
      consumablesPerCard: gbp(0),
    },
    sale: { buyerPaidShipping: gbp(0) },
    resale: [{ gradeKey: "PSA_9", value: gbp(200) }],
    fx: FX,
  };

  it("a batch of one carries the whole £47 of shared cost — correctly, because that is what it costs", () => {
    const one = calculateDeal({ ...base, grading: { ...base.grading!, batchSize: 1 } });
    expect(one.grading.total).toBe(69); // 22 + 15 + 20 + 12
  });

  it("a batch of ten carries £4.70 of it", () => {
    const ten = calculateDeal(base);
    expect(ten.grading.total).toBe(26.7); // 22 + 1.50 + 2.00 + 1.20
  });

  it("replacing an estimated batch with a real one is visible as an actual allocation", () => {
    const actual = calculateDeal({ ...base, grading: { ...base.grading!, batchSize: 7, batchSizeIsActual: true } });
    const submission = actual.grading.lines.find((l) => l.key === "submissionPostage")!;
    expect(submission.allocation!.isActual).toBe(true);
    expect(submission.allocation!.batchSize).toBe(7);
    expect(submission.gbp).toBeCloseTo(15 / 7, 2);
  });

  it("refuses a batch size that cannot allocate anything", () => {
    for (const batchSize of [0, -1, 2.5, Number.NaN]) {
      expect(() => calculateDeal({ ...base, grading: { ...base.grading!, batchSize } })).toThrow(DealInputError);
    }
  });
});

// ---------------------------------------------------------------------------
// WORKED EXAMPLE 3 — an upcharge that only one outcome actually trips.
// ---------------------------------------------------------------------------
describe("worked example 3 — a declared-value upcharge lands only on the outcomes that trigger it", () => {
  const deal: DealInputs = {
    strategy: "GRADE",
    acquisition: { price: gbp(100), sellerPostage: gbp(0), importCharges: gbp(0), otherAcquisitionCosts: gbp(0) },
    grading: {
      graderId: "PSA",
      serviceFee: gbp(23),
      submissionPostage: gbp(0),
      returnPostage: gbp(0),
      batchInsurance: gbp(0),
      batchSize: 1,
      consumablesPerCard: gbp(0),
      upcharge: gbp(40),
      upchargeAppliesToGradeKeys: ["PSA_10"],
    },
    sale: { buyerPaidShipping: gbp(0) },
    resale: [
      { gradeKey: "PSA_10", value: gbp(2000) },
      { gradeKey: "PSA_9", value: gbp(400) },
      { gradeKey: "PSA_8", value: gbp(180) },
    ],
    fx: FX,
  };

  const result = calculateDeal(deal);
  const byGrade = Object.fromEntries(result.scenarios.map((s) => [s.gradeKey!, s]));

  it("the PSA 10 outcome carries the £40 upcharge", () => {
    expect(byGrade.PSA_10!.totalCost).toBe(163); // 100 + 23 + 40
    expect(byGrade.PSA_10!.scenarioOnlyCosts.map((l) => l.key)).toEqual(["upcharge"]);
  });

  it("the PSA 9 and PSA 8 outcomes do NOT — charging them would overstate their cost", () => {
    expect(byGrade.PSA_9!.totalCost).toBe(123); // 100 + 23
    expect(byGrade.PSA_8!.totalCost).toBe(123);
    expect(byGrade.PSA_9!.scenarioOnlyCosts).toEqual([]);
  });

  it("break-even differs per outcome, because the cost does", () => {
    expect(byGrade.PSA_10!.breakEvenSalePrice).not.toBe(byGrade.PSA_9!.breakEvenSalePrice);
    expect(byGrade.PSA_10!.breakEvenSalePrice!).toBeGreaterThan(byGrade.PSA_9!.breakEvenSalePrice!);
  });

  it("an upcharge with no named grades applies to every graded outcome — the conservative reading", () => {
    const everywhere = calculateDeal({
      ...deal,
      grading: { ...deal.grading!, upchargeAppliesToGradeKeys: [] },
    });
    for (const scenario of everywhere.scenarios) {
      expect(scenario.scenarioOnlyCosts.map((l) => l.key)).toEqual(["upcharge"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Blank is not zero.
// ---------------------------------------------------------------------------
describe("an unknown cost is never treated as a confirmed zero", () => {
  const withUnknownImport: DealInputs = {
    strategy: "FLIP",
    acquisition: { price: gbp(40), sellerPostage: gbp(3.5), importCharges: unknown(), otherAcquisitionCosts: gbp(0) },
    sale: { buyerPaidShipping: gbp(0) },
    resale: [{ value: gbp(90) }],
    fx: FX,
  };

  it("names the missing input rather than quietly contributing nothing", () => {
    const result = calculateDeal(withUnknownImport);
    expect(result.isComplete).toBe(false);
    expect(result.missingInputs).toContain("Import charges");
  });

  it("still shows a profit figure — but flagged incomplete, never presented as final", () => {
    const result = calculateDeal(withUnknownImport);
    expect(result.scenarios[0]!.netProfit).toBe(31.56);
    expect(result.scenarios[0]!.isComplete).toBe(false);
  });

  it("a CONFIRMED zero is complete and contributes zero", () => {
    const confirmed = calculateDeal({
      ...withUnknownImport,
      acquisition: { ...withUnknownImport.acquisition, importCharges: gbp(0) },
    });
    expect(confirmed.isComplete).toBe(true);
    expect(confirmed.missingInputs).toEqual([]);
    expect(confirmed.acquisition.total).toBe(43.5);
  });

  it("a missing RESALE value produces no profit figure at all, rather than a £0 sale", () => {
    const noValue = calculateDeal({ ...withUnknownImport, resale: [{ value: unknown() }] });
    const scenario = noValue.scenarios[0]!;
    expect(scenario.netProfit).toBeNull();
    expect(scenario.netSaleProceeds).toBeNull();
    expect(scenario.returnOnCost).toBeNull();
    // The cost side is known, so break-even still answers a real question.
    expect(scenario.breakEvenSalePrice).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------
describe("invalid input is refused loudly, never absorbed", () => {
  const base = (price: MoneyInput): DealInputs => ({
    strategy: "FLIP",
    acquisition: { price, sellerPostage: gbp(0), importCharges: gbp(0), otherAcquisitionCosts: gbp(0) },
    sale: {},
    resale: [{ value: gbp(90) }],
    fx: FX,
  });

  it("rejects a negative cost", () => {
    expect(() => calculateDeal(base(gbp(-5)))).toThrow(/must not be negative/);
  });

  it("rejects non-finite numbers", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => calculateDeal(base({ amount: bad, provenance: "CONFIRMED" }))).toThrow(/finite number/);
    }
  });

  it("rejects a currency the deal's own rate snapshot cannot convert", () => {
    expect(() => calculateDeal(base({ amount: 100, currency: "JPY", provenance: "CONFIRMED" }))).toThrow(/no exchange rate/);
  });

  it("rejects an amount whose provenance is UNKNOWN — the value is right there, so say where it came from", () => {
    expect(() => calculateDeal(base({ amount: 40, provenance: "UNKNOWN" }))).toThrow(/provenance is UNKNOWN/);
  });

  it("refuses a GRADE deal with no grading inputs", () => {
    expect(() => calculateDeal({ ...base(gbp(40)), strategy: "GRADE" })).toThrow(/needs grading inputs/);
  });

  it("refuses a deal with nothing to price against", () => {
    expect(() => calculateDeal({ ...base(gbp(40)), resale: [] })).toThrow(/at least one resale scenario/);
  });
});

// ---------------------------------------------------------------------------
// Graders.
// ---------------------------------------------------------------------------
describe("each grader is priced on its OWN scale", () => {
  const deal = (graderId: string, gradeKey: string): DealInputs => ({
    strategy: "GRADE",
    acquisition: { price: gbp(50), sellerPostage: gbp(0), importCharges: gbp(0), otherAcquisitionCosts: gbp(0) },
    grading: {
      graderId,
      serviceFee: gbp(20),
      submissionPostage: gbp(0),
      returnPostage: gbp(0),
      batchInsurance: gbp(0),
      batchSize: 1,
      consumablesPerCard: gbp(0),
    },
    sale: {},
    resale: [{ gradeKey, value: gbp(400) }],
    fx: FX,
  });

  it("prices CGC's half grades, which do not exist on PSA's scale", () => {
    const result = calculateDeal(deal("CGC", "CGC_9_5"));
    expect(result.scenarios[0]!.gradeLabel).toBe("Mint+ 9.5");
  });

  it("distinguishes CGC's two tens — Pristine 10 is not Gem Mint 10", () => {
    expect(calculateDeal(deal("CGC", "CGC_PRISTINE_10")).scenarios[0]!.gradeLabel).toBe("Pristine 10");
    expect(calculateDeal(deal("CGC", "CGC_GEM_MINT_10")).scenarios[0]!.gradeLabel).toBe("Gem Mint 10");
  });

  it("refuses a PSA grade key on a CGC deal", () => {
    expect(() => calculateDeal(deal("CGC", "PSA_9"))).toThrow(/not a grade on CGC/);
  });

  it("refuses a grader whose scale is not on file, rather than inventing one", () => {
    expect(() => calculateDeal(deal("BGS", "PSA_9"))).toThrow(/No published grade scale/);
  });

  it("never carries fee data for any grader — fees are the operator's own numbers", () => {
    // Selecting CGC must not populate anything; the fee used is the one
    // supplied above and nothing else.
    const result = calculateDeal(deal("CGC", "CGC_9"));
    expect(result.grading.lines.find((l) => l.key === "serviceFee")!.gbp).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Buyer-paid shipping, and the foreign-reference flag.
// ---------------------------------------------------------------------------
describe("buyer-paid shipping is revenue, and is taxed as revenue", () => {
  const withShipping = (buyerPaid: number) =>
    calculateDeal({
      strategy: "FLIP",
      acquisition: { price: gbp(40), sellerPostage: gbp(0), importCharges: gbp(0), otherAcquisitionCosts: gbp(0) },
      sale: { buyerPaidShipping: gbp(buyerPaid), outboundPostage: gbp(3), packaging: gbp(0.75), saleInsurance: gbp(0) },
      resale: [{ value: gbp(90) }],
      fx: FX,
    });

  it("adds buyer-paid postage to the buyer payment AND to the fee base", () => {
    const free = withShipping(0).scenarios[0]!;
    const charged = withShipping(4).scenarios[0]!;
    expect(charged.buyerPayment).toBe(94);
    expect(charged.sellingFees!).toBeGreaterThan(free.sellingFees!);
  });

  it("still deducts the real fulfilment cost — shipping revenue is not free money", () => {
    const charged = withShipping(4).scenarios[0]!;
    expect(charged.fulfilmentCosts).toBe(3.75); // 3.00 + 0.75 + 0
    // fees on 94: 10.25 + 0.33 + 0.40 = 10.98 ex VAT, +20% = 2.20, = 13.18
    // proceeds: 94.00 - 13.18 - 3.00 - 0.75 = 77.07
    // profit:   77.07 - 40.00 = 37.07
    expect(charged.sellingFees).toBe(13.18);
    expect(charged.netSaleProceeds).toBe(77.07);
    expect(charged.netProfit).toBe(37.07);
  });

  it("returns whole pennies, never a floating-point tail", () => {
    // This assertion is the reason the test above is written as three
    // explicit figures rather than an arithmetic expression: recomputing
    // 77.07 - 40 in JavaScript gives 37.06999999999999. The calculator
    // rounds every monetary output to the penny precisely so a displayed
    // figure and a stored figure can never disagree in the fourteenth
    // decimal place.
    const charged = withShipping(4).scenarios[0]!;
    for (const value of [charged.netProfit!, charged.netSaleProceeds!, charged.sellingFees!, charged.totalCost]) {
      // Note the shape of this check: `value * 100` is ITSELF unsafe
      // (77.07 * 100 === 7706.999999999999), so the property to assert is
      // that the value survives a round trip through pennies unchanged,
      // not that multiplying it by 100 yields an integer.
      expect(Math.round(value * 100) / 100).toBe(value);
    }
  });
});

describe("a converted foreign valuation stays labelled as a foreign reference", () => {
  it("keeps the flag on the scenario — conversion into GBP is not domestic evidence", () => {
    const result = calculateDeal({
      strategy: "FLIP",
      acquisition: { price: gbp(40), sellerPostage: gbp(0), importCharges: gbp(0), otherAcquisitionCosts: gbp(0) },
      sale: {},
      resale: [{ value: usd(150), valuationSource: "US eBay sold", foreignMarketReference: true }],
      fx: FX,
    });
    const scenario = result.scenarios[0]!;
    expect(scenario.foreignMarketReference).toBe(true);
    expect(scenario.saleValueGbp).toBe(118.5); // 150 x 0.79
    expect(scenario.valuationSource).toBe("US eBay sold");
  });
});

// ---------------------------------------------------------------------------
// One FX snapshot per calculation.
// ---------------------------------------------------------------------------
describe("one rate snapshot governs a whole calculation", () => {
  it("the snapshot travels out with the result, so a saved deal reproduces its own pennies", () => {
    const result = calculateDeal({
      strategy: "FLIP",
      acquisition: { price: usd(100), sellerPostage: gbp(0), importCharges: gbp(0), otherAcquisitionCosts: gbp(0) },
      sale: {},
      resale: [{ value: gbp(200) }],
      fx: FX,
    });
    expect(result.fx).toEqual(FX);
    expect(result.fx.source).toBe("LIVE");
    expect(result.fx.capturedAt).toBe("2026-09-12T00:00:00.000Z");
  });

  it("every converted line in one calculation used the same rate", () => {
    const result = calculateDeal({
      strategy: "FLIP",
      acquisition: {
        price: usd(100),
        sellerPostage: usd(10),
        importCharges: usd(5),
        otherAcquisitionCosts: gbp(0),
      },
      sale: {},
      resale: [{ value: usd(400) }],
      fx: FX,
    });
    const rates = result.acquisition.lines.filter((l) => l.detail.originalCurrency === "USD").map((l) => l.detail.rateToGbp);
    expect(new Set(rates)).toEqual(new Set([0.79]));
    expect(result.acquisition.total).toBe(90.85); // 79 + 7.90 + 3.95 + 0
  });
});

// ---------------------------------------------------------------------------
// Break-even, independently.
// ---------------------------------------------------------------------------
describe("break-even is solved, not guessed", () => {
  it("matches a hand calculation: £43.50 of cost, £2.30 fulfilment, no buyer shipping -> £53.50", () => {
    expect(solveBreakEvenSalePrice(43.5, 0, 2.3, DEFAULT_EXIT_MARKET_FEE_MODEL)).toBe(53.5);
  });

  it("falls as buyer-paid shipping rises, because the buyer covers some of the cost", () => {
    const none = solveBreakEvenSalePrice(43.5, 0, 2.3, DEFAULT_EXIT_MARKET_FEE_MODEL)!;
    const some = solveBreakEvenSalePrice(43.5, 4, 2.3, DEFAULT_EXIT_MARKET_FEE_MODEL)!;
    expect(some).toBeLessThan(none);
  });

  it("is never negative, even when costs are zero", () => {
    expect(solveBreakEvenSalePrice(0, 0, 0, DEFAULT_EXIT_MARKET_FEE_MODEL)!).toBeGreaterThanOrEqual(0);
  });
});

/**
 * REGRESSION GUARD for the break-even solver's piecewise problem.
 *
 * eBay's per-order fee steps at £10 of buyer payment (£0.30 at or below,
 * £0.40 above). Selling fees are therefore only PIECEWISE affine in the item
 * price, and the original solver — which probed at £0 and £100, straddling
 * that step — recovered its intercept from the cheap side while the answer
 * landed on the dear side. It returned £53.44 where the truth is £53.50.
 *
 * Six pence, in the direction that says a losing sale breaks even.
 *
 * It hid for as long as it did because the seed fee model used £0.40 on BOTH
 * sides of the threshold, which made the step zero and the bug unobservable.
 * These tests use a fee model with a REAL step in it, so the bug cannot come
 * back the same way, and they assert the property rather than the number:
 * selling at the quoted break-even must never lose money.
 */
describe("break-even is exact across the per-order fee step", () => {
  const stepped: ExitMarketFeeModel = {
    ...DEFAULT_EXIT_MARKET_FEE_MODEL,
    perOrderFee: 0.4,
    perOrderFeeBelowThreshold: 0.3,
    perOrderFeeThreshold: 10,
  };

  const profitAtPrice = (price: number, cost: number, shipping: number, fulfilment: number) => {
    const fees = computeSellingFees({ itemPrice: price, buyerPaidShipping: shipping }, stepped);
    return Math.round((price + shipping - fees.totalSellingFees - fulfilment - cost) * 100) / 100;
  };

  it("never quotes a break-even at which the sale still loses money", () => {
    // Swept across the step, above it, and far beyond it.
    for (const cost of [0.5, 2, 5, 7.5, 8.5, 9, 11, 20, 43.5, 114.06, 500, 2500]) {
      for (const shipping of [0, 3.95, 12]) {
        for (const fulfilment of [0, 2.3, 6]) {
          const be = solveBreakEvenSalePrice(cost, shipping, fulfilment, stepped);
          expect(be).not.toBeNull();
          expect(profitAtPrice(be!, cost, shipping, fulfilment)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("quotes the LOWEST such price — one penny less must lose money", () => {
    for (const cost of [5, 9, 11, 43.5, 114.06, 500]) {
      for (const shipping of [0, 3.95]) {
        const be = solveBreakEvenSalePrice(cost, shipping, 2.3, stepped)!;
        if (be <= 0.01) continue;
        expect(profitAtPrice(Math.round((be - 0.01) * 100) / 100, cost, shipping, 2.3)).toBeLessThan(0);
      }
    }
  });

  it("gets the hand-checked case right: £43.50 cost, £2.30 fulfilment -> £53.50", () => {
    expect(solveBreakEvenSalePrice(43.5, 0, 2.3, stepped)).toBe(53.5);
  });

  it("stays correct when the answer lands BELOW the step, where the cheap fee applies", () => {
    // A cheap card: break-even sits under £10, so the £0.30 fee is the right
    // one. Solving this band with the dear fee would overstate it.
    const be = solveBreakEvenSalePrice(5, 0, 0, stepped)!;
    expect(be).toBeLessThanOrEqual(10);
    expect(profitAtPrice(be, 5, 0, 0)).toBeGreaterThanOrEqual(0);
    expect(profitAtPrice(Math.round((be - 0.01) * 100) / 100, 5, 0, 0)).toBeLessThan(0);
  });
});

describe("the corrected sub-threshold per-order fee", () => {
  it("charges £0.30 at or below £10 of buyer payment and £0.40 above it", () => {
    // Verified 2026-09-12 against eBay's published business-seller fees.
    expect(computeSellingFees({ itemPrice: 9.99 }, DEFAULT_EXIT_MARKET_FEE_MODEL).perOrderFee).toBe(0.3);
    expect(computeSellingFees({ itemPrice: 10 }, DEFAULT_EXIT_MARKET_FEE_MODEL).perOrderFee).toBe(0.3);
    expect(computeSellingFees({ itemPrice: 10.01 }, DEFAULT_EXIT_MARKET_FEE_MODEL).perOrderFee).toBe(0.4);
  });

  it("counts buyer-paid postage toward the threshold, because eBay charges on the total", () => {
    // £8 item + £3 postage = £11 to the buyer, so the dear fee applies even
    // though the item itself is under £10.
    expect(computeSellingFees({ itemPrice: 8, buyerPaidShipping: 3 }, DEFAULT_EXIT_MARKET_FEE_MODEL).perOrderFee).toBe(0.4);
  });
});
