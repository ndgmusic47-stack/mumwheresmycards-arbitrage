import { describe, it, expect } from "vitest";
import {
  applyAmountEdit,
  applyProvenanceEdit,
  blankMoney,
  buildDealInputs,
  hasAmount,
  type DealFormState,
} from "../src/state/dealForm";
import type { DealGradeRung, MoneyInput } from "../src/api/client";

/**
 * These assert the three rules that decide whether a displayed profit is
 * honest, at the only layer where they can go wrong before the server sees
 * them: blank is not zero, a typed figure is not "confirmed", and an unpriced
 * grade is omitted rather than sent as £0.
 *
 * The calculation itself is tested exhaustively in
 * packages/core/test/dealCalculator.test.ts. Nothing here recomputes money —
 * this is purely about what leaves the browser.
 */

const RUNGS: DealGradeRung[] = [
  { value: 10, label: "PSA 10 Gem Mint", key: "PSA_10" },
  { value: 9, label: "PSA 9 Mint", key: "PSA_9" },
  { value: 8, label: "PSA 8 NM-MT", key: "PSA_8" },
];

const confirmed = (amount: number, currency = "GBP"): MoneyInput => ({ amount, currency, provenance: "CONFIRMED" });

function formState(overrides: Partial<DealFormState> = {}): DealFormState {
  return {
    strategy: "GRADE",
    acquisition: {
      price: confirmed(40),
      sellerPostage: blankMoney(),
      importCharges: blankMoney(),
      otherAcquisitionCosts: blankMoney(),
    },
    grading: {
      graderId: "PSA",
      serviceName: "Value",
      serviceFee: confirmed(23),
      submissionPostage: blankMoney(),
      returnPostage: blankMoney(),
      batchInsurance: blankMoney(),
      batchSize: 10,
      consumablesPerCard: blankMoney(),
      upcharge: blankMoney(),
      upchargeAppliesToGradeKeys: [],
    },
    sale: {
      buyerPaidShipping: blankMoney(),
      outboundPostage: blankMoney(),
      packaging: blankMoney(),
      saleInsurance: blankMoney(),
    },
    resaleByGrade: {},
    valuationSource: "",
    valuationDate: "",
    foreignMarketReference: false,
    ...overrides,
  };
}

describe("a blank box is not zero", () => {
  it("clearing the amount resets the field to not-known", () => {
    const edited = applyAmountEdit(confirmed(12.5), "");
    expect(edited.amount).toBeNull();
    expect(edited.provenance).toBe("UNKNOWN");
  });

  it("whitespace only is still blank, not NaN", () => {
    expect(applyAmountEdit(confirmed(12.5), "   ").amount).toBeNull();
  });

  it("an unparseable entry becomes not-known rather than NaN", () => {
    const edited = applyAmountEdit(blankMoney(), "abc");
    expect(edited.amount).toBeNull();
    expect(edited.provenance).toBe("UNKNOWN");
  });

  it("a CONFIRMED ZERO is preserved — 'the seller charged me nothing' is a real fact", () => {
    const zero = applyAmountEdit({ ...blankMoney(), provenance: "CONFIRMED" }, "0");
    expect(zero.amount).toBe(0);
    expect(zero.provenance).toBe("CONFIRMED");
    expect(hasAmount(zero)).toBe(true);
  });

  it("distinguishes a confirmed zero from a blank", () => {
    expect(hasAmount(confirmed(0))).toBe(true);
    expect(hasAmount(blankMoney())).toBe(false);
  });
});

describe("a typed figure needs a source", () => {
  it("typing into an unknown field makes it the operator's estimate, never 'confirmed'", () => {
    const edited = applyAmountEdit(blankMoney(), "18.99");
    expect(edited.amount).toBe(18.99);
    expect(edited.provenance).toBe("ESTIMATE");
  });

  it("editing an already-confirmed figure does not downgrade it", () => {
    expect(applyAmountEdit(confirmed(20), "21").provenance).toBe("CONFIRMED");
  });

  it("choosing 'not known' clears the amount, so the two can never contradict", () => {
    const edited = applyProvenanceEdit(confirmed(30), "UNKNOWN");
    expect(edited.amount).toBeNull();
    expect(edited.provenance).toBe("UNKNOWN");
  });

  it("choosing any other provenance leaves the figure alone", () => {
    expect(applyProvenanceEdit(confirmed(30), "PROVIDER")).toEqual({ amount: 30, currency: "GBP", provenance: "PROVIDER" });
  });
});

describe("only priced outcomes are sent", () => {
  it("omits grades with no valuation rather than sending them as zero", () => {
    const payload = buildDealInputs(
      formState({ resaleByGrade: { PSA_10: confirmed(700), PSA_9: blankMoney() } }),
      RUNGS,
    );
    const resale = payload.resale as { gradeKey: string }[];
    expect(resale.map((r) => r.gradeKey)).toEqual(["PSA_10"]);
  });

  it("sends a priced zero — 'this grade is worth nothing to me' is an assertion, not a gap", () => {
    const payload = buildDealInputs(formState({ resaleByGrade: { PSA_8: confirmed(0) } }), RUNGS);
    const resale = payload.resale as { gradeKey: string; value: MoneyInput }[];
    expect(resale).toHaveLength(1);
    expect(resale[0]!.value.amount).toBe(0);
  });

  it("never sends an empty resale array, so the server always has a scenario to report against", () => {
    const payload = buildDealInputs(formState({ resaleByGrade: {} }), RUNGS);
    expect((payload.resale as unknown[]).length).toBe(1);
  });

  it("carries the valuation source, date and foreign-market flag onto every scenario", () => {
    const payload = buildDealInputs(
      formState({
        resaleByGrade: { PSA_10: confirmed(700), PSA_9: confirmed(300) },
        valuationSource: "Terapeak UK sold, 8 comps",
        valuationDate: "2026-09-01",
        foreignMarketReference: true,
      }),
      RUNGS,
    );
    for (const entry of payload.resale as { valuationSource: string; foreignMarketReference: boolean }[]) {
      expect(entry.valuationSource).toBe("Terapeak UK sold, 8 comps");
      expect(entry.foreignMarketReference).toBe(true);
    }
  });

  it("a flip sends exactly one raw scenario and no grading block at all", () => {
    const payload = buildDealInputs(
      formState({ strategy: "FLIP", resaleByGrade: { RAW: confirmed(90) } }),
      [],
    );
    expect(payload.grading).toBeUndefined();
    const resale = payload.resale as { gradeKey?: string; value: MoneyInput }[];
    expect(resale).toHaveLength(1);
    expect(resale[0]!.gradeKey).toBeUndefined();
    expect(resale[0]!.value.amount).toBe(90);
  });
});

describe("the payload never carries a computed figure", () => {
  it("sends inputs only — no totals, so the worker stays the single implementation", () => {
    const payload = buildDealInputs(formState({ resaleByGrade: { PSA_10: confirmed(700) } }), RUNGS);
    expect(Object.keys(payload).sort()).toEqual(["acquisition", "grading", "resale", "sale", "strategy"]);
  });

  it("does not send an FX snapshot — the server picks the rates, so they cannot be tampered with", () => {
    const payload = buildDealInputs(formState(), RUNGS);
    expect(payload.fx).toBeUndefined();
  });
});

describe("upcharge targeting", () => {
  it("drops grade keys that are not being priced, so a stale key cannot charge the wrong rung", () => {
    const state = formState();
    state.grading.upcharge = confirmed(40);
    // CGC_PRISTINE_10 is left over from having had CGC selected earlier.
    state.grading.upchargeAppliesToGradeKeys = ["PSA_10", "CGC_PRISTINE_10"];
    const payload = buildDealInputs(state, RUNGS);
    expect((payload.grading as { upchargeAppliesToGradeKeys: string[] }).upchargeAppliesToGradeKeys).toEqual(["PSA_10"]);
  });

  it("an empty list is preserved, meaning 'charge it to every outcome'", () => {
    const state = formState();
    state.grading.upcharge = confirmed(40);
    const payload = buildDealInputs(state, RUNGS);
    expect((payload.grading as { upchargeAppliesToGradeKeys: string[] }).upchargeAppliesToGradeKeys).toEqual([]);
  });
});

describe("optional text fields", () => {
  it("an untouched service name is sent as null, not an empty string", () => {
    const state = formState();
    state.grading.serviceName = "   ";
    const payload = buildDealInputs(state, RUNGS);
    expect((payload.grading as { serviceName: string | null }).serviceName).toBeNull();
  });

  it("an untouched valuation source is null, so 'no stated source' is visible as such", () => {
    const payload = buildDealInputs(formState({ resaleByGrade: { PSA_9: confirmed(300) } }), RUNGS);
    expect((payload.resale as { valuationSource: string | null }[])[0]!.valuationSource).toBeNull();
  });
});
