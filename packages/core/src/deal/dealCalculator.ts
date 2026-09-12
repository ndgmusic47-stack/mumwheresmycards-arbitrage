import type { ExitMarketFeeModel } from "../calc/fees.js";
import { DEFAULT_EXIT_MARKET_FEE_MODEL } from "../calc/fees.js";
import type { SellingCostSettings } from "../calc/types.js";
import { DEFAULT_SELLING_COSTS } from "../calc/types.js";
import { computeNetSaleProceeds } from "../calc/netSaleProceeds.js";
import { computeSellingFees } from "../calc/fees.js";
import type { FxSnapshot, MoneyInput, ResolvedMoney } from "./money.js";
import { resolveMoney, contribution, roundMoney, conversionSpreadMissing } from "./money.js";
import type { GradeRung, GraderScale } from "./graderScales.js";
import { graderScale } from "./graderScales.js";

/**
 * THE PER-CARD DEAL CALCULATOR.
 *
 * Deterministic arithmetic over the operator's OWN saved inputs. No model
 * ever touches these numbers — an LLM in this system may narrate a result it
 * was handed, never produce or adjust one (the discipline this codebase has
 * carried since AiModelProvider.ts: "NEVER A SOURCE OF FINANCIAL NUMBERS").
 *
 * WHY THIS IS NOT the scan-time engine, and does not replace it. The engine
 * (opportunity/engine.ts) prices a listing against PROVIDER data at scan
 * time, across thousands of rows, to decide what is worth looking at. This
 * prices ONE card against what the OPERATOR actually believes and has
 * actually agreed — their offer, their postage, their grader's real invoice,
 * their own researched resale figures. Different inputs, different purpose,
 * different lifetime. It reuses the same primitives
 * (computeNetSaleProceeds / computeSellingFees) rather than restating them,
 * so a fee change lands in both at once and the two can never disagree about
 * what eBay charges.
 *
 * FOUR PROPERTIES THAT MATTER MORE THAN THE ARITHMETIC:
 *
 *  1. EVERY COST APPEARS EXACTLY ONCE. The breakdown is built by summing
 *     named lines, and the named lines ARE the total — there is no separate
 *     "total" expression that could drift from the lines shown.
 *
 *  2. UNKNOWN NEVER MASQUERADES AS ZERO. Any input the operator has not
 *     supplied is named in `missingInputs`, and `isComplete` is false. A
 *     profit figure with a missing line is still shown — hiding it would be
 *     worse — but it can never be mistaken for a finished one.
 *
 *  3. UPCHARGES ARE PER-SCENARIO. A declared-value upcharge that only bites
 *     when the card comes back a 10 is charged ONLY to the 10 scenario. The
 *     previous engine-level behaviour applies one reserve across the whole
 *     ladder; that is a reasonable conservative default for ranking, and
 *     wrong for a deal sheet, where the operator is deciding against a
 *     specific outcome.
 *
 *  4. THE SHARED BATCH COST IS DIVIDED, NOT REPEATED. Submission postage,
 *     return postage and insurance are BATCH costs. Each card carries
 *     total/batchSize. A batch of one carries all of it — correctly, because
 *     that is what sending one card actually costs.
 */

export const DEAL_CALC_VERSION = "deal-calc-1";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AcquisitionInputs {
  /** Offer or agreed purchase price for the card itself. */
  price: MoneyInput;
  /** Postage the SELLER charges to send it to us. */
  sellerPostage?: MoneyInput;
  /** Import duty/VAT/handling actually applicable on the way in. */
  importCharges?: MoneyInput;
  /** Anything else spent to acquire: payment fees, commission, fuel. */
  otherAcquisitionCosts?: MoneyInput;
}

export interface GradingInputs {
  graderId: string;
  /** The grader's own service/tier name, as the operator selected it. Free
   *  text on purpose: tiers change, and this must not be a closed list that
   *  goes stale. */
  serviceName?: string | null;
  /** What the grader charges for THIS card at THIS tier. */
  serviceFee: MoneyInput;
  /** BATCH costs — divided by batchSize, never charged whole per card. */
  submissionPostage?: MoneyInput;
  returnPostage?: MoneyInput;
  batchInsurance?: MoneyInput;
  /**
   * How many cards share the batch costs above. Must be a positive integer.
   * When this deal belongs to a real batch, pass that batch's actual member
   * count so the estimate is replaced by the real allocation.
   */
  batchSize: number;
  /** True once batchSize came from a real batch rather than a plan. */
  batchSizeIsActual?: boolean;
  /** Sleeves, card savers, tape — genuinely per card, never divided. */
  consumablesPerCard?: MoneyInput;
  /**
   * Declared-value upcharge, and WHICH outcomes actually trigger it.
   * `appliesToGradeKeys` empty or omitted => applied to every graded
   * scenario (the conservative reading). Naming keys restricts it to those
   * outcomes only — which is the honest treatment when the upcharge depends
   * on the slab's value, and the slab's value depends on the grade.
   */
  upcharge?: MoneyInput;
  upchargeAppliesToGradeKeys?: string[];
}

export interface ResaleInput {
  /** Grade rung key from the selected grader's scale (see graderScales.ts).
   *  Omitted for the raw/flip scenario. */
  gradeKey?: string;
  /** What the operator expects this outcome to sell for. */
  value: MoneyInput;
  /** Where the valuation came from, and when. Free text; never parsed. */
  valuationSource?: string | null;
  /** ISO date the valuation was taken. */
  valuationDate?: string | null;
  /**
   * TRUE when the valuation is a converted foreign-market reference rather
   * than observed domestic resale evidence. A US comp converted into GBP is
   * still a US-market reference; this flag keeps that visible on the output
   * instead of letting the currency conversion launder it into local
   * evidence.
   */
  foreignMarketReference?: boolean;
}

export interface SaleSideInputs {
  /** Postage the BUYER pays on top — revenue, and part of the fee base. */
  buyerPaidShipping?: MoneyInput;
  /** What it actually costs us to fulfil. */
  outboundPostage?: MoneyInput;
  packaging?: MoneyInput;
  saleInsurance?: MoneyInput;
}

export interface DealInputs {
  strategy: "FLIP" | "GRADE";
  acquisition: AcquisitionInputs;
  /** Required for GRADE, ignored for FLIP. */
  grading?: GradingInputs;
  sale: SaleSideInputs;
  /** One entry per outcome being priced. FLIP uses a single entry with no
   *  gradeKey (the raw resale scenario). */
  resale: ResaleInput[];
  fx: FxSnapshot;
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface CostLine {
  key: string;
  label: string;
  gbp: number;
  detail: ResolvedMoney;
  /** Set when this line is a per-card share of a batch cost. */
  allocation?: { batchTotalGbp: number; batchSize: number; isActual: boolean };
}

export interface CostBlock {
  lines: CostLine[];
  total: number;
}

export interface ScenarioResult {
  /** null for the raw/flip scenario. */
  gradeKey: string | null;
  gradeLabel: string;
  /** Every cost committed to reach a saleable item in this outcome. */
  totalCost: number;
  /** Costs specific to this outcome (an upcharge that only this grade trips). */
  scenarioOnlyCosts: CostLine[];
  saleValueGbp: number | null;
  buyerPaidShippingGbp: number;
  buyerPayment: number | null;
  sellingFees: number | null;
  fulfilmentCosts: number;
  netSaleProceeds: number | null;
  netProfit: number | null;
  /** Net profit / total cost. null when cost is 0 or the sale side is unknown. */
  returnOnCost: number | null;
  /**
   * The item price at which this scenario exactly breaks even, under the
   * configured fee model — solved, not searched.
   */
  breakEvenSalePrice: number | null;
  valuationSource: string | null;
  valuationDate: string | null;
  foreignMarketReference: boolean;
  missingInputs: string[];
  isComplete: boolean;
}

export interface DealCalculation {
  calcVersion: string;
  strategy: "FLIP" | "GRADE";
  acquisition: CostBlock;
  /** Empty for FLIP. */
  grading: CostBlock;
  /** Acquisition + grading — every pound committed before the card sells. */
  totalCostBeforeScenario: number;
  scenarios: ScenarioResult[];
  /** Union across every block and scenario. */
  missingInputs: string[];
  isComplete: boolean;
  /**
   * Things that are true of the figures but are not missing inputs — the
   * calculation is arithmetically complete and still worth a caveat.
   *
   * Kept separate from `missingInputs` on purpose. A missing input BLOCKS a
   * purchase from being recorded; a warning does not. Collapsing the two
   * would either stop a perfectly recordable purchase or bury a real caveat
   * among things that are merely blank.
   */
  warnings: string[];
  fx: FxSnapshot;
  graderScaleSourceUrl: string | null;
}

export class DealInputError extends Error {}

// ---------------------------------------------------------------------------

function sumLines(lines: CostLine[]): number {
  return roundMoney(lines.reduce((total, line) => total + line.gbp, 0));
}

function line(key: string, label: string, detail: ResolvedMoney): CostLine {
  return { key, label, gbp: contribution(detail), detail };
}

/**
 * Solves for the item price at which net profit is exactly zero.
 *
 * Selling fees are affine in the item price:
 *
 *   fees(p) = (p + shipping) * variablePct + perOrderFee, then * (1 + vat)
 *
 * so netProceeds(p) is affine and break-even has a closed form. It is solved
 * by evaluating the REAL fee function at two points to recover its slope and
 * intercept, rather than reimplementing the algebra — so it stays correct if
 * the fee model gains a term.
 *
 * BUT THE FUNCTION IS ONLY PIECEWISE AFFINE. eBay's per-order fee steps at a
 * threshold (£0.30 at or below £10 of buyer payment, £0.40 above it), so
 * there is a discontinuity in the intercept. The original implementation
 * probed at £0 and £100 — straddling that step — and recovered an intercept
 * from the cheap side while the answer landed on the dear side. It returned
 * £53.44 where the true break-even is £53.50: six pence light, in the
 * direction that says a losing sale breaks even.
 *
 * It went unnoticed because the seed fee model happened to use £0.40 on BOTH
 * sides of the threshold, which made the step zero and the bug invisible.
 * Correcting the sub-£10 fee to its real £0.30 is what exposed it.
 *
 * So: solve each regime separately against a probe pair that stays inside
 * that regime, keep only a solution that actually lands in the band it was
 * solved for, and take the cheapest such price. Then verify against the real
 * profit function and nudge up by a penny if rounding left it fractionally
 * short — break-even must never be quoted below the true figure.
 */
export function solveBreakEvenSalePrice(
  totalCost: number,
  buyerPaidShipping: number,
  fulfilmentCosts: number,
  feeModel: ExitMarketFeeModel,
): number | null {
  const proceedsAt = (itemPrice: number): number => {
    const fees = computeSellingFees({ itemPrice, buyerPaidShipping }, feeModel);
    return itemPrice + buyerPaidShipping - fees.totalSellingFees - fulfilmentCosts;
  };
  const profitAt = (itemPrice: number): number => roundMoney(proceedsAt(itemPrice) - totalCost);

  // The item price at which the buyer's payment reaches the per-order-fee
  // threshold. Below it the cheap fee applies, above it the dear one.
  const stepPrice = feeModel.perOrderFeeThreshold - buyerPaidShipping;

  /** Closed-form solve using two probes that both sit inside one regime. */
  const solveWithin = (probeLow: number, probeHigh: number): number | null => {
    const a = proceedsAt(probeLow);
    const b = proceedsAt(probeHigh);
    const slope = (b - a) / (probeHigh - probeLow);
    if (!Number.isFinite(slope) || slope <= 0) return null;
    // a = proceeds(probeLow), so the intercept at p = 0 is a - slope*probeLow.
    const intercept = a - slope * probeLow;
    const price = (totalCost - intercept) / slope;
    return Number.isFinite(price) ? price : null;
  };

  const candidates: number[] = [];

  // Regime 1: buyer payment at or below the threshold. Only exists when the
  // buyer's postage alone has not already exceeded it.
  if (stepPrice > 0) {
    const solved = solveWithin(0, stepPrice);
    if (solved !== null && solved >= 0 && solved <= stepPrice) candidates.push(solved);
  }

  // Regime 2: buyer payment above the threshold.
  const aboveStart = Math.max(stepPrice, 0) + 1;
  const solvedAbove = solveWithin(aboveStart, aboveStart + 100);
  if (solvedAbove !== null && solvedAbove > stepPrice) candidates.push(solvedAbove);

  // Already break-even at a price of zero. Happens when the buyer's postage
  // alone covers the cost — unusual, but it is a real answer, not a failure,
  // and the closed form goes negative here rather than reporting it.
  if (profitAt(0) >= 0) return 0;

  /*
   * THE CLOSED FORM IS THE BRACKET, NOT THE ANSWER.
   *
   * Fees are rounded to whole pennies at each component, so the real
   * function is a fine staircase rather than a true straight line. Two
   * probe points each carry their own sub-penny rounding residue, and
   * dividing by the gap between them propagates it into the slope. That is
   * enough to land the estimate a penny out either way — and a penny out
   * downward means quoting a break-even at which the sale still loses money.
   *
   * What IS reliable is that net profit never decreases as the price rises.
   * So the estimate is used only to locate a bracket, and the exact answer
   * is then found by bisection over whole pennies against the real profit
   * function. The result is correct by construction, for any monotone fee
   * model, including one with steps in it.
   */
  const pennies = (gbp: number) => Math.round(gbp * 100);
  const gbp = (p: number) => roundMoney(p / 100);

  // The estimate only seeds the bracket. If both regimes rejected their
  // solution the search still runs, from zero — a slower start, never a
  // wrong answer.
  const usable = candidates.filter((c) => Number.isFinite(c) && c >= 0);
  const estimate = usable.length > 0 ? Math.min(...usable) : 0;

  let low = Math.max(0, pennies(estimate) - 500);
  let high = pennies(estimate) + 500;

  // profitAt(0) < 0 is guaranteed above, so zero is always a valid lower
  // bound if the seeded one turns out to be too high.
  if (profitAt(gbp(low)) >= 0) low = 0;
  let guard = 0;
  while (profitAt(gbp(high)) < 0 && guard < 40) {
    high += Math.max(5000, high);
    guard += 1;
  }
  if (profitAt(gbp(high)) < 0) return null;

  // Invariant: profit(low) < 0 <= profit(high). Narrow to one penny.
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (profitAt(gbp(mid)) < 0) low = mid;
    else high = mid;
  }

  return gbp(high);
}

/*
 * ABSENT IS NOT UNKNOWN, AND NEITHER IS ZERO (2026-09-12).
 *
 * There are now THREE states a cost can be in, and conflating any two of them
 * produces a wrong number or a permanent false alarm:
 *
 *   absent (the key is not in the inputs at all)
 *       This deal does not model that cost. No line, nothing to report. A
 *       simplified desk that does not ask about batch insurance is not
 *       claiming the insurance was free — it is not asking.
 *
 *   present, amount null
 *       This cost exists and the operator does not know it yet. A line, shown
 *       as missing, and the purchase route refuses to commit against it.
 *
 *   present, amount given (zero included)
 *       A stated figure. A confirmed zero is a real statement — "this UK
 *       purchase had no import charges" — and is counted as one.
 *
 * Before this, every optional cost emitted a line whether or not it had been
 * asked about, so removing a field from the form turned it into a cost that
 * could never be filled in and blocked recording the purchase forever. The
 * alternative — having the form quietly send zero for the fields it stopped
 * showing — would have been the application asserting a cost on the
 * operator's behalf, which is the one thing this money model exists to
 * prevent.
 *
 * `price` is always emitted: a deal with no purchase price is not a deal.
 */
function buildAcquisition(inputs: AcquisitionInputs, fx: FxSnapshot): CostBlock {
  const lines: CostLine[] = [line("price", "Purchase price", resolveMoney("Purchase price", inputs.price, fx))];

  const optional: [keyof AcquisitionInputs, string, string][] = [
    ["sellerPostage", "sellerPostage", "Postage from seller"],
    ["importCharges", "importCharges", "Import charges"],
    ["otherAcquisitionCosts", "otherAcquisitionCosts", "Other acquisition costs"],
  ];
  for (const [field, key, label] of optional) {
    if (inputs[field] === undefined) continue;
    lines.push(line(key, label, resolveMoney(label, inputs[field], fx)));
  }

  return { lines, total: sumLines(lines) };
}

function buildGrading(grading: GradingInputs | undefined, fx: FxSnapshot): CostBlock {
  if (!grading) return { lines: [], total: 0 };

  if (!Number.isInteger(grading.batchSize) || grading.batchSize < 1) {
    throw new DealInputError(`Batch size must be a whole number of 1 or more (received ${JSON.stringify(grading.batchSize)}).`);
  }

  const serviceFee = resolveMoney("Grading service fee", grading.serviceFee, fx);
  const consumables = resolveMoney("Per-card consumables", grading.consumablesPerCard, fx);

  const lines: CostLine[] = [line("serviceFee", "Grading service fee", serviceFee)];

  // BATCH COSTS. Each is divided across the batch exactly once. The
  // allocation is reported alongside the figure so the user can see both the
  // batch total they actually paid and this card's share of it.
  // Absent batch costs are not asked about and so produce no line — see
  // buildAcquisition's note. A batch of ONE is not an allocation, so its
  // label says what the figure is rather than pretending to divide it.
  const batchEntries: [keyof GradingInputs, string, string][] = [
    ["submissionPostage", "submissionPostage", "Postage to grader"],
    ["returnPostage", "returnPostage", "Return postage"],
    ["batchInsurance", "batchInsurance", "Insurance"],
  ];
  const shared = grading.batchSize > 1;
  for (const [field, key, baseLabel] of batchEntries) {
    if (grading[field] === undefined) continue;
    const detail = resolveMoney(baseLabel, grading[field] as MoneyInput, fx);
    const batchTotal = contribution(detail);
    lines.push({
      key,
      label: shared ? `${baseLabel} (share of batch)` : baseLabel,
      gbp: roundMoney(batchTotal / grading.batchSize),
      detail,
      allocation: { batchTotalGbp: batchTotal, batchSize: grading.batchSize, isActual: grading.batchSizeIsActual === true },
    });
  }

  if (grading.consumablesPerCard !== undefined) {
    lines.push(line("consumablesPerCard", "Consumables (per card)", consumables));
  }
  return { lines, total: sumLines(lines) };
}

function scenarioUpcharge(grading: GradingInputs | undefined, gradeKey: string | null, fx: FxSnapshot): CostLine | null {
  if (!grading?.upcharge) return null;
  const resolved = resolveMoney("Declared-value upcharge", grading.upcharge, fx);
  if (resolved.missing) return null;

  const restrictedTo = grading.upchargeAppliesToGradeKeys;
  if (restrictedTo && restrictedTo.length > 0) {
    // Scenario-specific: only the named outcomes carry it. Charging it to
    // every rung would overstate the cost of the outcomes that never trip it.
    if (gradeKey === null || !restrictedTo.includes(gradeKey)) return null;
  }
  return line("upcharge", "Declared-value upcharge", resolved);
}

export function calculateDeal(
  inputs: DealInputs,
  feeModel: ExitMarketFeeModel = DEFAULT_EXIT_MARKET_FEE_MODEL,
  sellingCosts: SellingCostSettings = DEFAULT_SELLING_COSTS,
): DealCalculation {
  if (inputs.strategy === "GRADE" && !inputs.grading) {
    throw new DealInputError("A GRADE deal needs grading inputs — pick a grader and enter its fee, or switch the deal to FLIP.");
  }
  if (inputs.resale.length === 0) {
    throw new DealInputError("A deal needs at least one resale scenario to price against.");
  }

  const fx = inputs.fx;
  const acquisition = buildAcquisition(inputs.acquisition, fx);
  const grading = inputs.strategy === "GRADE" ? buildGrading(inputs.grading, fx) : { lines: [], total: 0 };
  const totalCostBeforeScenario = roundMoney(acquisition.total + grading.total);

  const scale: GraderScale | null = inputs.strategy === "GRADE" && inputs.grading ? graderScale(inputs.grading.graderId) : null;
  if (inputs.strategy === "GRADE" && inputs.grading && !scale) {
    throw new DealInputError(
      `No published grade scale is on file for grader "${inputs.grading.graderId}". Its outcomes cannot be priced without inventing them.`,
    );
  }

  const buyerPaidShipping = resolveMoney("Buyer-paid shipping", inputs.sale.buyerPaidShipping, fx);
  const outboundPostage = resolveMoney("Outbound postage", inputs.sale.outboundPostage, fx);
  const packaging = resolveMoney("Packaging", inputs.sale.packaging, fx);
  const saleInsurance = resolveMoney("Sale insurance", inputs.sale.saleInsurance, fx);

  // Sale-side costs the operator left blank fall back to the configured
  // business defaults rather than to zero — a postage cost of £0 is not a
  // credible omission, and the defaults are the operator's own settings.
  const fulfilment = {
    outboundPostage: outboundPostage.missing
      ? inputs.strategy === "GRADE"
        ? sellingCosts.outboundPostageGraded
        : sellingCosts.outboundPostage
      : contribution(outboundPostage),
    packaging: packaging.missing ? sellingCosts.packaging : contribution(packaging),
    insurance: saleInsurance.missing
      ? inputs.strategy === "GRADE"
        ? sellingCosts.saleInsuranceGraded
        : sellingCosts.saleInsurance
      : contribution(saleInsurance),
  };
  const fulfilmentTotal = roundMoney(fulfilment.outboundPostage + fulfilment.packaging + fulfilment.insurance);

  const blockMissing = [
    ...acquisition.lines.filter((l) => l.detail.missing).map((l) => l.label),
    ...grading.lines.filter((l) => l.detail.missing).map((l) => l.label),
  ];

  const scenarios: ScenarioResult[] = inputs.resale.map((entry) => {
    const gradeKey = entry.gradeKey ?? null;
    const rung: GradeRung | null = gradeKey && scale ? (scale.rungs.find((r) => r.key === gradeKey) ?? null) : null;
    if (gradeKey && scale && !rung) {
      throw new DealInputError(`"${gradeKey}" is not a grade on ${scale.graderName}'s scale.`);
    }

    const upchargeLine = inputs.strategy === "GRADE" ? scenarioUpcharge(inputs.grading, gradeKey, fx) : null;
    const scenarioOnlyCosts = upchargeLine ? [upchargeLine] : [];
    const totalCost = roundMoney(totalCostBeforeScenario + sumLines(scenarioOnlyCosts));

    const value = resolveMoney(`Resale value (${rung?.label ?? "raw"})`, entry.value, fx);
    const scenarioMissing = [...blockMissing];
    if (value.missing) scenarioMissing.push(`Resale value (${rung?.label ?? "raw"})`);

    const breakEvenSalePrice = solveBreakEvenSalePrice(totalCost, contribution(buyerPaidShipping), fulfilmentTotal, feeModel);

    if (value.missing) {
      return {
        gradeKey,
        gradeLabel: rung?.label ?? "Raw (ungraded)",
        totalCost,
        scenarioOnlyCosts,
        saleValueGbp: null,
        buyerPaidShippingGbp: contribution(buyerPaidShipping),
        buyerPayment: null,
        sellingFees: null,
        fulfilmentCosts: fulfilmentTotal,
        netSaleProceeds: null,
        netProfit: null,
        returnOnCost: null,
        breakEvenSalePrice,
        valuationSource: entry.valuationSource ?? null,
        valuationDate: entry.valuationDate ?? null,
        foreignMarketReference: entry.foreignMarketReference === true,
        missingInputs: scenarioMissing,
        isComplete: false,
      };
    }

    const sale = computeNetSaleProceeds(
      {
        itemPrice: value.gbp!,
        buyerPaidShipping: contribution(buyerPaidShipping),
        outboundPostage: fulfilment.outboundPostage,
        insurance: fulfilment.insurance,
        packaging: fulfilment.packaging,
      },
      feeModel,
      sellingCosts,
    );

    const netProfit = roundMoney(sale.netProceeds - totalCost);
    return {
      gradeKey,
      gradeLabel: rung?.label ?? "Raw (ungraded)",
      totalCost,
      scenarioOnlyCosts,
      saleValueGbp: value.gbp,
      buyerPaidShippingGbp: sale.buyerPaidShipping,
      buyerPayment: sale.buyerPayment,
      sellingFees: sale.fees.totalSellingFees,
      fulfilmentCosts: fulfilmentTotal,
      netSaleProceeds: sale.netProceeds,
      netProfit,
      returnOnCost: totalCost > 0 ? Math.round((netProfit / totalCost) * 10000) / 10000 : null,
      breakEvenSalePrice,
      valuationSource: entry.valuationSource ?? null,
      valuationDate: entry.valuationDate ?? null,
      foreignMarketReference: entry.foreignMarketReference === true,
      missingInputs: scenarioMissing,
      isComplete: scenarioMissing.length === 0,
    };
  });

  const allMissing = Array.from(new Set(scenarios.flatMap((s) => s.missingInputs)));

  const warnings: string[] = [];

  // Mid-market conversion with no spread configured. Only worth saying when
  // the deal actually converts something — a purely sterling deal is
  // unaffected by the FX settings and should not carry the caveat.
  const convertsForeignMoney = [...acquisition.lines, ...grading.lines].some(
    (l) => !l.detail.missing && l.detail.originalCurrency !== "GBP",
  );
  if (convertsForeignMoney && conversionSpreadMissing(fx)) {
    warnings.push(
      "Foreign costs are converted at the mid-market rate with no conversion spread set. " +
        "Your bank or card will charge more than this, so these costs are understated. " +
        "Set your conversion spread in Settings.",
    );
  }

  return {
    calcVersion: DEAL_CALC_VERSION,
    strategy: inputs.strategy,
    acquisition,
    grading,
    totalCostBeforeScenario,
    scenarios,
    missingInputs: allMissing,
    isComplete: allMissing.length === 0,
    warnings,
    fx,
    graderScaleSourceUrl: scale?.scaleSourceUrl ?? null,
  };
}
