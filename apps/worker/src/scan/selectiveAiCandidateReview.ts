import { Db } from "@mwmc/db";
import {
  createAiModelProvider,
  AiCompletionCache,
  GuardedAiModelProvider,
  AiCandidateRouterProvider,
} from "@mwmc/providers";
import { getAlreadyEnrichedListingIds, getListingsByIds } from "../repo/listingsRepo.js";
import { listOpportunitiesForAiReview, applyAiCandidateReview, type OpportunityForAiReview } from "../repo/opportunitiesRepo.js";
import { buildAdvisoryEconomicsFacts, buildAdvisoryEvidence } from "../ai/advisoryEvidence.js";
import type { AiSettings } from "../repo/settingsRepo.js";
import type { Env } from "../env.js";

/**
 * The enrichment-ordering fix, isolated from AI-provider wiring so it can
 * be regression-tested against a fake Db alone (see
 * scanAiEnrichmentOrdering.test.ts) — no need to also fake
 * createAiModelProvider/AiCompletionCache/GuardedAiModelProvider/
 * AiCandidateRouterProvider just to prove the SELECTION contract holds
 * (that part — AI failure/spend-cap/missing-key never implicitly becoming
 * PASS/BLOCK — is already covered by AiCandidateRouterProvider's,
 * GuardedAiModelProvider's and AiCompletionCache's own test suites).
 *
 * Returns exactly the QUALIFIED_STATES, never-AI-reviewed opportunities
 * whose listing has GENUINELY completed stage-two enrichment (ebay_listings.
 * enriched_at IS NOT NULL — see getAlreadyEnrichedListingIds), capped at
 * `maxCandidateReviewCallsPerRun`. The cap is applied AFTER the enrichment
 * filter, never before — otherwise a run with many eligible-but-unenriched
 * candidates ahead of the enriched ones in id order could exhaust the review
 * budget on candidates that get filtered out anyway, starving genuinely
 * enriched candidates of a review slot for no reason.
 */
export async function selectCandidatesForAiReview(
  db: Db,
  enrichmentEligibleListingIds: Set<string>,
  maxCandidateReviewCallsPerRun: number,
): Promise<OpportunityForAiReview[]> {
  const enrichedForReview =
    enrichmentEligibleListingIds.size > 0
      ? await getAlreadyEnrichedListingIds(db, Array.from(enrichmentEligibleListingIds))
      : new Set<string>();

  if (enrichedForReview.size === 0) return [];

  const eligible = await listOpportunitiesForAiReview(db, Array.from(enrichedForReview));
  return eligible.slice(0, maxCandidateReviewCallsPerRun);
}

export interface SelectiveAiCandidateReviewResult {
  aiReviewedThisRun: number;
  errors: string[];
}

/**
 * AI INTELLIGENCE gap 3 (selective AI review in the candidate pipeline).
 *
 * Extracted out of runScan (RELEASE HARDENING 2026-09-03) for two reasons:
 * (1) this is the step that had the enrichment-ordering bug described
 *     below, and pulling it out lets that fix be regression-tested in
 *     isolation, against a fake Db, without also having to fake catalogue
 *     sync / market profiling / eBay search just to reach this code; (2) it
 *     keeps runScan itself as a thin pipeline of named steps.
 *
 * BUG FIX this pass: this step used to be handed the FULL enrichment-
 * eligible listing-id set (every QUALIFIED_STATES candidate persisted this
 * run) and ran AI review against all of them, regardless of whether
 * stage-two eBay enrichment (a SEPARATE, budget-capped step — see
 * scanRunner.ts) had actually succeeded for a given listing. Enrichment can
 * fail per-listing (ended/delisted/rate-limited) or simply never reach a
 * listing because its own cap (settings.ebayScanBudget.
 * maxEnrichmentCallsPerRun) was hit first. Because listOpportunitiesForAiReview
 * only ever selects rows with ai_review_status IS NULL, a candidate that
 * got an AI opinion on bare search-result evidence (buildAdvisoryEvidence
 * on a never-enriched listing — no condition descriptors, no description,
 * no aspects) would have its ai_review_status written PERMANENTLY, and
 * could then never be reconsidered even after a later run successfully
 * enriched it and richer evidence became available. That is unsafe: a
 * PASS_THROUGH or BLOCK_FROM_ACTIONABLE decision made on incomplete
 * evidence, locked in for good.
 *
 * The fix: re-derive eligibility from ground truth —
 * ebay_listings.enriched_at IS NOT NULL (see getAlreadyEnrichedListingIds)
 * — not from "was eligible for enrichment this run". This naturally:
 *   - includes listings enrichment successfully enriched THIS run;
 *   - includes listings already enriched by an EARLIER run (their evidence
 *     is still genuine, even though this run didn't re-touch them);
 *   - excludes anything enrichment skipped, was capped out on, or failed
 *     for — those candidates simply aren't offered to AI review at all,
 *     leaving ai_review_status = NULL exactly as if this step hadn't
 *     reached them yet, ready to be picked up on a future run once real
 *     evidence exists.
 *
 * Untouched by this fix (already correct, verified while fixing the
 * above): AI failure, the daily spend cap, or a missing/unconfigured API
 * key all surface as `routeResult.available === false` from
 * AiCandidateRouterProvider — see its own doc comment — and this step
 * only ever calls applyAiCandidateReview when `available && route`, so
 * none of those conditions can implicitly become a PASS_THROUGH or
 * BLOCK_FROM_ACTIONABLE decision either.
 *
 * This step ONLY ever calls applyAiCandidateReview — the one function
 * allowed to write ai_review_status/ai_review_reason/ai_review_confidence/
 * ai_reviewed_at (migration 0021) — never touches `state`, `qualifies`, or
 * any economics column, and creates no opportunities. One candidate's AI
 * call failing (network/upstream error) is non-fatal: the opportunity
 * itself is already persisted regardless of whether AI ever weighs in.
 */
export async function runSelectiveAiCandidateReview(
  db: Db,
  env: Env,
  scanRunId: string,
  enrichmentEligibleListingIds: Set<string>,
  aiSettings: AiSettings,
): Promise<SelectiveAiCandidateReviewResult> {
  const errors: string[] = [];
  let aiReviewedThisRun = 0;

  const toReview = await selectCandidatesForAiReview(db, enrichmentEligibleListingIds, aiSettings.maxCandidateReviewCallsPerRun);
  if (toReview.length === 0) {
    return { aiReviewedThisRun, errors };
  }

  try {
    const listingRows = await getListingsByIds(db, Array.from(new Set(toReview.map((o) => o.listing_id))));
    const modelProvider = createAiModelProvider(env);
    const cached = new AiCompletionCache(db, modelProvider, {
      dailySpendCapUsd: aiSettings.dailySpendCapUsd,
      pricing: aiSettings.pricingUsdPerMTok,
      scanRunId,
    });
    const guarded = new GuardedAiModelProvider(cached);
    const router = new AiCandidateRouterProvider(guarded);

    for (const opp of toReview) {
      try {
        const listing = listingRows.get(opp.listing_id) ?? null;
        const routeResult = await router.routeCandidate({
          cardName: opp.card_name,
          strategy: opp.strategy as "FLIP" | "GRADE",
          state: opp.state,
          listingTitle: listing?.title ?? "",
          listingPrice: opp.listing_price,
          totalAcquisitionCost: opp.total_acquisition_cost,
          economicsFacts: buildAdvisoryEconomicsFacts(opp),
          reasoning: opp.reasoning ? JSON.parse(opp.reasoning) : [],
          ...buildAdvisoryEvidence(listing),
        });

        // available:false (no AI configured, spend cap, upstream error,
        // guardrail rejection) is NEVER written as a block — see
        // CandidateRouteResponse's own doc comment. Simply skip; the row
        // stays ai_review_status = NULL, exactly as if this step hadn't
        // reached it yet, and a later run can retry it.
        if (routeResult.available && routeResult.route) {
          await applyAiCandidateReview(db, opp.id, {
            route: routeResult.route,
            confidence: routeResult.confidence,
            reason: routeResult.reason,
          });
          aiReviewedThisRun++;
        }
      } catch (err) {
        errors.push(`AI candidate review failed for opportunity ${opp.id} (listing ${opp.listing_id}): ${String(err)}`);
      }
    }
  } catch (err) {
    errors.push(`AI candidate review step failed: ${String(err)}`);
  }

  return { aiReviewedThisRun, errors };
}
