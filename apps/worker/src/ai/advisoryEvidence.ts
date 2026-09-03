import type { OpportunityRow, EbayListingRow } from "@mwmc/db";
import type { AiAdvisoryRequest } from "@mwmc/providers";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream J / gap 3: pure functions that
 * turn already-persisted D1 rows into the read-only evidence/context shapes
 * the AI layer is allowed to see. Originally lived inline in
 * routes/opportunities.ts (the on-demand "AI advisory" panel was the only
 * caller); pulled out to their own module for gap 3 (selective AI review in
 * the scan pipeline, apps/worker/src/scan/scanRunner.ts) — scanRunner.ts is
 * NOT allowed to import from routes/ (routes depend on scan/repo, never the
 * reverse), so both callers now depend on this shared, dependency-free
 * module instead. No behaviour changed by the move — same functions, same
 * tests (apps/worker/test/advisoryEconomicsFacts.test.ts), same "pure,
 * no I/O, unit-tested directly" discipline as buildStateCondition/
 * buildSortClause in opportunities.ts.
 */

/**
 * Every already-computed numeric economics figure worth grounding a real AI
 * response against — see AiAdvisoryRequest.economicsFacts's own doc comment
 * (packages/providers/src/advisory/AiAdvisoryProvider.ts) for why this
 * exists and how AiListingAnalystProvider (and, since gap 3,
 * AiCandidateRouterProvider) use it. Strategy-conditional, same reasoning as
 * every other FLIP/GRADE-conditional field in this codebase (e.g.
 * buildServerFilterParams in apps/web/src/state/filters.ts) — a GRADE row
 * has no `expected_net_profit`, a FLIP row has no `total_graded_basis`, and
 * neither should silently become a fabricated 0. Only non-null, finite
 * values are included — a genuinely absent figure is simply left out of the
 * ground-truth set, never guessed at.
 */
export function buildAdvisoryEconomicsFacts(opportunity: OpportunityRow): Record<string, number> {
  const facts: Record<string, number> = {};
  const add = (key: string, value: number | null | undefined) => {
    if (value !== null && value !== undefined && Number.isFinite(value)) facts[key] = value;
  };

  add("listingPrice", opportunity.listing_price);
  add("profitPerCapitalDay", opportunity.profit_per_capital_day);
  add("returnOnCapital", opportunity.return_on_capital);

  if (opportunity.strategy === "FLIP") {
    add("qsv", opportunity.qsv);
    add("expectedNetProfit", opportunity.expected_net_profit);
    add("profitMargin", opportunity.profit_margin);
  } else if (opportunity.strategy === "GRADE") {
    add("totalGradedBasis", opportunity.total_graded_basis);
    add("psa9Profit", opportunity.psa9_profit);
    add("psa10Profit", opportunity.psa10_profit);
  }

  return facts;
}

/**
 * AI INTELLIGENCE gap 2 (multimodal, evidence-rich Listing Analyst): maps
 * an already-fetched EbayListingRow onto AiAdvisoryRequest's evidence
 * fields. Exported and unit-tested directly, same "pure function pulled
 * out for testability" pattern as buildAdvisoryEconomicsFacts above —
 * nothing here queries anything or does I/O.
 *
 * Every JSON column is parsed defensively: a listing that has never been
 * through stage-two enrichment (condition_descriptors/item_aspects both
 * null) simply omits those fields, exactly as AiAdvisoryRequest's own
 * fields are all optional for; malformed/corrupt JSON (shouldn't happen —
 * written by this app's own enrichment pipeline — but this is read-only
 * advisory context, so failing soft here beats breaking the whole
 * advisory call) degrades to "field omitted", never a thrown error.
 */
export function buildAdvisoryEvidence(listing: EbayListingRow | null): Pick<
  AiAdvisoryRequest,
  | "itemCondition"
  | "conditionDescription"
  | "conditionDescriptors"
  | "itemDescription"
  | "aspects"
  | "sellerFeedbackScore"
  | "sellerFeedbackPct"
  | "imageUrls"
> {
  if (!listing) return {};

  const parseJsonArray = <T>(raw: string | null): T[] | undefined => {
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as T[]) : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    itemCondition: listing.item_condition,
    conditionDescription: listing.condition_description,
    conditionDescriptors: parseJsonArray<{ name: string; values: string[] }>(listing.condition_descriptors),
    itemDescription: listing.item_description,
    aspects: parseJsonArray<{ name: string; value: string }>(listing.item_aspects),
    sellerFeedbackScore: listing.seller_feedback_score,
    sellerFeedbackPct: listing.seller_feedback_pct,
    imageUrls: parseJsonArray<string>(listing.image_urls),
  };
}
