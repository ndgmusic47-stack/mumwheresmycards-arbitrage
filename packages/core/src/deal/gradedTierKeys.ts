import { GRADER_SCALES, type GradeRung } from "./graderScales.js";

/**
 * MAPPING A MARKET PROVIDER'S TIER KEYS ONTO PUBLISHED GRADE SCALES.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. Until now this application asked its market provider for
 * five prices — PSA 6, 7, 8, 9 and 10 — and that is all it has ever known
 * about. A live smoke test against the real PokeTrace API (2026-09-12)
 * showed what the provider actually returns for a single card:
 *
 *   PSA_3, PSA_4, PSA_4_5, PSA_5, PSA_5_5, PSA_6, PSA_6_5, PSA_7, PSA_7_5,
 *   PSA_8, PSA_8_5, PSA_9, ... plus SGC_3 through SGC_9 and TAG_2 through
 *   TAG_10.
 *
 * Roughly thirty prices across three graders, of which five were being read.
 * Every low grade and every half grade was being discarded — which is why
 * the tool could never answer "does this still pay if it comes back a 5",
 * the question that matters most on a small bankroll.
 *
 * WHAT THIS MODULE WILL NOT DO:
 *
 *  1. IT DOES NOT INVENT RUNGS. A provider tier only maps to a grade if that
 *     grade exists on the grader's own published scale (graderScales.ts).
 *     PokeTrace returns `PSA_8_5`; this project has not verified PSA's
 *     published half-grade list, so PSA_SCALE has no 8.5 rung and the price
 *     is stored but mapped to nothing. The moment PSA's scale is verified and
 *     extended, that price connects with no change here.
 *
 *  2. IT DOES NOT RESOLVE AMBIGUOUS TENS. CGC, SGC and TAG each have TWO
 *     distinct tens — a Pristine and a Gem Mint — which are different
 *     outcomes at very different prices. PokeTrace returns a single `TAG_10`.
 *     There is no honest way to know whether that is the Pristine price, the
 *     Gem Mint price, or a blend of both, so it is mapped to NEITHER and
 *     flagged instead. Assigning it to one would silently misprice the most
 *     valuable outcome on the ladder.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Provider tier keys, normalised. Matching is case-insensitive and tolerant
 * of the three separator styles a provider might use (`PSA_8`, `psa-8`,
 * `psa8`) so a cosmetic change upstream does not silently drop a grade.
 */
export function normaliseTierKey(key: string): string {
  return key.trim().toUpperCase().replace(/[\s\-.]+/g, "_").replace(/_+/g, "_");
}

/** The grader a provider tier key belongs to, or null if unrecognised. */
export function graderIdForTierKey(key: string): string | null {
  const normalised = normaliseTierKey(key);
  for (const graderId of Object.keys(GRADER_SCALES)) {
    if (normalised.startsWith(`${graderId}_`)) return graderId;
  }
  return null;
}

export interface TierKeyMapping {
  /** The provider's key, normalised. */
  tierKey: string;
  graderId: string | null;
  /** The scale rung this maps to, when exactly one matches. */
  rung: GradeRung | null;
  /**
   * Why a key with a known grader still mapped to no rung. Null when it
   * mapped cleanly, or when the grader itself is unknown.
   */
  unmappedReason: "AMBIGUOUS_TEN" | "NO_SUCH_RUNG" | null;
}

/**
 * Resolves one provider tier key against the published scales.
 *
 * The grade portion is matched against each rung's key SUFFIX, so `PSA_8`
 * finds the rung keyed `PSA_8`, and `CGC_10` finds two rungs
 * (`CGC_PRISTINE_10`, `CGC_GEM_MINT_10`) and therefore resolves to neither.
 */
export function mapTierKey(key: string): TierKeyMapping {
  const tierKey = normaliseTierKey(key);
  const graderId = graderIdForTierKey(tierKey);
  if (!graderId) return { tierKey, graderId: null, rung: null, unmappedReason: null };

  const scale = GRADER_SCALES[graderId]!;
  const exact = scale.rungs.filter((rung) => rung.key === tierKey);
  if (exact.length === 1) return { tierKey, graderId, rung: exact[0]!, unmappedReason: null };

  // No exact key match. The provider may be using the bare number where the
  // scale distinguishes two rungs at that number — the ambiguous-ten case.
  const gradePart = tierKey.slice(graderId.length + 1);
  const numeric = Number(gradePart.replace(/_/g, "."));
  if (Number.isFinite(numeric)) {
    const byValue = scale.rungs.filter((rung) => rung.value === numeric);
    if (byValue.length === 1) return { tierKey, graderId, rung: byValue[0]!, unmappedReason: null };
    if (byValue.length > 1) return { tierKey, graderId, rung: null, unmappedReason: "AMBIGUOUS_TEN" };
  }

  return { tierKey, graderId, rung: null, unmappedReason: "NO_SUCH_RUNG" };
}

/**
 * A provider's graded prices for one card, in GBP, keyed by the provider's
 * own normalised tier key.
 *
 * Deliberately keyed by the PROVIDER's key rather than by scale rung: the
 * raw observation is stored whole, including tiers that map to no rung
 * today, so extending a scale later makes existing stored data usable
 * without a re-scan. Nothing is thrown away at write time because it happens
 * not to fit the current model.
 */
export type GradedPriceMap = Record<string, number>;

export interface ResolvedGradedPrice {
  gradeKey: string;
  gradeLabel: string;
  gbp: number;
  tierKey: string;
}

/**
 * The subset of a price map that maps cleanly onto one grader's scale,
 * ordered highest grade first.
 *
 * Ambiguous and unmapped tiers are excluded — `unmappableTiers` reports them
 * so the caller can say what it is not showing rather than silently hiding
 * it.
 */
export function resolveGradedPrices(
  prices: GradedPriceMap,
  graderId: string,
): { priced: ResolvedGradedPrice[]; unmappableTiers: TierKeyMapping[] } {
  const scale = GRADER_SCALES[graderId.trim().toUpperCase()];
  if (!scale) return { priced: [], unmappableTiers: [] };

  const priced: ResolvedGradedPrice[] = [];
  const unmappableTiers: TierKeyMapping[] = [];

  for (const [key, gbp] of Object.entries(prices)) {
    if (typeof gbp !== "number" || !Number.isFinite(gbp) || gbp < 0) continue;
    const mapping = mapTierKey(key);
    if (mapping.graderId !== scale.graderId) continue;
    if (mapping.rung) {
      priced.push({ gradeKey: mapping.rung.key, gradeLabel: mapping.rung.label, gbp, tierKey: mapping.tierKey });
    } else {
      unmappableTiers.push(mapping);
    }
  }

  const order = new Map(scale.rungs.map((rung, index) => [rung.key, index]));
  priced.sort((a, b) => (order.get(a.gradeKey) ?? 999) - (order.get(b.gradeKey) ?? 999));

  return { priced, unmappableTiers };
}

/** Which graders a price map carries any usable price for. */
export function gradersWithPrices(prices: GradedPriceMap): string[] {
  const found = new Set<string>();
  for (const key of Object.keys(prices)) {
    const graderId = graderIdForTierKey(key);
    if (graderId) found.add(graderId);
  }
  return [...found].sort();
}
