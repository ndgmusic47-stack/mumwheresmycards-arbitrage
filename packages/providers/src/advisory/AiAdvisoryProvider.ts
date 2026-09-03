/**
 * SOURCING WORKFLOW item 15: "optional AI-advisory interface stub only, no
 * live integration." This file is exactly that — an interface a future AI
 * advisory feature could implement, plus the one implementation that
 * exists today, which does nothing live. No network call, no API key, no
 * model, no Kimi/any-other integration — all explicitly out of scope per
 * this spec's own DO-NOT-DO list ("no AI agent", "no autonomous
 * purchasing", "no Kimi integration yet"). Mirrors this codebase's existing
 * provider-interface pattern (EbayListingsProvider, MarketDataProvider) so
 * that if a future spec authorises a real integration, it's a new class
 * implementing this same interface — nothing that depends on
 * AiAdvisoryProvider needs to change.
 */
export interface AiAdvisoryRequest {
  opportunityId: string;
  cardName: string;
  strategy: "FLIP" | "GRADE";
  listingTitle: string;
  listingPrice: number;
  totalAcquisitionCost: number;
  /** The engine's own already-computed reasoning for this opportunity —
   *  handed to the provider so a future real implementation could use it
   *  as context, not so this stub does anything with it. */
  reasoning: string[];
  /** AI INTELLIGENCE spec Phase 2, Workstream J: every already-computed
   *  numeric economics figure worth grounding a real AI response against —
   *  net profit, ROC, QSV, grade-ladder figures, etc. Strategy-conditional
   *  (FLIP vs GRADE expose different fields; see
   *  `buildAdvisoryEconomicsFacts` in apps/worker/src/routes/opportunities.ts),
   *  built from the SAME OpportunityRow columns the dashboard/detail page
   *  already show — never a number invented for this request. Optional so
   *  existing callers (and NullAiAdvisoryProvider, which never reads it)
   *  don't need updating; a real provider passes it straight through as
   *  AiCompletionRequest.groundTruthFacts (see AiGuardrails.ts,
   *  Workstream I) so a hallucinated restatement of one of these numbers
   *  is caught, not trusted. */
  economicsFacts?: Record<string, number>;

  // ---------------------------------------------------------------------
  // AI INTELLIGENCE gap 2 (multimodal, evidence-rich Listing Analyst),
  // added 2026-09-03. Every field below is OPTIONAL and additive — an
  // existing caller that builds an AiAdvisoryRequest without them (and
  // NullAiAdvisoryProvider, which reads none of them) keeps working
  // completely unchanged. All of it is data this app already collects
  // (SOURCING WORKFLOW item 9's stage-two eBay enrichment, and the
  // search-stage listing itself) — nothing new is fetched FOR this
  // request; this is about actually handing the AI layer evidence that
  // already exists instead of just a title and a price.
  // ---------------------------------------------------------------------

  /** eBay's own single-word/short condition label for the listing (e.g.
   *  "USED", "NEW"), captured at search time — independent of the deeper
   *  stage-two fields below, which may be absent if this listing was never
   *  enriched. */
  itemCondition?: string | null;
  /** eBay's free-text condition elaboration from stage-two enrichment (e.g.
   *  "Excellent - Lightly played, minor edge wear"). Absent/undefined when
   *  this listing has never been through stage-two enrichment. */
  conditionDescription?: string | null;
  /** RAW/unmapped eBay condition-descriptor dictionary codes from
   *  stage-two enrichment — same "never guess a mapping" discipline as the
   *  rest of this app (see EbayConditionDescriptor's doc comment). Handed
   *  to the model labeled honestly as raw/unmapped codes, exactly as a
   *  human reviewer sees them in this app's own UI — never translated into
   *  invented words. */
  conditionDescriptors?: { name: string; values: string[] }[];
  /** eBay's full free-text listing description from stage-two enrichment
   *  (migration 0020) — often carries condition/authenticity detail a
   *  title can't fit. */
  itemDescription?: string | null;
  /** eBay's seller-declared item specifics from stage-two enrichment
   *  (migration 0020) — e.g. Language/Grade/Card Condition. Genuine
   *  structured evidence, distinct from this app's own deterministic
   *  classification. */
  aspects?: { name: string; value: string }[];
  /** eBay seller feedback score/percentage, captured at search time —
   *  evidence for a "how much to trust this seller's own description"
   *  read, never used by this app's own economics. */
  sellerFeedbackScore?: number | null;
  sellerFeedbackPct?: number | null;
  /** Listing photo URLs (eBay's own hosted images) — when present, these
   *  are sent to the model as real image content (see AiCompletionRequest
   *  .images / OpenAiModelProvider.ts), not merely described in text. A
   *  provider with no images (empty array or omitted) degrades to a
   *  text-only request exactly as before this field existed. */
  imageUrls?: string[];
}

/**
 * AI INTELLIGENCE gap 2: one structured, evidence-backed assessment in the
 * Listing Analyst's response — e.g. its read on raw/slab/lot, variant,
 * language, or why a listing might be priced low. `evidence` is REQUIRED
 * (never an empty string) so every assessment traces back to something the
 * model actually saw (a title phrase, a seller aspect, a described
 * condition, a visual detail in a supplied photo) — a bare conclusion with
 * no evidence is exactly the shape of a fabricated one, and this app's
 * whole AI discipline (see AiModelProvider.ts's file doc comment) is never
 * to trust that by construction. `confidence` is the model's own
 * self-reported certainty (0-1) — never computed or validated by this app,
 * surfaced as-is for a human to weigh alongside the evidence itself.
 */
export interface AiListingAssessment {
  value: string;
  confidence: number;
  evidence: string;
}

export interface AiAdvisoryResponse {
  /** false in every case today. A real implementation would still need to
   *  report this honestly (e.g. a live API outage), so callers must always
   *  check it rather than assuming `summary` is populated whenever the
   *  request succeeds. */
  available: boolean;
  summary: string | null;
  caveats: string[];

  // AI INTELLIGENCE gap 2: structured, evidence-backed assessments —
  // present only when `available` is true AND the underlying provider
  // populated them (NullAiAdvisoryProvider and any pre-gap-2 provider
  // never do, so these stay undefined for those, never a fabricated
  // default). Purely advisory narrative content — see AiListingAnalystProvider's
  // file doc comment: none of this ever creates an opportunity, alters a
  // financial number, or drives routing on its own (that's gap 3's job,
  // with its own guardrails).
  identity?: AiListingAssessment;
  /** The model's read on what's actually being sold — a single raw card,
   *  a graded slab, or a lot/bundle of multiple cards — as opposed to this
   *  app's own deterministic classifier (packages/core's listing
   *  classification, STABILISATION item 6), which this is never a
   *  replacement or override for. */
  itemType?: AiListingAssessment;
  variant?: AiListingAssessment;
  language?: AiListingAssessment;
  /** The model's own qualitative condition read (from title/description/
   *  aspects/photos) — distinct from eBay's own itemCondition/
   *  conditionDescription, which are given to it as evidence, not computed
   *  by it. */
  condition?: AiListingAssessment;
  visibleDamage?: AiListingAssessment;
  photoQuality?: AiListingAssessment;
  /** The model's read on why this listing might be priced below what the
   *  card typically sells for — poor photos, an uncertain/inexperienced
   *  seller, a described flaw, a misleading title, or "nothing found,
   *  genuinely looks underpriced." Complements (never replaces) this app's
   *  own deterministic "why is this cheap?" panel (SOURCING WORKFLOW item
   *  10), which stays the authoritative numeric explanation. */
  reasonCheap?: AiListingAssessment;
}

export interface AiAdvisoryProvider {
  readonly name: string;
  getAdvisory(request: AiAdvisoryRequest): Promise<AiAdvisoryResponse>;
}

/**
 * The only implementation wired up right now. Always reports
 * `available: false` with an explanatory caveat — never a fabricated
 * summary, never a silent no-op that looks like a real answer.
 */
export class NullAiAdvisoryProvider implements AiAdvisoryProvider {
  readonly name = "none";

  async getAdvisory(_request: AiAdvisoryRequest): Promise<AiAdvisoryResponse> {
    return {
      available: false,
      summary: null,
      caveats: ["AI advisory is not connected in this build — this is an interface stub only, per the current spec."],
    };
  }
}
