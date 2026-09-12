import { Db } from "@mwmc/db";
import type { PhotoAssessment } from "@mwmc/providers";
import { checkCentering, centeringCeiling, worstAxis, graderScale, type GradeCenteringCheck } from "@mwmc/core";

/**
 * Storage for pre-grade photo assessments.
 *
 * APPEND-ONLY BY DESIGN. Re-running an assessment writes a NEW row rather
 * than replacing the old one. That costs a little space and buys the only
 * thing that makes calibration possible later: a record of what was believed
 * BEFORE the outcome was known, that cannot be quietly rewritten after it.
 *
 * The same reasoning as `deal_offers`, for the same reason — a history that
 * can be edited is not evidence.
 */

export interface PhotoAssessmentRow {
  id: string;
  listing_id: string;
  opportunity_id: string | null;
  card_id: string;
  assessment_json: string;
  assessability: string;
  front_worst_pct: number | null;
  back_worst_pct: number | null;
  centering_ceiling_key: string | null;
  grader_id: string;
  model_id: string | null;
  prompt_version_id: string | null;
  image_urls_json: string;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
}

/**
 * Turns the model's raw readings into the derived fields worth querying.
 *
 * The centering CHECK is deterministic code in packages/core, run here over
 * the model's measurements — the model measures, it does not decide what a
 * measurement means. That split matters: the tolerance table is sourced and
 * testable, and swapping the model can never change what 65/35 implies about
 * a PSA 10.
 */
export function deriveCentering(
  assessment: PhotoAssessment,
  graderId: string,
): { checks: GradeCenteringCheck[]; frontWorst: number | null; backWorst: number | null; ceilingKey: string | null } {
  const front =
    assessment.front.leftRightPct !== null && assessment.front.topBottomPct !== null
      ? { leftRightPct: assessment.front.leftRightPct, topBottomPct: assessment.front.topBottomPct }
      : null;
  const back =
    assessment.back.leftRightPct !== null && assessment.back.topBottomPct !== null
      ? { leftRightPct: assessment.back.leftRightPct, topBottomPct: assessment.back.topBottomPct }
      : null;

  // A stock photograph is a picture of a DIFFERENT COPY of the card. Any
  // measurement taken from one describes that other copy, not the item being
  // bought, so it is discarded rather than recorded — this is the single
  // most misleading reading the feature could store.
  if (assessment.looksLikeStockPhoto) {
    return { checks: [], frontWorst: null, backWorst: null, ceilingKey: null };
  }

  const checks = checkCentering(graderId, front, back);
  const ceiling = centeringCeiling(checks);

  return {
    checks,
    frontWorst: front ? worstAxis(front) : null,
    backWorst: back ? worstAxis(back) : null,
    ceilingKey: ceiling?.gradeKey ?? null,
  };
}

export async function saveAssessment(
  db: Db,
  params: {
    id: string;
    listingId: string;
    opportunityId: string | null;
    cardId: string;
    assessment: PhotoAssessment;
    graderId: string;
    frontWorstPct: number | null;
    backWorstPct: number | null;
    centeringCeilingKey: string | null;
    modelId: string | null;
    promptVersionId: string | null;
    imageUrls: string[];
    inputTokens: number | null;
    outputTokens: number | null;
  },
): Promise<void> {
  await db.exec(
    `INSERT INTO photo_assessments (
       id, listing_id, opportunity_id, card_id, assessment_json, assessability,
       front_worst_pct, back_worst_pct, centering_ceiling_key, grader_id,
       model_id, prompt_version_id, image_urls_json, input_tokens, output_tokens
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    params.id,
    params.listingId,
    params.opportunityId,
    params.cardId,
    JSON.stringify(params.assessment),
    params.assessment.assessability,
    params.frontWorstPct,
    params.backWorstPct,
    params.centeringCeilingKey,
    params.graderId,
    params.modelId,
    params.promptVersionId,
    JSON.stringify(params.imageUrls),
    params.inputTokens,
    params.outputTokens,
  );
}

/** The most recent assessment for a listing, if one has ever been run. */
export async function latestAssessmentForListing(db: Db, listingId: string): Promise<PhotoAssessmentRow | null> {
  return db.queryFirst<PhotoAssessmentRow>(
    `SELECT * FROM photo_assessments WHERE listing_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    listingId,
  );
}

export async function assessmentById(db: Db, id: string): Promise<PhotoAssessmentRow | null> {
  return db.queryFirst<PhotoAssessmentRow>(`SELECT * FROM photo_assessments WHERE id = ?`, id);
}

export interface CalibrationBucket {
  /** The ceiling the assessment gave — the best grade centering allowed. */
  centeringCeilingKey: string;
  assessed: number;
  /** How many of those have a real returned grade to compare against. */
  withOutcome: number;
  /** Of those, how many actually reached the ceiling grade or better. */
  reachedCeiling: number;
}

/**
 * THE CALIBRATION REPORT — the only route by which this feature ever earns
 * the right to state a probability.
 *
 * It answers one question from the operator's OWN submissions: when this
 * tool said centering permitted grade X, how often did the card actually
 * come back at X or better?
 *
 * It reports `withOutcome` alongside every rate so a hit rate can never be
 * read without its sample size. Two out of two is not 100%; it is two.
 *
 * Deliberately NOT expressed as a probability anywhere in this function. It
 * returns counts. Whether counts are numerous enough to be worth calling a
 * rate is a judgement for the caller and, ultimately, the operator.
 */
export async function centeringCalibration(db: Db): Promise<CalibrationBucket[]> {
  /*
   * The pairing is fetched raw and aggregated in code rather than in SQL.
   *
   * "Reached the ceiling or better" needs the NUMERIC value of the ceiling
   * grade, and that mapping lives in the grade scales in packages/core —
   * where it is sourced and tested. Reproducing it as a CASE expression in
   * SQL would create a second copy of the grade ladder that could drift from
   * the first, which is precisely the mistake this codebase avoids
   * everywhere else. Volumes here are tens of rows, not thousands.
   */
  const rows = await db.queryAll<{
    centering_ceiling_key: string | null;
    grader_id: string;
    grade_numeric: number | null;
  }>(
    `SELECT pa.centering_ceiling_key, pa.grader_id, gr.grade_numeric
       FROM photo_assessments pa
       JOIN inventory inv ON inv.photo_assessment_id = pa.id
       LEFT JOIN grading_submissions gs ON gs.inventory_id = inv.id
       LEFT JOIN grading_results gr ON gr.submission_id = gs.id
      WHERE pa.centering_ceiling_key IS NOT NULL`,
  );

  const buckets = new Map<string, CalibrationBucket>();

  for (const row of rows) {
    const key = row.centering_ceiling_key!;
    const bucket = buckets.get(key) ?? { centeringCeilingKey: key, assessed: 0, withOutcome: 0, reachedCeiling: 0 };
    bucket.assessed += 1;

    if (typeof row.grade_numeric === "number" && Number.isFinite(row.grade_numeric)) {
      bucket.withOutcome += 1;
      const rung = graderScale(row.grader_id)?.rungs.find((r) => r.key === key);
      if (rung && row.grade_numeric >= rung.value) bucket.reachedCeiling += 1;
    }

    buckets.set(key, bucket);
  }

  return [...buckets.values()];
}
