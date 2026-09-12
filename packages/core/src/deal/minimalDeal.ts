import type { DealInputs } from "./dealCalculator.js";
import type { FxSnapshot, MoneyInput } from "./money.js";

/**
 * THE SMALLEST HONEST DEAL: one figure the operator stated, everything else
 * explicitly not known.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. Offers hang off deals, so until now the only way to put a
 * card "under offer" was to open its desk and save a full set of assumptions
 * first. From the pipeline — where the operator is actually looking at their
 * leads and deciding which to bid on — there was no way to do it at all.
 *
 * WHAT THIS IS NOT: a deal with defaults filled in. The offer amount is the
 * ONLY populated field. Every other cost comes back as UNKNOWN, which the
 * calculator reports as a named missing input and which the purchase route
 * refuses to commit against. Nothing here can produce an apparently complete
 * profit figure, because there is nothing here to produce one from.
 *
 * THE PRICE IS AN ESTIMATE, NOT CONFIRMED. An offer is what the operator has
 * asked to pay, not what they have paid. CONFIRMED is a claim only they can
 * make, and only once money has moved — so a quick offer can never write one.
 *
 * batchSize DEFAULTS TO 10, and that is a genuine default rather than a
 * measurement: it is a count of cards in a planned batch, not money, and the
 * calculator labels every batch line "(planned batch)" until a real batch
 * replaces it. It cannot make a cost look known — all three batch costs are
 * still UNKNOWN, so nothing is divided by it yet.
 * ─────────────────────────────────────────────────────────────────────────
 */

const UNKNOWN: MoneyInput = { amount: null, provenance: "UNKNOWN" };
const unknown = (): MoneyInput => ({ ...UNKNOWN });

/** The planned batch size a quick offer assumes until the operator sets one. */
export const DEFAULT_PLANNED_BATCH_SIZE = 10;

export function minimalDealInputs(params: {
  strategy: "FLIP" | "GRADE";
  /** Required for GRADE. Must be a grader with a published scale on file. */
  graderId?: string | null;
  /** The offer itself — the one thing actually known. */
  offerAmount: number;
  offerCurrency: string;
  fx: FxSnapshot;
}): DealInputs {
  const price: MoneyInput = {
    amount: params.offerAmount,
    currency: params.offerCurrency,
    provenance: "ESTIMATE",
  };

  const base = {
    acquisition: {
      price,
      sellerPostage: unknown(),
      importCharges: unknown(),
      otherAcquisitionCosts: unknown(),
    },
    sale: {},
    // One unpriced outcome. An empty array is rejected by the route, and a
    // £0 valuation would render as a guaranteed loss the operator never
    // asserted — so the single entry carries a blank value and reports
    // itself missing.
    resale: [{ value: unknown() }],
    fx: params.fx,
  };

  if (params.strategy === "FLIP") {
    return { strategy: "FLIP", ...base };
  }

  return {
    strategy: "GRADE",
    ...base,
    grading: {
      graderId: params.graderId ?? "PSA",
      serviceName: null,
      serviceFee: unknown(),
      submissionPostage: unknown(),
      returnPostage: unknown(),
      batchInsurance: unknown(),
      batchSize: DEFAULT_PLANNED_BATCH_SIZE,
      consumablesPerCard: unknown(),
    },
  };
}
