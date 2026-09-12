import { type GraderScale, graderScale } from "./graderScales.js";

/**
 * PUBLISHED CENTERING TOLERANCES — the only quantified grading criterion
 * either grader actually publishes.
 *
 * WHY THIS FILE IS NARROW ON PURPOSE. Corners, edges and surface are graded
 * subjectively; neither PSA nor CGC publishes a weighting, a scoring rubric,
 * or a measurable threshold for any of them. CGC has withdrawn sub-grades
 * entirely. So there is nothing to encode, and encoding a guess would give a
 * fabricated number the appearance of a standard.
 *
 * Centering is different. It is a ratio of measured border widths, both
 * graders publish tolerances for it, and it acts as a HARD CEILING: a card
 * measurably outside the tolerance for a grade cannot receive that grade on
 * centering alone, whatever its corners look like. That asymmetry is the
 * whole reason this is worth having — it can rule a grade OUT with evidence,
 * and it can never rule one IN.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SOURCES, verified 2026-09-12. Read the caveats; they matter more than the
 * numbers.
 *
 * PSA — figures come from PSA's own GLOSSARY, one grade per entry:
 *   https://www.psacard.com/resources/lingo/g  (GEM-MT 10: "no worse than 55-45")
 *   https://www.psacard.com/resources/lingo/m  (MINT 9: "no worse than 60/40")
 *   https://www.psacard.com/resources/lingo/n  (NM-MT 8: "no worse than 70/30";
 *                                               NM 7: "no worse than 75/25")
 *   https://www.psacard.com/resources/lingo/e  (EX-MT 6: "80/20 or better";
 *                                               EX 5: "no worse than 85/15")
 *
 *   THREE CAVEATS, all of which are reasons to hedge in the UI:
 *
 *   1. PSA's actual grading-standards page publishes NO centering figures at
 *      all. These come from a glossary, which is a weaker kind of document.
 *
 *   2. PSA PUBLISHES NO BACK/REVERSE TOLERANCE FOR ANY GRADE. The widely
 *      repeated "PSA 10 is 55/45 front and 75/25 back" is third-party; the
 *      front half is PSA's, the back half is not. So `backMaxPct` is null
 *      for every PSA rung, and a back measurement can NEVER be used to rule
 *      a PSA grade out here. Leaving it null is the point.
 *
 *   3. The popular third-party table disagrees with PSA's own glossary at
 *      grades 8 and 7 (it says 65/35 and 70/30). PSA's own words are used.
 *
 * CGC — https://www.cgccards.com/card-grading/grading-scale/
 *   Pristine 10: "The centering is 50/50"
 *   Gem Mint 10: "not to exceed approximately 55/45" front,
 *                "reverse centering is not to exceed 75/25"
 *   Mint 9:      "60/40 or better for the front", "90/10 for the back"
 *   NM/Mint 8:   "65/35 or better"
 *   Near Mint 7: "70/30 or better"
 *   Ex/NM 6:     "75/25"
 *
 *   CGC 9.5 (Mint+) has NO published numeric tolerance — it is explicitly a
 *   subjective eye-appeal bump. It is therefore absent from this table
 *   rather than interpolated between 9 and 10.
 *
 *   CGC qualifies several figures as applying to "sports and non-sports"
 *   cards and publishes no separate TCG table, so for Pokémon these are the
 *   nearest published figures rather than certainly the operative ones.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface CenteringTolerance {
  gradeKey: string;
  /**
   * Worst permitted front centering, as the larger side's percentage.
   * 55 means "55/45 or better" — i.e. no border may exceed 55% of the
   * combined border width on either axis.
   */
  frontMaxPct: number;
  /** Worst permitted back centering, or null where the grader publishes none. */
  backMaxPct: number | null;
  /** Exact wording published by the grader, for display alongside a verdict. */
  publishedAs: string;
}

export interface GraderCenteringStandard {
  graderId: string;
  sourceUrl: string;
  /**
   * True when the grader publishes these on a formal standards page. PSA's
   * come from a glossary, so this is false for PSA and the UI hedges.
   */
  fromFormalStandard: boolean;
  tolerances: CenteringTolerance[];
}

const PSA_CENTERING: GraderCenteringStandard = {
  graderId: "PSA",
  sourceUrl: "https://www.psacard.com/resources/lingo/g",
  fromFormalStandard: false,
  tolerances: [
    { gradeKey: "PSA_10", frontMaxPct: 55, backMaxPct: null, publishedAs: "55/45 or better (front). PSA publishes no back tolerance." },
    { gradeKey: "PSA_9", frontMaxPct: 60, backMaxPct: null, publishedAs: "60/40 or better (front). PSA publishes no back tolerance." },
    { gradeKey: "PSA_8", frontMaxPct: 70, backMaxPct: null, publishedAs: "70/30 or better (front). PSA publishes no back tolerance." },
    { gradeKey: "PSA_7", frontMaxPct: 75, backMaxPct: null, publishedAs: "75/25 or better (front). PSA publishes no back tolerance." },
    { gradeKey: "PSA_6", frontMaxPct: 80, backMaxPct: null, publishedAs: "80/20 or better (front). PSA publishes no back tolerance." },
    { gradeKey: "PSA_5", frontMaxPct: 85, backMaxPct: null, publishedAs: "85/15 or better (front). PSA publishes no back tolerance." },
  ],
};

const CGC_CENTERING: GraderCenteringStandard = {
  graderId: "CGC",
  sourceUrl: "https://www.cgccards.com/card-grading/grading-scale/",
  fromFormalStandard: true,
  tolerances: [
    { gradeKey: "CGC_PRISTINE_10", frontMaxPct: 50, backMaxPct: null, publishedAs: "50/50 front." },
    { gradeKey: "CGC_GEM_MINT_10", frontMaxPct: 55, backMaxPct: 75, publishedAs: "55/45 front, 75/25 reverse." },
    // CGC 9.5 (Mint+) is deliberately absent: no published numeric tolerance.
    { gradeKey: "CGC_9", frontMaxPct: 60, backMaxPct: 90, publishedAs: "60/40 front, 90/10 back." },
    { gradeKey: "CGC_8", frontMaxPct: 65, backMaxPct: null, publishedAs: "65/35 or better (front)." },
    { gradeKey: "CGC_7", frontMaxPct: 70, backMaxPct: null, publishedAs: "70/30 or better (front)." },
    { gradeKey: "CGC_6", frontMaxPct: 75, backMaxPct: null, publishedAs: "75/25 (front)." },
  ],
};

/**
 * SGC — https://gosgc.com/card-grading/scale (verified 2026-09-12).
 *
 * TWO THINGS TO KNOW, both of which shape what is and is not encoded here.
 *
 * 1. SGC PUBLISHES NO BACK FIGURE for any grade. Like PSA, every centering
 *    phrase on their page is a single number with no front/back split. So
 *    `backMaxPct` is null throughout and a back measurement can never rule
 *    out an SGC grade.
 *
 * 2. EVERY "+" HALF GRADE PUBLISHES NO CENTERING FIGURE AT ALL — 9.5, 6.5,
 *    5.5, 4.5, 3.5 and 2.5 are all absent, and so is Poor 1. SGC defines
 *    those rungs purely by eye appeal relative to the grade below: EX/NM+
 *    reads, in full, "An EX/NM card that exhibits high-end overall quality
 *    and eye appeal." Interpolating a number between the neighbours would be
 *    inventing a standard SGC has deliberately not set, so those rungs are
 *    simply omitted and report NOT_ASSESSED.
 *
 * Note also that SGC's figures are NOT monotonically distinct: 8.5 and 8
 * both allow 65/35, 7.5 and 7 both allow 70/30, and 3, 2 and 1.5 all allow
 * 90/10. Centering alone therefore cannot separate those rungs — which is
 * exactly why this module rules grades OUT rather than picking one.
 *
 * SGC's own caveat, verbatim from the page header: "These grade descriptions
 * are guidelines... Other factors that may or may not contribute to the final
 * assigned grade might not be specifically noted in these descriptions."
 */
const SGC_CENTERING: GraderCenteringStandard = {
  graderId: "SGC",
  sourceUrl: "https://gosgc.com/card-grading/scale",
  fromFormalStandard: true,
  tolerances: [
    { gradeKey: "SGC_PRISTINE_10", frontMaxPct: 50, backMaxPct: null, publishedAs: "50/50 centering. SGC publishes no back tolerance." },
    { gradeKey: "SGC_GEM_10", frontMaxPct: 55, backMaxPct: null, publishedAs: "55/45 or better. SGC publishes no back tolerance." },
    // 9.5 deliberately absent — SGC publishes no figure for it.
    { gradeKey: "SGC_9", frontMaxPct: 60, backMaxPct: null, publishedAs: "60/40 or better. SGC publishes no back tolerance." },
    { gradeKey: "SGC_8_5", frontMaxPct: 65, backMaxPct: null, publishedAs: "65/35 or better. SGC publishes no back tolerance." },
    { gradeKey: "SGC_8", frontMaxPct: 65, backMaxPct: null, publishedAs: "65/35 or better. SGC publishes no back tolerance." },
    { gradeKey: "SGC_7_5", frontMaxPct: 70, backMaxPct: null, publishedAs: "70/30 or better. SGC publishes no back tolerance." },
    { gradeKey: "SGC_7", frontMaxPct: 70, backMaxPct: null, publishedAs: "70/30 or better. SGC publishes no back tolerance." },
    // 6.5 absent.
    { gradeKey: "SGC_6", frontMaxPct: 75, backMaxPct: null, publishedAs: "75/25 or better. SGC publishes no back tolerance." },
    // 5.5 absent.
    { gradeKey: "SGC_5", frontMaxPct: 80, backMaxPct: null, publishedAs: "80/20 or better. SGC publishes no back tolerance." },
    // 4.5 absent.
    { gradeKey: "SGC_4", frontMaxPct: 85, backMaxPct: null, publishedAs: "85/15 or better. SGC publishes no back tolerance." },
    // 3.5 absent.
    { gradeKey: "SGC_3", frontMaxPct: 90, backMaxPct: null, publishedAs: "90/10 or better. SGC publishes no back tolerance." },
    // 2.5 absent.
    { gradeKey: "SGC_2", frontMaxPct: 90, backMaxPct: null, publishedAs: "Centered 90/10 or better. SGC publishes no back tolerance." },
    { gradeKey: "SGC_1_5", frontMaxPct: 90, backMaxPct: null, publishedAs: "Centered 90/10 or better. SGC publishes no back tolerance." },
    // Poor 1 absent.
  ],
};

/**
 * TAG — https://taggrading.com/pages/rubric (verified 2026-09-12).
 *
 * The most completely published of the four. TAG gives a front tolerance for
 * every rung down to 1.5, and splits the BACK figure by category — Sports and
 * TCG separately.
 *
 * THE TCG FIGURES ARE THE ONES USED HERE, because this application is for
 * Pokémon. Using TAG's Sports back tolerances on a Pokémon card would be
 * applying the wrong published standard, which is worse than applying none:
 * at Gem Mint 10 the Sports back allows 70/30 while TCG allows only 65/35,
 * so the Sports figure would wave through a card TAG would fail.
 *
 * TWO BOUNDARIES WHERE THE BACK FIGURE SIMPLY STOPS. TAG publishes a TCG back
 * tolerance only down to grade 8; from 7.5 downward the back requirement
 * becomes qualitative ("may show a tiny sliver of border, but may not be
 * miscut"). Those rungs carry a null back, and Poor 1 has no front figure at
 * all, so it is omitted entirely.
 *
 * Every TAG figure is published with a tilde — "~65/35" — i.e. TAG states
 * them as approximate. They are encoded as the stated number; the
 * approximation is TAG's, not this module's.
 */
const TAG_CENTERING: GraderCenteringStandard = {
  graderId: "TAG",
  sourceUrl: "https://taggrading.com/pages/rubric",
  fromFormalStandard: true,
  tolerances: [
    { gradeKey: "TAG_PRISTINE_10", frontMaxPct: 51, backMaxPct: 52, publishedAs: "~51/49 front, ~52/48 reverse (TCG)." },
    { gradeKey: "TAG_GEM_MINT_10", frontMaxPct: 55, backMaxPct: 65, publishedAs: "~55/45 front, ~65/35 reverse (TCG)." },
    { gradeKey: "TAG_9", frontMaxPct: 60, backMaxPct: 75, publishedAs: "~60/40 front, ~75/25 reverse (TCG)." },
    { gradeKey: "TAG_8_5", frontMaxPct: 62.5, backMaxPct: 85, publishedAs: "~62.5/37.5 front, ~85/15 reverse (TCG)." },
    { gradeKey: "TAG_8", frontMaxPct: 65, backMaxPct: 95, publishedAs: "~65/35 front, ~95/5 reverse (TCG)." },
    // From 7.5 down TAG states no numeric back tolerance — it becomes a
    // qualitative "no miscut" rule, which a measurement cannot test.
    { gradeKey: "TAG_7_5", frontMaxPct: 67.5, backMaxPct: null, publishedAs: "~67.5/32.5 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_7", frontMaxPct: 70, backMaxPct: null, publishedAs: "~70/30 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_6_5", frontMaxPct: 72.5, backMaxPct: null, publishedAs: "~72.5/27.5 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_6", frontMaxPct: 75, backMaxPct: null, publishedAs: "~75/25 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_5_5", frontMaxPct: 77.5, backMaxPct: null, publishedAs: "~77.5/22.5 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_5", frontMaxPct: 80, backMaxPct: null, publishedAs: "~80/20 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_4_5", frontMaxPct: 82.5, backMaxPct: null, publishedAs: "~82.5/17.5 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_4", frontMaxPct: 85, backMaxPct: null, publishedAs: "~85/15 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_3_5", frontMaxPct: 87.5, backMaxPct: null, publishedAs: "~87.5/12.5 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_3", frontMaxPct: 90, backMaxPct: null, publishedAs: "~90/10 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_2_5", frontMaxPct: 92.5, backMaxPct: null, publishedAs: "~92.5/7.5 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_2", frontMaxPct: 95, backMaxPct: null, publishedAs: "~95/5 front. No numeric back tolerance below grade 8." },
    { gradeKey: "TAG_1_5", frontMaxPct: 98.33, backMaxPct: null, publishedAs: "~98.33/1.67 front. No numeric back tolerance below grade 8." },
    // Poor 1 omitted — TAG publishes no front figure for it.
  ],
};

export const CENTERING_STANDARDS: Record<string, GraderCenteringStandard> = {
  PSA: PSA_CENTERING,
  CGC: CGC_CENTERING,
  SGC: SGC_CENTERING,
  TAG: TAG_CENTERING,
};

export function centeringStandard(graderId: string): GraderCenteringStandard | null {
  return CENTERING_STANDARDS[graderId.trim().toUpperCase()] ?? null;
}

/**
 * A centering measurement, as the larger share on each axis.
 *
 * 50 is perfect. 60 means one border is 60% of the combined border width and
 * the other 40%. Values below 50 are rejected rather than silently flipped:
 * a caller that has mixed up which side is which should be told, not
 * quietly corrected into a plausible-looking number.
 */
export interface CenteringMeasurement {
  leftRightPct: number;
  topBottomPct: number;
}

export class CenteringInputError extends Error {}

function validate(label: string, measurement: CenteringMeasurement): void {
  for (const [axis, value] of [
    ["left-right", measurement.leftRightPct],
    ["top-bottom", measurement.topBottomPct],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new CenteringInputError(`${label} ${axis} centering must be a finite number (received ${JSON.stringify(value)}).`);
    }
    if (value < 50 || value > 100) {
      throw new CenteringInputError(
        `${label} ${axis} centering must be expressed as the LARGER share, between 50 and 100 (received ${value}).`,
      );
    }
  }
}

/** The worse of the two axes — centering is capped by whichever is worse. */
export function worstAxis(measurement: CenteringMeasurement): number {
  return Math.max(measurement.leftRightPct, measurement.topBottomPct);
}

export type CenteringVerdict = "WITHIN" | "EXCEEDS" | "NOT_ASSESSED";

export interface GradeCenteringCheck {
  gradeKey: string;
  gradeLabel: string;
  verdict: CenteringVerdict;
  /** Why, in the grader's own published terms. */
  publishedTolerance: string;
  /** The measurement that decided it, when one was available. */
  measuredWorstPct: number | null;
  /** Which face decided it — a back measurement only counts where published. */
  decidedBy: "FRONT" | "BACK" | null;
}

/**
 * Checks a measurement against every rung of a grader's published scale.
 *
 * THIS RULES GRADES OUT, NEVER IN. A "WITHIN" verdict means only that
 * centering does not by itself prevent that grade — corners, edges, surface,
 * print quality and eye appeal are all still unaccounted for, and any of
 * them can cap the card far below. "EXCEEDS" is the informative direction:
 * the card measurably cannot reach that grade on centering.
 *
 * A grade with no published tolerance returns NOT_ASSESSED rather than
 * passing by default. So does a missing measurement, and so does a back
 * measurement offered against a grader that publishes no back figure.
 */
export function checkCentering(
  graderId: string,
  front: CenteringMeasurement | null,
  back: CenteringMeasurement | null,
): GradeCenteringCheck[] {
  const standard = centeringStandard(graderId);
  const scale: GraderScale | null = graderScale(graderId);
  if (!standard || !scale) return [];

  if (front) validate("Front", front);
  if (back) validate("Back", back);

  const frontWorst = front ? worstAxis(front) : null;
  const backWorst = back ? worstAxis(back) : null;

  return scale.rungs.map((rung) => {
    const tolerance = standard.tolerances.find((t) => t.gradeKey === rung.key);
    if (!tolerance) {
      return {
        gradeKey: rung.key,
        gradeLabel: rung.label,
        verdict: "NOT_ASSESSED" as const,
        publishedTolerance: `${scale.graderName} publishes no centering tolerance for this grade.`,
        measuredWorstPct: null,
        decidedBy: null,
      };
    }

    // The FRONT check first — it is published for every rung that has a
    // tolerance at all, and it is the one graders lead with.
    if (frontWorst !== null && frontWorst > tolerance.frontMaxPct) {
      return {
        gradeKey: rung.key,
        gradeLabel: rung.label,
        verdict: "EXCEEDS" as const,
        publishedTolerance: tolerance.publishedAs,
        measuredWorstPct: frontWorst,
        decidedBy: "FRONT" as const,
      };
    }

    // The BACK check runs ONLY where the grader publishes a back figure.
    // Against PSA this never fires, because PSA publishes none — measuring
    // the back and then judging it against a number PSA never stated would
    // be inventing a standard and attributing it to them.
    if (tolerance.backMaxPct !== null && backWorst !== null && backWorst > tolerance.backMaxPct) {
      return {
        gradeKey: rung.key,
        gradeLabel: rung.label,
        verdict: "EXCEEDS" as const,
        publishedTolerance: tolerance.publishedAs,
        measuredWorstPct: backWorst,
        decidedBy: "BACK" as const,
      };
    }

    if (frontWorst === null && backWorst === null) {
      return {
        gradeKey: rung.key,
        gradeLabel: rung.label,
        verdict: "NOT_ASSESSED" as const,
        publishedTolerance: tolerance.publishedAs,
        measuredWorstPct: null,
        decidedBy: null,
      };
    }

    return {
      gradeKey: rung.key,
      gradeLabel: rung.label,
      verdict: "WITHIN" as const,
      publishedTolerance: tolerance.publishedAs,
      measuredWorstPct: frontWorst ?? backWorst,
      decidedBy: frontWorst !== null ? ("FRONT" as const) : ("BACK" as const),
    };
  });
}

/**
 * The best grade centering alone does not rule out.
 *
 * Explicitly NOT a predicted grade. It is a ceiling with one cause, and it
 * is only as good as the measurement it was given.
 */
export function centeringCeiling(checks: GradeCenteringCheck[]): GradeCenteringCheck | null {
  const permitted = checks.filter((c) => c.verdict === "WITHIN");
  if (permitted.length === 0) return null;
  // Scale rungs are ordered best-first, so the first permitted one is the
  // highest grade centering allows.
  return permitted[0] ?? null;
}
