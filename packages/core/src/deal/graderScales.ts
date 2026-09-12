/**
 * GRADE SCALES ARE PER-GRADER, AND THEY ARE NOT THE SAME.
 *
 * This codebase has, until now, had exactly one grade scale:
 * `PSA_GRADES = [6,7,8,9,10]` in calc/types.ts. That is fine while PSA is
 * the only enabled grader, and it stays the scale the scan-time economics
 * engine uses. It is NOT fine for a per-deal calculator where the operator
 * picks the grader, because CGC's scale is a genuinely different shape:
 *
 *   PSA — whole numbers 1-10, plus a single half grade at 1.5. The top
 *         grade is 10 (Gem Mint). No 9.5.
 *   CGC — half grades all the way up (9.5, 8.5, 7.5, ...), and TWO distinct
 *         tens: "Gem Mint 10" and, above it, "Pristine 10", which is a
 *         separate, rarer, more valuable outcome.
 *         Source: https://www.cgccards.com/card-grading/grading-scale/
 *
 * So a CGC card can come back "Mint+ 9.5" or "Pristine 10" — outcomes PSA's
 * scale cannot express at all. Rendering CGC against PSA's five rungs would
 * silently drop the two outcomes most likely to carry the premium.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It carries no fees, no turnaround
 * times, and no prices for any grader. A scale is a published, stable fact
 * about how a grader labels outcomes; a fee is a commercial term that
 * differs by country, tier, declared value and date, and that this operator
 * must supply from their own actual invoice. Reusing PSA's fees as CGC's —
 * or seeding CGC with any figure at all — would be exactly the fabrication
 * this module exists to prevent. Selecting a grader here changes which
 * outcomes you can price. It never tells you what it costs.
 *
 * Nor does it assert that a grader is AVAILABLE to this operator. Whether
 * CGC's London office or PSA's US route is usable, and at what price, is a
 * business fact the operator enters — see calc/types.ts's `Grader.enabled`
 * for the separate availability flag the scan engine already respects.
 */

export interface GradeRung {
  /** Numeric value, used for ordering and arithmetic. */
  value: number;
  /** The grader's own published label for this outcome, verbatim. */
  label: string;
  /**
   * Distinguishes rungs that share a numeric value. CGC's "Gem Mint 10" and
   * "Pristine 10" are both 10 and are NOT interchangeable, so numeric value
   * alone cannot key a slab price. This does.
   */
  key: string;
}

export interface GraderScale {
  graderId: string;
  graderName: string;
  /** Highest first — the order a user reads a ladder in. */
  rungs: GradeRung[];
  scaleSourceUrl: string;
}

/**
 * PSA. Whole numbers 1-10 plus the single half grade at 1.5. Listed highest
 * first. PSA's own published scale includes "Authentic" (no numeric grade)
 * which is deliberately omitted: it carries no position on the ladder and
 * cannot be priced as a grade outcome.
 */
export const PSA_SCALE: GraderScale = {
  graderId: "PSA",
  graderName: "PSA",
  scaleSourceUrl: "https://www.psacard.com/gradingstandards",
  rungs: [
    { value: 10, label: "Gem Mint 10", key: "PSA_10" },
    { value: 9, label: "Mint 9", key: "PSA_9" },
    { value: 8, label: "NM-MT 8", key: "PSA_8" },
    { value: 7, label: "NM 7", key: "PSA_7" },
    { value: 6, label: "EX-MT 6", key: "PSA_6" },
    { value: 5, label: "EX 5", key: "PSA_5" },
    { value: 4, label: "VG-EX 4", key: "PSA_4" },
    { value: 3, label: "VG 3", key: "PSA_3" },
    { value: 2, label: "Good 2", key: "PSA_2" },
    { value: 1.5, label: "Fair 1.5", key: "PSA_1_5" },
    { value: 1, label: "Poor 1", key: "PSA_1" },
  ],
};

/**
 * CGC. Twenty rungs, half grades throughout, and two tens.
 * Verbatim labels from CGC's published scale (fetched 2026-09-12):
 * https://www.cgccards.com/card-grading/grading-scale/
 */
export const CGC_SCALE: GraderScale = {
  graderId: "CGC",
  graderName: "CGC",
  scaleSourceUrl: "https://www.cgccards.com/card-grading/grading-scale/",
  rungs: [
    { value: 10, label: "Pristine 10", key: "CGC_PRISTINE_10" },
    { value: 10, label: "Gem Mint 10", key: "CGC_GEM_MINT_10" },
    { value: 9.5, label: "Mint+ 9.5", key: "CGC_9_5" },
    { value: 9, label: "Mint 9", key: "CGC_9" },
    { value: 8.5, label: "NM/Mint+ 8.5", key: "CGC_8_5" },
    { value: 8, label: "NM/Mint 8", key: "CGC_8" },
    { value: 7.5, label: "Near Mint+ 7.5", key: "CGC_7_5" },
    { value: 7, label: "Near Mint 7", key: "CGC_7" },
    { value: 6.5, label: "Ex/NM+ 6.5", key: "CGC_6_5" },
    { value: 6, label: "Ex/NM 6", key: "CGC_6" },
    { value: 5.5, label: "Excellent+ 5.5", key: "CGC_5_5" },
    { value: 5, label: "Excellent 5", key: "CGC_5" },
    { value: 4.5, label: "VG/Ex+ 4.5", key: "CGC_4_5" },
    { value: 4, label: "VG/Ex 4", key: "CGC_4" },
    { value: 3.5, label: "Very Good+ 3.5", key: "CGC_3_5" },
    { value: 3, label: "Very Good 3", key: "CGC_3" },
    { value: 2.5, label: "Good+ 2.5", key: "CGC_2_5" },
    { value: 2, label: "Good 2", key: "CGC_2" },
    { value: 1.5, label: "Fair 1.5", key: "CGC_1_5" },
    { value: 1, label: "Poor 1", key: "CGC_1" },
  ],
};

/**
 * BGS is deliberately ABSENT rather than guessed. This project has never
 * validated Beckett's scale or tier mapping (see DEFAULT_GRADERS'
 * disabledReason in calc/types.ts), and a scale invented from memory would
 * be indistinguishable, in the UI, from the two above that were read off the
 * graders' own published pages. Adding it needs one look at Beckett's
 * published standards, not a code change here.
 */
/**
 * SGC. Twenty rungs, half grades throughout, and two tens.
 *
 * Labels are SGC's own "QUALITY" field, read from the rendered grade selector
 * on their scale page (2026-09-12). Note the domain: sgccard.com now returns
 * an empty document; gosgc.com is the live site.
 *
 * "Authentic" / "Authentic Altered" do NOT appear anywhere on SGC's scale
 * page, so they are not encoded here — same rule as PSA's Authentic: a
 * designation with no position on the ladder cannot be priced as an outcome.
 */
export const SGC_SCALE: GraderScale = {
  graderId: "SGC",
  graderName: "SGC",
  scaleSourceUrl: "https://gosgc.com/card-grading/scale",
  rungs: [
    { value: 10, label: "Pristine 10", key: "SGC_PRISTINE_10" },
    { value: 10, label: "GEM 10", key: "SGC_GEM_10" },
    { value: 9.5, label: "Mint+ 9.5", key: "SGC_9_5" },
    { value: 9, label: "Mint 9", key: "SGC_9" },
    { value: 8.5, label: "NM/MT+ 8.5", key: "SGC_8_5" },
    { value: 8, label: "NM/MT 8", key: "SGC_8" },
    { value: 7.5, label: "NM+ 7.5", key: "SGC_7_5" },
    { value: 7, label: "NRMT 7", key: "SGC_7" },
    { value: 6.5, label: "EX/NM+ 6.5", key: "SGC_6_5" },
    { value: 6, label: "EX/NM 6", key: "SGC_6" },
    { value: 5.5, label: "EX+ 5.5", key: "SGC_5_5" },
    { value: 5, label: "EX 5", key: "SGC_5" },
    { value: 4.5, label: "VG/EX+ 4.5", key: "SGC_4_5" },
    { value: 4, label: "VG/EX 4", key: "SGC_4" },
    { value: 3.5, label: "VG+ 3.5", key: "SGC_3_5" },
    { value: 3, label: "VG 3", key: "SGC_3" },
    { value: 2.5, label: "Good+ 2.5", key: "SGC_2_5" },
    { value: 2, label: "Good 2", key: "SGC_2" },
    { value: 1.5, label: "Fair 1.5", key: "SGC_1_5" },
    { value: 1, label: "Poor 1", key: "SGC_1" },
  ],
};

/**
 * TAG. Nineteen rungs, half grades from 1.5 up, and two tens.
 *
 * TAG grades on a 100-1000 point scale and publishes the mapping to the
 * conventional 1-10 ladder itself: the leading digit of the score is the
 * integer grade, and the upper half of each hundred-band is the half grade.
 * The `value` here is the conventional grade, because that is what a slab
 * is priced and sold as — the point score is a TAG-internal detail.
 *
 * Labels are taken from TAG's SCALE page, which presents the canonical
 * table. Their RUBRIC page uses different strings for the same rungs
 * ("NEAR MINT - MINT+" where the scale says "NM MT+"); the scale page wins,
 * and the rubric wording is deliberately not encoded as a second set of
 * labels that could drift.
 */
export const TAG_SCALE: GraderScale = {
  graderId: "TAG",
  graderName: "TAG",
  scaleSourceUrl: "https://taggrading.com/pages/scale",
  rungs: [
    { value: 10, label: "Pristine 10", key: "TAG_PRISTINE_10" },
    { value: 10, label: "Gem Mint 10", key: "TAG_GEM_MINT_10" },
    { value: 9, label: "Mint 9", key: "TAG_9" },
    { value: 8.5, label: "NM MT+ 8.5", key: "TAG_8_5" },
    { value: 8, label: "NM MT 8", key: "TAG_8" },
    { value: 7.5, label: "NM+ 7.5", key: "TAG_7_5" },
    { value: 7, label: "NM 7", key: "TAG_7" },
    { value: 6.5, label: "EX MT+ 6.5", key: "TAG_6_5" },
    { value: 6, label: "EX MT 6", key: "TAG_6" },
    { value: 5.5, label: "EX+ 5.5", key: "TAG_5_5" },
    { value: 5, label: "EX 5", key: "TAG_5" },
    { value: 4.5, label: "VG EX+ 4.5", key: "TAG_4_5" },
    { value: 4, label: "VG EX 4", key: "TAG_4" },
    { value: 3.5, label: "VG+ 3.5", key: "TAG_3_5" },
    { value: 3, label: "VG 3", key: "TAG_3" },
    { value: 2.5, label: "Good+ 2.5", key: "TAG_2_5" },
    { value: 2, label: "Good 2", key: "TAG_2" },
    { value: 1.5, label: "Fair 1.5", key: "TAG_1_5" },
    { value: 1, label: "Poor 1", key: "TAG_1" },
  ],
};

export const GRADER_SCALES: Record<string, GraderScale> = {
  PSA: PSA_SCALE,
  CGC: CGC_SCALE,
  SGC: SGC_SCALE,
  TAG: TAG_SCALE,
};

export function graderScale(graderId: string): GraderScale | null {
  return GRADER_SCALES[graderId.trim().toUpperCase()] ?? null;
}

/**
 * The rungs a deal should actually price, highest first.
 *
 * Defaults to the grades at or above `fromValue` — because pricing all
 * twenty CGC rungs when the operator only cares about 9 and up is noise, and
 * because slab valuations below a certain grade usually do not exist for a
 * given card anyway. Both tens are always kept when either is in range: they
 * are different outcomes with different values, and dropping one would hide
 * the more valuable of the two.
 */
export function rungsFrom(scale: GraderScale, fromValue: number): GradeRung[] {
  return scale.rungs.filter((rung) => rung.value >= fromValue);
}

export function rungByKey(scale: GraderScale, key: string): GradeRung | null {
  return scale.rungs.find((rung) => rung.key === key) ?? null;
}
