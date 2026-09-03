import { round2 } from "./fees.js";

/**
 * AI INTELLIGENCE spec item 28: deterministic capital allocation module.
 *
 * PURPOSE: with a finite pool of money and (typically) far more QUALIFIED
 * opportunities than capital to fund them all, decide WHICH ones to fund —
 * deterministically, reproducibly, with a documented reason for every
 * accept/skip decision. No AI, no randomness, no probability-weighted
 * expected value. This is the same "financial engineering" discipline as
 * maxBuySolver.ts and maxBid.ts: pure arithmetic over numbers the engine has
 * already computed, never a new fabricated one.
 *
 * WHY profitPerCapitalDay IS THE RANKING METRIC, NOT expectedNetProfit: a
 * capital allocator's job is to make each pound work as hard as possible —
 * a single pound cycled through five quick £20-profit flips beats the same
 * pound locked in one £60-profit grade for six months. profitPerCapitalDay
 * (metricDefinitions.ts) already exists for exactly this comparison and is
 * populated identically for both strategies: FLIP's is netProfit /
 * expectedDaysToSale, GRADE's is referenceProfit (the PSA9-rung profit, see
 * grading/serviceComparison.ts's VELOCITY_REFERENCE_GRADE) / capital-lock
 * days. Deliberately NOT ranked by raw netProfit/psa10Profit — that would
 * favour a single huge-but-slow trade over several small-but-fast ones, and
 * for GRADE specifically it would mean ranking by a profit figure the rest
 * of this codebase already refuses to treat as a single number (see
 * ARCHITECTURE-AND-STATUS.md: "Required hit rate replaces fake EV, labelled
 * REQUIRED never EXPECTED" — GRADE's true outcome is a whole ladder, not one
 * point estimate). profitPerCapitalDay's GRADE value is already the
 * established, conservative PSA9-reference figure used for velocity
 * comparisons elsewhere in this codebase, not a new EV this module invents.
 *
 * ALGORITHM: a deterministic greedy knapsack, not an exact optimiser.
 * Candidates are sorted by capital efficiency (profitPerCapitalDay
 * descending; a candidate with no known efficiency figure is ranked after
 * every candidate that has one, never assumed to be zero or excluded
 * outright — see below), then walked in that order, accepting each one that
 * fits within (a) the capital remaining, (b) a per-opportunity concentration
 * cap, and (c) a per-card-printing concentration cap. An exact optimiser
 * (true 0/1 knapsack) would trade determinism/explainability for a small
 * possible improvement in total capital efficiency — not worth it for a
 * real-money sourcing tool where a human needs to see and trust WHY each
 * decision was made, matching the DO-NOT-DO list's "no hidden/silent
 * assumption changes."
 *
 * CONCENTRATION CAPS exist because "spend every last pound on the single
 * highest-profitPerCapitalDay opportunity" is a genuine risk a pure
 * efficiency ranking would otherwise produce — one bad card (wrong grade,
 * a scam listing, a sudden price crash) could then consume the whole
 * capital pool. Two independent caps, both expressed as a fraction of
 * TOTAL available capital (not of what's left, so they don't drift as the
 * budget depletes): maxSingleOpportunityFraction (one listing) and
 * maxPerCardFraction (one card printing, summed across every listing of it
 * accepted so far — a lot/duplicate-listing situation could otherwise
 * bypass the single-opportunity cap by spreading the same card across
 * several rows). Both default to 25%, a documented heuristic (not derived
 * from any real loss data yet — see "Assumptions that still need live
 * validation" discipline used throughout this codebase), pinned down by
 * dedicated regression tests.
 */

export interface CapitalAllocationCandidate {
  /** Caller-supplied identifier (typically the opportunity id) — carried
   *  through untouched so the caller can match decisions back to rows. */
  id: string;
  /** Card printing this listing resolves to, or null for an
   *  identity-uncertain candidate (which should not reach this module at
   *  all, but null is handled safely rather than crashing). Used only for
   *  the per-card concentration cap. */
  cardPrintingHash: string | null;
  strategy: "FLIP" | "GRADE";
  /** Delivered acquisition cost — the capital this opportunity actually
   *  requires. Must be a positive, finite number to be considered at all. */
  totalAcquisitionCost: number;
  /** metricDefinitions.ts's profitPerCapitalDay — null when unknown (never
   *  treated as zero, which would unfairly rank it alongside a genuinely
   *  unprofitable candidate; never treated as infinite, which would
   *  unfairly rank it first). */
  profitPerCapitalDay: number | null;
}

export interface CapitalAllocationSettings {
  /** Total capital pool available to deploy across all accepted
   *  opportunities this run. Must be a positive number — this module never
   *  assumes a default budget, since inventing one would be exactly the
   *  kind of hidden financial assumption the DO-NOT-DO list forbids. */
  totalAvailableCapital: number;
  /** Fraction of totalAvailableCapital any ONE opportunity may consume.
   *  Default 0.25 (see class doc comment). */
  maxSingleOpportunityFraction?: number;
  /** Fraction of totalAvailableCapital that may go to a single card
   *  printing across every accepted listing of it. Default 0.25. */
  maxPerCardFraction?: number;
  /** Fraction of totalAvailableCapital deliberately held back and never
   *  offered to the allocator at all — a cash buffer. Default 0 (no
   *  buffer), since a buffer size is a user financial decision this module
   *  should never assume on the caller's behalf. */
  reserveFraction?: number;
}

export const DEFAULT_MAX_SINGLE_OPPORTUNITY_FRACTION = 0.25;
export const DEFAULT_MAX_PER_CARD_FRACTION = 0.25;
export const DEFAULT_RESERVE_FRACTION = 0;

export type CapitalAllocationSkipReason =
  | "INVALID_ACQUISITION_COST"
  | "EXCEEDS_TOTAL_AVAILABLE_CAPITAL"
  | "EXCEEDS_REMAINING_BUDGET"
  | "EXCEEDS_SINGLE_OPPORTUNITY_CAP"
  | "EXCEEDS_PER_CARD_CAP";

export interface CapitalAllocationDecision {
  id: string;
  cardPrintingHash: string | null;
  strategy: "FLIP" | "GRADE";
  totalAcquisitionCost: number;
  profitPerCapitalDay: number | null;
  accepted: boolean;
  /** null when accepted; the specific binding reason when skipped. */
  skipReason: CapitalAllocationSkipReason | null;
}

export interface CapitalAllocationResult {
  totalAvailableCapital: number;
  capitalReserved: number;
  /** totalAvailableCapital - capitalReserved — what the allocator actually
   *  had to work with. */
  capitalOffered: number;
  capitalAllocated: number;
  capitalRemaining: number;
  /** Decisions in the order they were EVALUATED (efficiency-ranked), not
   *  the caller's input order — see the class doc comment's algorithm note. */
  decisions: CapitalAllocationDecision[];
  accepted: CapitalAllocationDecision[];
  skipped: CapitalAllocationDecision[];
}

/**
 * Deterministic sort: known profitPerCapitalDay descending (most efficient
 * first); candidates with no known figure are placed after every candidate
 * that has one. Ties broken by cheaper totalAcquisitionCost first (frees
 * more remaining budget for what follows), then by id ascending — a pure
 * string compare — so the output order is 100% reproducible regardless of
 * input order or JS engine sort stability quirks.
 */
function compareCandidates(a: CapitalAllocationCandidate, b: CapitalAllocationCandidate): number {
  const aKnown = a.profitPerCapitalDay !== null;
  const bKnown = b.profitPerCapitalDay !== null;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (aKnown && bKnown && a.profitPerCapitalDay !== b.profitPerCapitalDay) {
    return (b.profitPerCapitalDay as number) - (a.profitPerCapitalDay as number);
  }
  if (a.totalAcquisitionCost !== b.totalAcquisitionCost) {
    return a.totalAcquisitionCost - b.totalAcquisitionCost;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function allocateCapital(
  candidates: CapitalAllocationCandidate[],
  settings: CapitalAllocationSettings,
): CapitalAllocationResult {
  const maxSingleOpportunityFraction = settings.maxSingleOpportunityFraction ?? DEFAULT_MAX_SINGLE_OPPORTUNITY_FRACTION;
  const maxPerCardFraction = settings.maxPerCardFraction ?? DEFAULT_MAX_PER_CARD_FRACTION;
  const reserveFraction = settings.reserveFraction ?? DEFAULT_RESERVE_FRACTION;

  const totalAvailableCapital = settings.totalAvailableCapital > 0 ? settings.totalAvailableCapital : 0;
  const capitalReserved = round2(totalAvailableCapital * reserveFraction);
  const capitalOffered = round2(totalAvailableCapital - capitalReserved);
  const maxSingleOpportunityCapital = totalAvailableCapital * maxSingleOpportunityFraction;
  const maxPerCardCapital = totalAvailableCapital * maxPerCardFraction;

  const ordered = [...candidates].sort(compareCandidates);

  let remaining = capitalOffered;
  let allocated = 0;
  const perCardAllocated = new Map<string, number>();
  const decisions: CapitalAllocationDecision[] = [];

  for (const c of ordered) {
    const base = {
      id: c.id,
      cardPrintingHash: c.cardPrintingHash,
      strategy: c.strategy,
      totalAcquisitionCost: c.totalAcquisitionCost,
      profitPerCapitalDay: c.profitPerCapitalDay,
    };

    if (!(c.totalAcquisitionCost > 0) || !Number.isFinite(c.totalAcquisitionCost)) {
      decisions.push({ ...base, accepted: false, skipReason: "INVALID_ACQUISITION_COST" });
      continue;
    }
    if (c.totalAcquisitionCost > totalAvailableCapital) {
      decisions.push({ ...base, accepted: false, skipReason: "EXCEEDS_TOTAL_AVAILABLE_CAPITAL" });
      continue;
    }
    if (c.totalAcquisitionCost > maxSingleOpportunityCapital) {
      decisions.push({ ...base, accepted: false, skipReason: "EXCEEDS_SINGLE_OPPORTUNITY_CAP" });
      continue;
    }
    const cardKey = c.cardPrintingHash ?? `__no_card__:${c.id}`;
    const cardSoFar = perCardAllocated.get(cardKey) ?? 0;
    if (cardSoFar + c.totalAcquisitionCost > maxPerCardCapital) {
      decisions.push({ ...base, accepted: false, skipReason: "EXCEEDS_PER_CARD_CAP" });
      continue;
    }
    if (c.totalAcquisitionCost > remaining) {
      decisions.push({ ...base, accepted: false, skipReason: "EXCEEDS_REMAINING_BUDGET" });
      continue;
    }

    remaining = round2(remaining - c.totalAcquisitionCost);
    allocated = round2(allocated + c.totalAcquisitionCost);
    perCardAllocated.set(cardKey, round2(cardSoFar + c.totalAcquisitionCost));
    decisions.push({ ...base, accepted: true, skipReason: null });
  }

  return {
    totalAvailableCapital,
    capitalReserved,
    capitalOffered,
    capitalAllocated: allocated,
    capitalRemaining: remaining,
    decisions,
    accepted: decisions.filter((d) => d.accepted),
    skipped: decisions.filter((d) => !d.accepted),
  };
}
