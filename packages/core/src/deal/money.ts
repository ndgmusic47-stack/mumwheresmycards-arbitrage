import type { FxRates } from "../market/currency.js";

/**
 * PER-DEAL MONEY INPUTS — the user's own numbers, with their provenance and
 * their original currency attached.
 *
 * WHY THIS TYPE EXISTS AT ALL. Everywhere else in this codebase a cost is a
 * bare `number` in GBP, because everywhere else the number came from one
 * place (a provider, or a settings row) and its currency was resolved before
 * it ever reached the calculator. A DEAL is different: the operator types in
 * their own figures, some confirmed from a receipt, some a researched guess,
 * some genuinely not known yet — and some denominated in dollars because
 * that is what the grader actually charges. A bare number cannot carry any
 * of that, and the difference between "this cost is £0" and "I do not know
 * this cost yet" is the difference between a profit figure you can act on
 * and one that is quietly missing a line.
 *
 * THREE RULES THIS TYPE ENFORCES:
 *
 *  1. BLANK IS NOT ZERO. `null` amount with provenance UNKNOWN means "not
 *     supplied". A confirmed £0 is `{amount: 0, provenance: "CONFIRMED"}`.
 *     The calculator treats these completely differently: a confirmed zero
 *     is included in the total, an unknown is excluded AND named in
 *     `missingInputs`, so a total can never look complete when it isn't.
 *
 *  2. CONVERT EXACTLY ONCE, AGAINST ONE FROZEN SNAPSHOT. A deal carries a
 *     single `FxSnapshot`; every non-GBP input in that deal converts through
 *     it. Two inputs in the same calculation can never be converted at rates
 *     captured minutes apart, and re-opening a saved deal reproduces the
 *     same pennies because the snapshot was saved with it.
 *
 *  3. PROVENANCE TRAVELS WITH THE NUMBER. It is never inferred later from
 *     whether a value happens to be present.
 *
 * The provenance vocabulary deliberately mirrors migration 0017's
 * `financial_assumptions.classification` (VERIFIED / USER_SUPPLIED /
 * DERIVED / UNKNOWN) rather than inventing a second, competing one — same
 * four concepts, named for the per-deal context they appear in here.
 */

export const MONEY_PROVENANCES = ["CONFIRMED", "ESTIMATE", "PROVIDER", "UNKNOWN"] as const;
export type MoneyProvenance = (typeof MONEY_PROVENANCES)[number];

export interface MoneyInput {
  /**
   * The amount AS THE USER ENTERED IT, in `currency` — never pre-converted.
   * null means "not supplied"; it is not the same as 0.
   */
  amount: number | null;
  /** ISO code of the amount above. Defaults to GBP when omitted. */
  currency?: string;
  provenance: MoneyProvenance;
  /** Free text: a receipt reference, the source of a researched figure, why
   *  it is still unknown. Never parsed, only displayed and stored. */
  note?: string | null;
}

/** A money input that has been resolved into GBP, with the full audit trail
 *  of how it got there kept alongside it. */
export interface ResolvedMoney {
  /** GBP, rounded to the penny. null when the input was UNKNOWN/blank. */
  gbp: number | null;
  originalAmount: number | null;
  originalCurrency: string;
  /** 1 for GBP. The rate actually applied, from the deal's frozen snapshot. */
  rateToGbp: number | null;
  provenance: MoneyProvenance;
  note: string | null;
  /** True when this contributed nothing because it was not supplied. */
  missing: boolean;
}

/**
 * The exchange rates a deal was calculated against, frozen at save time.
 *
 * Stored WITH the deal, not looked up fresh on every read: a saved deal must
 * reproduce the same pennies tomorrow, and a decision recorded at purchase
 * must stay readable as the decision that was actually made. `source` and
 * `capturedAt` come from the live FX refresh (`fx_rates_meta`), so a user
 * can always see which rates priced their deal and when.
 */
export interface FxSnapshot {
  rates: FxRates;
  /** Where the rates came from — the live feed, or the fallback table. */
  source: string;
  /** ISO timestamp the rates were captured. */
  capturedAt: string;
  /**
   * THE GAP BETWEEN THE RATE AND WHAT YOU ACTUALLY PAY.
   *
   * `rates` are mid-market — the midpoint between buy and sell, sourced from
   * central-bank reference data. Nobody transacts at mid-market. A bank card
   * typically costs 2.75-3% above it, PayPal 3-4%, a specialist remitter
   * 0.4-0.6%. So a $100 card that this table prices at £79.00 really costs
   * £81-82 out of the account, and every profit figure built on the
   * unadjusted rate is optimistic by that margin on every foreign purchase.
   *
   * Expressed as a fraction (0.03 = 3%) and applied in the COST direction
   * only — see `rateFor`. It is the operator's own figure, taken from their
   * own statement by comparing what they were charged against the mid-market
   * rate on the day.
   *
   * null means NOT CONFIGURED, and is deliberately distinct from 0. Zero is
   * a claim ("I convert at mid-market"); null is an admission ("this cost is
   * not yet accounted for"), and non-GBP lines are flagged accordingly
   * rather than quietly presented as complete.
   */
  conversionSpreadPct?: number | null;
}

export class MoneyInputError extends Error {}

/**
 * The rate actually used to turn one unit of `currency` into GBP.
 *
 * GBP is always exactly 1 regardless of the table — a missing or stale GBP
 * entry can never distort an already-correct figure, and no spread is
 * applied to a currency that is not being converted.
 *
 * For every other currency the mid-market rate is WIDENED by the configured
 * spread. The direction is deliberate and one-way: these are costs the
 * operator pays, so a worse rate means MORE pounds per unit of foreign
 * currency, and the multiplication is (1 + spread).
 *
 * This is why the same helper must not be reused to convert a foreign
 * RECEIPT into GBP — there the spread runs the other way and would need
 * dividing, not multiplying. Nothing in the deal calculator converts a
 * receipt today (foreign resale values are references, not money received),
 * and if that changes it needs its own function rather than a flag on this
 * one, so the direction can never be got silently backwards.
 */
export function rateFor(currency: string, snapshot: FxSnapshot): number | null {
  const code = currency.trim().toUpperCase();
  if (code === "GBP") return 1;
  const rate = snapshot.rates[code];
  if (!(typeof rate === "number" && Number.isFinite(rate) && rate > 0)) return null;

  const spread = snapshot.conversionSpreadPct;
  if (spread === null || spread === undefined) return rate;
  if (!Number.isFinite(spread) || spread < 0) {
    throw new MoneyInputError(
      `Currency conversion spread must be a non-negative number (received ${JSON.stringify(spread)}).`,
    );
  }
  return rate * (1 + spread);
}

/** True when a deal converts foreign money without a configured spread —
 *  the figures are mid-market and therefore better than reality. */
export function conversionSpreadMissing(snapshot: FxSnapshot): boolean {
  return snapshot.conversionSpreadPct === null || snapshot.conversionSpreadPct === undefined;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Resolves one input to GBP.
 *
 * VALIDATION IS STRICT AND LOUD. A negative cost, a non-finite number, or a
 * currency with no rate in the snapshot all THROW rather than silently
 * becoming zero or being dropped — a cost that vanishes quietly is exactly
 * how a profit figure ends up overstated. The one non-throwing case is a
 * genuinely absent value, which resolves to `missing: true` and is reported
 * to the user by name.
 *
 * `allowNegative` exists for the small number of fields where a negative is
 * meaningful (a refund, a credit) — off by default.
 */
export function resolveMoney(
  label: string,
  input: MoneyInput | null | undefined,
  snapshot: FxSnapshot,
  options: { allowNegative?: boolean } = {},
): ResolvedMoney {
  const currency = (input?.currency ?? "GBP").trim().toUpperCase() || "GBP";
  const provenance: MoneyProvenance = input?.provenance ?? "UNKNOWN";
  const note = input?.note ?? null;

  const amount = input?.amount;
  if (amount === null || amount === undefined) {
    return { gbp: null, originalAmount: null, originalCurrency: currency, rateToGbp: null, provenance, note, missing: true };
  }

  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new MoneyInputError(`${label}: amount must be a finite number (received ${JSON.stringify(amount)}).`);
  }
  if (amount < 0 && !options.allowNegative) {
    throw new MoneyInputError(`${label}: amount must not be negative (received ${amount}).`);
  }
  // A supplied number with provenance UNKNOWN is contradictory: the value is
  // right there. Refuse rather than guess which half the user meant.
  if (provenance === "UNKNOWN") {
    throw new MoneyInputError(`${label}: an amount was supplied but its provenance is UNKNOWN — mark it CONFIRMED, ESTIMATE or PROVIDER, or clear the amount.`);
  }

  const rate = rateFor(currency, snapshot);
  if (rate === null) {
    throw new MoneyInputError(
      `${label}: no exchange rate for "${currency}" in this deal's rate snapshot (has: ${Object.keys(snapshot.rates).join(", ")}).`,
    );
  }

  return {
    gbp: round2(amount * rate),
    originalAmount: amount,
    originalCurrency: currency,
    rateToGbp: rate,
    provenance,
    note,
    missing: false,
  };
}

/** A resolved input contributes its GBP value, or 0 when absent — callers
 *  MUST separately report the absence (see `collectMissing`). */
export function contribution(resolved: ResolvedMoney): number {
  return resolved.gbp ?? 0;
}

/** Names of every input that was not supplied, so a total is never presented
 *  as complete while a line is silently missing from it. */
export function collectMissing(entries: Record<string, ResolvedMoney>): string[] {
  return Object.entries(entries)
    .filter(([, value]) => value.missing)
    .map(([key]) => key);
}

export { round2 as roundMoney };
