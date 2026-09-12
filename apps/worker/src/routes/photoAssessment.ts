import { Hono } from "hono";
import { Db, type OpportunityRow } from "@mwmc/db";
import { AiPhotoAssessmentProvider, createAiModelProvider, AiCompletionCache } from "@mwmc/providers";
import { graderScale, GRADER_SCALES, centeringStandard } from "@mwmc/core";
import { loadSettings } from "../repo/settingsRepo.js";
import {
  deriveCentering,
  saveAssessment,
  latestAssessmentForListing,
  centeringCalibration,
  type PhotoAssessmentRow,
} from "../repo/photoAssessmentsRepo.js";
import type { Env } from "../env.js";

/**
 * PRE-GRADE PHOTO ASSESSMENT ROUTES.
 *
 * ON DEMAND ONLY, NEVER DURING A SCAN. This is a DEEP-tier multimodal call
 * with up to six high-detail images; running it across a scan's worth of
 * listings would burn the daily spend cap in a single pass and produce
 * assessments of hundreds of cards nobody is going to buy. It fires when the
 * operator has shortlisted a card and clicks the button — which is exactly
 * the workflow it was asked for.
 *
 * WHAT THE MODEL DECIDES AND WHAT IT DOES NOT:
 *   - The model MEASURES (border ratios) and OBSERVES (visible defects, is
 *     the back shown, is there glare, is this a stock photo).
 *   - Deterministic code in packages/core decides what a measurement MEANS,
 *     against grade tolerances the graders themselves publish.
 * The model never sees the tolerance table and is never asked for a grade.
 * Swapping the model cannot change what 65/35 implies about a PSA 10.
 */
export const photoAssessmentRoute = new Hono<{ Bindings: Env }>();

function rowToPayload(row: PhotoAssessmentRow) {
  return {
    id: row.id,
    createdAt: row.created_at,
    assessment: JSON.parse(row.assessment_json),
    graderId: row.grader_id,
    frontWorstPct: row.front_worst_pct,
    backWorstPct: row.back_worst_pct,
    centeringCeilingKey: row.centering_ceiling_key,
    modelId: row.model_id,
    promptVersionId: row.prompt_version_id,
    imageUrls: JSON.parse(row.image_urls_json),
  };
}

interface ListingJoin extends OpportunityRow {
  listing_id: string;
  title: string;
  image_urls: string | null;
  condition_description: string | null;
  card_name: string | null;
}

async function loadContext(db: Db, opportunityId: string): Promise<ListingJoin | null> {
  return db.queryFirst<ListingJoin>(
    `SELECT o.*, l.id AS listing_id, l.title, l.image_urls, l.condition_description, c.name AS card_name
       FROM opportunities o
       JOIN ebay_listings l ON l.id = o.listing_id
       JOIN cards c ON c.id = o.card_id
      WHERE o.id = ?`,
    opportunityId,
  );
}

/** The most recent assessment for this opportunity's listing, if any. */
photoAssessmentRoute.get("/opportunity/:opportunityId", async (c) => {
  const db = new Db(c.env.DB);
  const context = await loadContext(db, c.req.param("opportunityId"));
  if (!context) return c.json({ error: "Not found" }, 404);

  const row = await latestAssessmentForListing(db, context.listing_id);
  if (!row) {
    // Report what an assessment WOULD have to work with, so the operator can
    // see before spending anything that this listing has one photograph and
    // no back shot.
    let imageCount = 0;
    try {
      const parsed = JSON.parse(context.image_urls ?? "[]");
      if (Array.isArray(parsed)) imageCount = parsed.length;
    } catch {
      imageCount = 0;
    }
    return c.json({ assessment: null, availableImageCount: imageCount, centeringChecks: [] });
  }

  const assessment = JSON.parse(row.assessment_json);
  const { checks } = deriveCentering(assessment, row.grader_id);
  return c.json({
    assessment: rowToPayload(row),
    centeringChecks: checks,
    centeringStandard: centeringStandard(row.grader_id),
    availableImageCount: (JSON.parse(row.image_urls_json) as string[]).length,
  });
});

/** Run an assessment. Costs money; deliberately a POST and deliberately manual. */
photoAssessmentRoute.post("/opportunity/:opportunityId", async (c) => {
  const db = new Db(c.env.DB);
  const opportunityId = c.req.param("opportunityId");

  const context = await loadContext(db, opportunityId);
  if (!context) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json().catch(() => ({}));
  const requestedGrader = typeof (body as Record<string, unknown>)?.graderId === "string"
    ? String((body as Record<string, unknown>).graderId)
    : "PSA";

  // The grade ladder the ceiling is expressed against has to be a real,
  // published one. A grader with no scale on file cannot have its outcomes
  // reasoned about without inventing them — the same rule the deal desk
  // applies.
  if (!graderScale(requestedGrader)) {
    return c.json(
      {
        error: `graderId must be one with a published grade scale on file (${Object.keys(GRADER_SCALES).join(", ")}).`,
      },
      400,
    );
  }

  let imageUrls: string[] = [];
  try {
    const parsed = JSON.parse(context.image_urls ?? "[]");
    if (Array.isArray(parsed)) imageUrls = parsed.filter((u): u is string => typeof u === "string");
  } catch {
    imageUrls = [];
  }

  if (imageUrls.length === 0) {
    return c.json(
      { error: "This listing has no stored photographs, so there is nothing to assess.", assessment: null },
      400,
    );
  }

  const settings = await loadSettings(db);

  // Same construction chain as every other AI feature: the cache wrapper
  // enforces the daily spend cap and records usage before the call is made.
  const model = new AiCompletionCache(db, createAiModelProvider(c.env), {
    dailySpendCapUsd: settings.ai.dailySpendCapUsd,
    pricing: settings.ai.pricingUsdPerMTok,
    scanRunId: null,
  });

  const provider = new AiPhotoAssessmentProvider(model);
  const result = await provider.assess({
    cardName: context.card_name ?? "(unknown card)",
    listingTitle: context.title,
    conditionText: context.condition_description,
    imageUrls,
  });

  if (!result.available || !result.assessment) {
    // The exact upstream reason, never a paraphrase — most often "no API key
    // configured" or the daily cap having been reached, and the operator
    // needs to know which.
    return c.json({ error: result.error, assessment: null }, 502);
  }

  const derived = deriveCentering(result.assessment, requestedGrader);

  const id = crypto.randomUUID();
  await saveAssessment(db, {
    id,
    listingId: context.listing_id,
    opportunityId,
    cardId: context.card_id,
    assessment: result.assessment,
    graderId: requestedGrader,
    frontWorstPct: derived.frontWorst,
    backWorstPct: derived.backWorst,
    centeringCeilingKey: derived.ceilingKey,
    modelId: result.modelId,
    promptVersionId: result.promptVersionId,
    imageUrls: result.imagesUsed,
    inputTokens: result.usage?.inputTokens ?? null,
    outputTokens: result.usage?.outputTokens ?? null,
  });

  const saved = await latestAssessmentForListing(db, context.listing_id);
  return c.json(
    {
      assessment: saved ? rowToPayload(saved) : null,
      centeringChecks: derived.checks,
      centeringStandard: centeringStandard(requestedGrader),
    },
    201,
  );
});

/**
 * How well these assessments have actually predicted anything, measured
 * against grades that really came back.
 *
 * This is the honest answer to "how accurate is it": not a claim, a tally.
 * Early on it will show almost nothing, which is the correct thing for it to
 * show.
 */
photoAssessmentRoute.get("/calibration", async (c) => {
  const db = new Db(c.env.DB);
  const buckets = await centeringCalibration(db);
  const withOutcome = buckets.reduce((n, b) => n + b.withOutcome, 0);

  return c.json({
    buckets,
    totalWithOutcome: withOutcome,
    // Said in the payload, not left to the UI to remember: a hit rate over a
    // handful of cards is not a hit rate.
    interpretation:
      withOutcome < 20
        ? `Only ${withOutcome} assessed card${withOutcome === 1 ? " has" : "s have"} a returned grade so far. That is far too few to read as an accuracy rate — it is a tally, not a track record.`
        : `Based on ${withOutcome} assessed cards with a returned grade. Still your own sample, not a general claim about the method.`,
  });
});
