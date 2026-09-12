import type { MoneyInput, MoneyProvenance, DealGradeRung } from "../api/client";

/**
 * THE FORM ↔ PAYLOAD BOUNDARY for the per-card deal desk.
 *
 * Extracted out of the component on purpose. `apps/web` has no DOM test
 * environment (see vitest.config.ts), and the rules enforced here are exactly
 * the ones that decide whether a profit figure is honest:
 *
 *   - A BLANK BOX IS NOT ZERO. It is "I don't know this yet", and it must
 *     travel to the server as such so the calculation reports it missing
 *     rather than quietly costing it at nothing.
 *   - A TYPED FIGURE NEEDS A SOURCE. Typing a number promotes an UNKNOWN
 *     field to the operator's own estimate — never to CONFIRMED, which is a
 *     claim only they can make.
 *   - ONLY PRICED OUTCOMES ARE SENT. A grade with no valuation is omitted
 *     entirely rather than sent as a £0 scenario, which would render as a
 *     guaranteed loss the operator never asserted.
 *
 * Leaving these inline in JSX would have made them untestable, and they are
 * the three most expensive things in this feature to get wrong.
 */

export const BLANK_MONEY: MoneyInput = { amount: null, currency: "GBP", provenance: "UNKNOWN" };

export function blankMoney(): MoneyInput {
  return { ...BLANK_MONEY };
}

/** Whether a field carries a usable figure. Zero IS a figure; blank is not. */
export function hasAmount(input: MoneyInput | undefined | null): boolean {
  return !!input && input.amount !== null && input.amount !== undefined && Number.isFinite(input.amount);
}

/**
 * What editing the amount box does.
 *
 * Clearing it resets to UNKNOWN — the two can never contradict each other,
 * because "provenance: CONFIRMED, amount: null" would be a field claiming to
 * be a confirmed nothing.
 */
export function applyAmountEdit(current: MoneyInput, raw: string): MoneyInput {
  if (raw.trim() === "") return { ...current, amount: null, provenance: "UNKNOWN" };
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return { ...current, amount: null, provenance: "UNKNOWN" };
  return {
    ...current,
    amount,
    provenance: current.provenance === "UNKNOWN" ? "ESTIMATE" : current.provenance,
  };
}

/** What choosing a provenance does. Selecting "not known" clears the amount. */
export function applyProvenanceEdit(current: MoneyInput, provenance: MoneyProvenance): MoneyInput {
  if (provenance === "UNKNOWN") return { ...current, provenance, amount: null };
  return { ...current, provenance };
}

/**
 * OPTIONAL MEANS "THIS DESK DOESN'T ASK ABOUT THAT COST" (2026-09-12).
 *
 * Every field except the purchase price is optional, and an omitted one is
 * omitted from the payload — it does not travel as a blank. The distinction
 * matters and is enforced on the far side in packages/core's buildAcquisition:
 * an absent cost produces no line, a present-but-blank cost produces a line
 * reported as missing. Sending blanks for fields the form stopped showing
 * would leave the operator with costs they can never fill in and a purchase
 * that can never be recorded; sending zeros would be this application
 * asserting a cost on their behalf.
 */
export interface DealFormState {
  strategy: "FLIP" | "GRADE";
  acquisition: {
    price: MoneyInput;
    sellerPostage?: MoneyInput;
    importCharges?: MoneyInput;
    otherAcquisitionCosts?: MoneyInput;
  };
  grading: {
    graderId: string;
    serviceName?: string;
    serviceFee: MoneyInput;
    submissionPostage?: MoneyInput;
    returnPostage?: MoneyInput;
    batchInsurance?: MoneyInput;
    batchSize: number;
    consumablesPerCard?: MoneyInput;
    upcharge?: MoneyInput;
    upchargeAppliesToGradeKeys?: string[];
  };
  sale: {
    buyerPaidShipping?: MoneyInput;
    outboundPostage?: MoneyInput;
    packaging?: MoneyInput;
    saleInsurance?: MoneyInput;
  };
  resaleByGrade: Record<string, MoneyInput>;
  valuationSource?: string;
  valuationDate?: string;
  foreignMarketReference?: boolean;
}

/**
 * Builds the request body. Deliberately returns INPUTS ONLY — no totals, no
 * derived figures. The worker recomputes everything from these, so there is
 * exactly one implementation of the economics and the browser cannot drift
 * from it.
 */
export function buildDealInputs(state: DealFormState, pricedRungs: DealGradeRung[]): Record<string, unknown> {
  const meta = {
    valuationSource: state.valuationSource?.trim() || null,
    valuationDate: state.valuationDate?.trim() || null,
    foreignMarketReference: state.foreignMarketReference === true,
  };

  const resale =
    state.strategy === "GRADE"
      ? pricedRungs
          .filter((rung) => hasAmount(state.resaleByGrade[rung.key]))
          .map((rung) => ({ gradeKey: rung.key, value: state.resaleByGrade[rung.key]!, ...meta }))
      : [{ value: state.resaleByGrade.RAW ?? blankMoney(), ...meta }];

  return {
    strategy: state.strategy,
    acquisition: state.acquisition,
    grading:
      state.strategy === "GRADE"
        ? {
            ...state.grading,
            serviceName: state.grading.serviceName?.trim() || null,
            // Only grades actually being priced can trigger an upcharge. A
            // stale key left over from switching grader would otherwise
            // silently apply a charge to nothing, or to the wrong rung.
            upchargeAppliesToGradeKeys: (state.grading.upchargeAppliesToGradeKeys ?? []).filter((key) =>
              pricedRungs.some((rung) => rung.key === key),
            ),
          }
        : undefined,
    sale: state.sale,
    // Never an empty array: the server needs one scenario to report against,
    // and an unpriced one correctly reports itself as missing its valuation.
    resale: resale.length > 0 ? resale : [{ value: blankMoney(), ...meta }],
  };
}
