import { round2 } from "./fees.js";

/**
 * AI INTELLIGENCE spec item 13: "define financial metrics unambiguously —
 * documented once, referenced everywhere, with regression tests around
 * these formulas."
 *
 * This file is the single canonical glossary for the four metrics shown
 * across the dashboard and detail pages. It does NOT reimplement NET
 * PROFIT, ROC, or NET MARGIN — those are already computed by
 * computeFlipProfit (flipProfit.ts) and the grade ladder
 * (gradeLadder.ts/serviceComparison.ts), each with their own doc comment,
 * and this file's job is to point at them rather than duplicate them (a
 * second, drifting definition would be worse than no glossary at all). It
 * DOES own PROFIT PER CAPITAL DAY outright, because that metric previously
 * had no single implementation — see below.
 *
 * ---- NET PROFIT ----
 * Defined in flipProfit.ts's computeFlipProfit() and gradeLadder.ts's
 * per-grade ladder rungs. Always: net sale cash received minus total
 * delivered acquisition cost (item + postage + import tax + acquisition
 * fees). "Net sale cash" already has ALL selling-side costs removed
 * (marketplace fees, VAT on those fees, outbound postage, packaging,
 * insurance) — see netSaleProceeds.ts. Never gross revenue minus item cost
 * alone.
 *
 * ---- RETURN ON CAPITAL (ROC) ----
 * Defined alongside NET PROFIT in the same two files. Always: net profit
 * divided by total delivered acquisition cost (the capital actually put
 * at risk to acquire the item) — NEVER divided by sale price or by net
 * proceeds. A single trade's ROC is not annualised; PROFIT PER CAPITAL DAY
 * and its annualised variant (below) exist specifically to make different
 * trades' capital efficiency comparable across different holding periods.
 *
 * ---- NET MARGIN (profitMargin) ----
 * Defined alongside NET PROFIT in the same two files. Always: net profit
 * divided by BUYER PAYMENT (the revenue line — item price plus any
 * buyer-paid shipping), never by net-of-fees proceeds. This is deliberate:
 * dividing by proceeds would double-count the same fee deduction in both
 * the numerator (already netted out of profit) and the denominator, making
 * margin look artificially high. See computeFlipProfit's own doc comment.
 *
 * ---- PROFIT PER CAPITAL DAY ----
 * NEW canonical definition as of this spec item. Previously computed ad hoc
 * in two separate places with two separate call sites (opportunity/engine.ts
 * for FLIP, grading/serviceComparison.ts for GRADE) — same formula, no
 * shared, independently-tested implementation. profitPerCapitalDay() below
 * is now the ONLY place this arithmetic happens; both call sites were
 * updated to call it rather than reimplement it.
 *
 *   PROFIT PER CAPITAL DAY = net profit / estimated days capital is locked up
 *
 * "Days capital is locked up" means from the acquisition purchase to cash
 * back in hand: for a FLIP, the estimated days-to-sale by liquidity tier;
 * for a GRADE, grading-service turnaround PLUS the estimated days-to-sale
 * of the resulting slab. This is an ESTIMATE, not a guarantee — it exists
 * to let two candidates with very different capital-lock periods be
 * compared on a like-for-like "how hard is this pound working per day"
 * basis, the same way ANNUALISED ROC INDICATOR (below) extends it to a
 * yearly rate. Returns null (never a fabricated 0) when either input is
 * missing or the lock period is not a positive number of days.
 */
export function profitPerCapitalDay(netProfit: number | null, estimatedCapitalLockDays: number | null): number | null {
  if (netProfit === null || estimatedCapitalLockDays === null) return null;
  if (!(estimatedCapitalLockDays > 0)) return null;
  return round2(netProfit / estimatedCapitalLockDays);
}
