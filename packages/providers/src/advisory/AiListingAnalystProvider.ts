import type { AiCompletionImageInput, AiModelProvider } from "../ai/AiModelProvider.js";
import { definePromptTemplate, buildAiRequest } from "../ai/promptVersioning.js";
import type { AiAdvisoryProvider, AiAdvisoryRequest, AiAdvisoryResponse, AiListingAssessment } from "./AiAdvisoryProvider.js";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream J: the AI Listing Analyst — the
 * first real `AiAdvisoryProvider` implementation, replacing
 * NullAiAdvisoryProvider wherever an AiModelProvider is actually
 * available. Wraps a fully-assembled provider chain (created by the
 * caller — see apps/worker/src/routes/opportunities.ts — as
 * `createAiModelProvider(env)` -> `AiCompletionCache` (Workstream G) ->
 * `GuardedAiModelProvider` (Workstream I)) behind the SAME
 * `AiAdvisoryProvider` interface the SOURCING WORKFLOW spec's stub already
 * defined, so no caller of `getAdvisory()` — worker route or web client —
 * needed to change at all. When no OPENAI_API_KEY is configured,
 * `createAiModelProvider` still returns a NullAiModelProvider, so this
 * class degrades to the exact same honest "unavailable" response
 * NullAiAdvisoryProvider always gave — this class is never itself the
 * thing deciding whether AI is "on."
 *
 * A SCHEMA DESIGN CHOICE WORTH CALLING OUT: the response schema asks the
 * model to echo back `statedTotalAcquisitionCost` — a number it was
 * already given, not something new. This is deliberate: it exists purely
 * so GuardedAiModelProvider's exact-match GROUND_TRUTH_CONTRADICTION check
 * (Workstream I) has a genuine, reliable structured field to verify a
 * response against. A free-text narrative alone could restate £45.20 as
 * £200 without ever tripping a currency-figure regex if it phrased things
 * unusually — a required structured echo of a known fact can't dodge
 * detection that way. The app doesn't need this echoed value for anything
 * — it's a canary, not a feature.
 *
 * AI INTELLIGENCE gap 2 (2026-09-03): this class became genuinely
 * multimodal and evidence-rich here. Two changes, both additive:
 *
 * 1. EVIDENCE: every enriched eBay field this app already collects but
 *    previously never showed the model — condition_descriptors (raw,
 *    unmapped, labeled honestly as such), condition_description,
 *    item_description, aspects (seller-declared item specifics), seller
 *    feedback — is now woven into the input text when present. All of it
 *    is OPTIONAL on AiAdvisoryRequest (a listing never enriched via
 *    stage-two SOURCING WORKFLOW item 9 simply omits those lines, exactly
 *    as before this change).
 * 2. IMAGES: listing photo URLs, when present, are sent to the model as
 *    real image content (AiCompletionRequest.images -> OpenAiModelProvider's
 *    input_image content items) — not merely described in text. Capped at
 *    MAX_IMAGES (below) to bound cost/tokens; the app's own listing photos
 *    rarely need more than the first few to show condition/authenticity.
 *
 * Both feed a NEW set of structured, evidence-backed assessments in the
 * response (identity/itemType/variant/language/condition/visibleDamage/
 * photoQuality/reasonCheap — see AiListingAssessment's doc comment) — the
 * model's own qualitative read, always required to cite what it actually
 * saw. Per this app's founding "AI NEVER A SOURCE OF FINANCIAL NUMBERS"
 * discipline (AiModelProvider.ts), none of this touches economics: no
 * assessment here is numeric-financial, none of it is grounded against (or
 * checked by) GuardedAiModelProvider's ground-truth economics check, and
 * this class still creates no opportunities and alters no financial figure
 * — it narrates, nothing more. Gap 3 (selective AI review in the
 * pipeline) is a SEPARATE, not-yet-built consumer that may one day read
 * these assessments for routing; this class does not route anything
 * itself.
 */
interface ListingAnalystVars {
  cardName: string;
  strategy: "FLIP" | "GRADE";
  listingTitle: string;
  listingPrice: number;
  totalAcquisitionCost: number;
  economicsFacts: Record<string, number>;
  reasoning: string[];
  itemCondition: string | null;
  conditionDescription: string | null;
  conditionDescriptors: { name: string; values: string[] }[];
  itemDescription: string | null;
  aspects: { name: string; value: string }[];
  sellerFeedbackScore: number | null;
  sellerFeedbackPct: number | null;
  imageCount: number;
}

/** AI INTELLIGENCE gap 2: bounds how many listing photos are ever sent in
 *  one call — real cost/token control (OpenAI bills and rate-limits image
 *  input), not an arbitrary number. A handful of a listing's own photos
 *  (front/back/any close-up) covers what a human reviewer would actually
 *  look at first; a listing with more than this many gets the first
 *  MAX_IMAGES in whatever order the provider returned them (the search
 *  provider's own primary-image-first ordering — this class does not
 *  attempt to pick "the best" ones, that would be a guess this app has no
 *  basis for). */
const MAX_IMAGES = 4;

const INSTRUCTIONS = [
  "You are a cautious trading-card sourcing analyst helping a human decide whether to buy a listed card for arbitrage (FLIP resale) or grading (GRADE resale).",
  "You are given exact numbers this app's own deterministic pricing engine already computed — treat every number in the input as ground truth. Never recompute, round differently, or restate any given figure with a different value; if you reference a given number, use it exactly as given.",
  "Never invent a price, comp, sale, or fact that was not given to you. If you are uncertain about something, say so plainly rather than guessing.",
  "You may also be given eBay's own condition/description/seller data, and one or more of the listing's own photos. Use all of it as evidence for your assessments below — but the eBay condition_descriptors codes are RAW, UNMAPPED dictionary IDs (this app has not verified what each code means): quote them as codes if you reference them, never invent an English label for one.",
  'Respond with the exact JSON shape described: "summary" (2-4 plain-English sentences on this specific opportunity — what stands out, what to verify before buying), "caveats" (a short list of specific risks or things worth double-checking; may be an empty array if there genuinely are none beyond the obvious), "statedTotalAcquisitionCost" (echo the total acquisition cost figure from the input, completely unchanged, as a bare number), and eight structured assessments — identity, itemType, variant, language, condition, visibleDamage, photoQuality, reasonCheap.',
  'EVERY structured assessment must have: "value" (your conclusion — short, specific), "confidence" (0 to 1, your own honest certainty — low confidence is a completely valid, expected answer when the evidence is thin), and "evidence" (the SPECIFIC title text, description text, seller aspect, condition data, or visual detail in a supplied photo that your conclusion is based on — never a restated conclusion with no evidence, and never fabricated evidence when none exists; if there is genuinely no evidence either way, say so plainly in "evidence" and set confidence low).',
  'Specific guidance per assessment: "itemType" — is this a single raw card, a graded slab, or a lot/bundle of multiple cards (value one of RAW_SINGLE, GRADED_SLAB, LOT_BUNDLE, UNCLEAR)? "photoQuality" — are the supplied photos (if any) clear enough to actually judge condition from (value one of GOOD, POOR, INSUFFICIENT — use INSUFFICIENT when no usable photos were supplied at all)? "visibleDamage" — describe anything you can actually see or that is explicitly described (creasing, whitening, surface wear, etc.), or state plainly that none was observed. "reasonCheap" — your best read on why this might be priced below typical market value (poor photos, an uncertain seller, a described flaw, a misleading title) — or state plainly that nothing stands out and it may simply be a genuine find.',
].join("\n\n");

function renderListingAnalystInput(vars: ListingAnalystVars): string {
  const factLines = Object.entries(vars.economicsFacts)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  const reasoningLines = vars.reasoning.length > 0 ? vars.reasoning.map((r) => `- ${r}`).join("\n") : "(none recorded)";

  const evidenceLines: string[] = [];
  if (vars.itemCondition) evidenceLines.push(`eBay condition label: ${vars.itemCondition}`);
  if (vars.conditionDescription) evidenceLines.push(`eBay condition description (free text, seller/eBay-provided): ${vars.conditionDescription}`);
  if (vars.conditionDescriptors.length > 0) {
    const codes = vars.conditionDescriptors.map((d) => `${d.name}: ${d.values.join("/")}`).join(", ");
    evidenceLines.push(`eBay condition-descriptor codes (RAW/unmapped dictionary IDs, not English words): ${codes}`);
  }
  if (vars.itemDescription) evidenceLines.push(`eBay listing description (seller's own free text):\n${vars.itemDescription}`);
  if (vars.aspects.length > 0) {
    evidenceLines.push(`eBay item specifics (seller-declared): ${vars.aspects.map((a) => `${a.name}=${a.value}`).join(", ")}`);
  }
  if (vars.sellerFeedbackScore !== null || vars.sellerFeedbackPct !== null) {
    evidenceLines.push(
      `Seller feedback: ${vars.sellerFeedbackScore ?? "unknown"} ratings, ${vars.sellerFeedbackPct ?? "unknown"}% positive`,
    );
  }
  evidenceLines.push(
    vars.imageCount > 0
      ? `${vars.imageCount} listing photo(s) are attached to this request for you to actually look at.`
      : "No listing photos were available for this request.",
  );

  return [
    `Card: ${vars.cardName}`,
    `Strategy: ${vars.strategy}`,
    `Listing title: ${vars.listingTitle}`,
    `Listing price: £${vars.listingPrice}`,
    `Total acquisition cost (price + postage + fees, already computed — this is the figure to echo back exactly as statedTotalAcquisitionCost): £${vars.totalAcquisitionCost}`,
    `Already-computed economics:\n${factLines || "(none available for this strategy/state)"}`,
    `This app's own engine reasoning for this opportunity:\n${reasoningLines}`,
    `Additional evidence:\n${evidenceLines.join("\n")}`,
  ].join("\n\n");
}

/**
 * Defined once, at module scope, per the promptVersioning.ts (Workstream H)
 * contract — every real prompt template goes through definePromptTemplate()
 * so a malformed id/version fails loudly at startup, never silently at the
 * first real call.
 */
export const LISTING_ANALYST_TEMPLATE = definePromptTemplate<ListingAnalystVars>({
  id: "listing_analyst_advisory",
  version: 2,
  description:
    "AI Listing Analyst (Workstream J; made multimodal/evidence-rich for AI INTELLIGENCE gap 2, 2026-09-03) — a short narrative risk/opportunity summary PLUS structured, evidence-backed identity/condition/photo-quality/reason-cheap assessments for a single opportunity, grounded against this app's own already-computed economics and (when available) enriched eBay evidence and listing photos.",
  render: (vars) => ({
    instructions: INSTRUCTIONS,
    input: renderListingAnalystInput(vars),
  }),
});

/** AI INTELLIGENCE gap 2: shared shape for every structured assessment
 *  field — see AiListingAssessment's doc comment (AiAdvisoryProvider.ts)
 *  for what each part means. A fresh object per call site (never a shared
 *  reference) so each field's `value` description can be tailored, and
 *  because strict-mode JSON Schema objects must be independently valid. */
function assessmentSchema(valueDescription: string, valueEnum?: readonly string[]) {
  return {
    type: "object",
    properties: {
      value: {
        type: "string",
        description: valueDescription,
        ...(valueEnum ? { enum: valueEnum } : {}),
      },
      confidence: { type: "number", description: "Your own honest certainty in this assessment, 0 to 1." },
      evidence: {
        type: "string",
        description:
          "The specific title text, description text, seller aspect, condition data, or visual photo detail this assessment is based on. State plainly if there is genuinely no evidence either way — never fabricate evidence.",
      },
    },
    required: ["value", "confidence", "evidence"],
    additionalProperties: false,
  } as const;
}

const RESPONSE_SCHEMA = {
  name: "listing_analyst_advisory",
  schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "2-4 sentence plain-English analysis of this opportunity for a human deciding whether to buy it.",
      },
      caveats: {
        type: "array",
        items: { type: "string" },
        description: "Specific risks or things worth double-checking before buying. May be an empty array.",
      },
      statedTotalAcquisitionCost: {
        type: "number",
        description: "Echo the exact total acquisition cost figure given in the input, unchanged — do not recalculate or round it.",
      },
      identity: assessmentSchema("Does the listing genuinely appear to be the stated card? e.g. MATCH, MISMATCH, or UNCERTAIN."),
      itemType: assessmentSchema(
        "What is actually being sold.",
        ["RAW_SINGLE", "GRADED_SLAB", "LOT_BUNDLE", "UNCLEAR"] as const,
      ),
      variant: assessmentSchema("Any variant/printing detail observed (e.g. 1st edition, reverse holo, alt art) or 'none observed'."),
      language: assessmentSchema("The card's language, if determinable from evidence (e.g. English, Japanese), or 'unclear'."),
      condition: assessmentSchema("Your own qualitative condition read from the evidence and any supplied photos."),
      visibleDamage: assessmentSchema("Any specific damage/wear you can see or that is explicitly described, or 'none observed'."),
      photoQuality: assessmentSchema(
        "Whether supplied photos (if any) are clear enough to judge condition from.",
        ["GOOD", "POOR", "INSUFFICIENT"] as const,
      ),
      reasonCheap: assessmentSchema("Your best read on why this might be priced below typical market value, or 'nothing stands out'."),
    },
    required: [
      "summary",
      "caveats",
      "statedTotalAcquisitionCost",
      "identity",
      "itemType",
      "variant",
      "language",
      "condition",
      "visibleDamage",
      "photoQuality",
      "reasonCheap",
    ],
    additionalProperties: false,
  },
} as const;

// Structurally much larger response than v1 (eight assessment objects on
// top of summary/caveats) — bumped from 500 to keep the model from
// truncating mid-schema, which would surface as a parse-failure error
// (see OpenAiModelProvider.ts) rather than a usable partial answer.
const MAX_OUTPUT_TOKENS = 1400;

/** Always present in `caveats`, in addition to whatever the model reported
 *  itself and whatever the guardrail flagged — same "surface for a human
 *  to verify, never silently decide" discipline as every other AI/derived
 *  panel in this app (the condition-truth and "why is this cheap?"
 *  panels). */
const STANDING_CAVEAT =
  "AI-generated analysis — this app's own deterministic pricing (not the model) is what qualified this opportunity; verify against those numbers before acting.";

/** Reads one AiListingAssessment out of parsedJson, defensively — never
 *  throws on an unexpected shape (OpenAI's strict-mode schema conformance
 *  should already guarantee this, but this class makes no assumption
 *  about what produced parsedJson, same discipline as the rest of this
 *  provider chain). Returns undefined (not a fabricated placeholder) when
 *  the field is missing or malformed. */
function readAssessment(parsed: Record<string, unknown> | null | undefined, key: string): AiListingAssessment | undefined {
  const raw = parsed?.[key];
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.value !== "string" || typeof obj.evidence !== "string" || typeof obj.confidence !== "number") return undefined;
  return { value: obj.value, confidence: obj.confidence, evidence: obj.evidence };
}

export class AiListingAnalystProvider implements AiAdvisoryProvider {
  readonly name = "listing-analyst";

  constructor(private readonly modelProvider: AiModelProvider) {}

  async getAdvisory(request: AiAdvisoryRequest): Promise<AiAdvisoryResponse> {
    const economicsFacts = request.economicsFacts ?? {};
    // The canary field (see file doc comment) is added here, not by the
    // caller — it's an implementation detail of how THIS provider grounds
    // its own responses, not a real economics figure other callers of
    // AiAdvisoryRequest should have to know about.
    const groundTruthFacts: Record<string, number> = {
      ...economicsFacts,
      statedTotalAcquisitionCost: request.totalAcquisitionCost,
    };

    // AI INTELLIGENCE gap 2: cap and shape the images this call actually
    // sends — see MAX_IMAGES's doc comment. "auto" detail (OpenAI's own
    // default) rather than "high" for every image: this is a qualitative
    // read (condition/authenticity impressions), not OCR-grade text
    // extraction, so the extra cost of "high"/"original" detail on every
    // photo isn't justified by what this feature actually needs.
    const images: AiCompletionImageInput[] = (request.imageUrls ?? [])
      .slice(0, MAX_IMAGES)
      .map((url) => ({ url, detail: "auto" as const }));

    const completionRequest = buildAiRequest(
      LISTING_ANALYST_TEMPLATE,
      {
        cardName: request.cardName,
        strategy: request.strategy,
        listingTitle: request.listingTitle,
        listingPrice: request.listingPrice,
        totalAcquisitionCost: request.totalAcquisitionCost,
        economicsFacts,
        reasoning: request.reasoning,
        itemCondition: request.itemCondition ?? null,
        conditionDescription: request.conditionDescription ?? null,
        conditionDescriptors: request.conditionDescriptors ?? [],
        itemDescription: request.itemDescription ?? null,
        aspects: request.aspects ?? [],
        sellerFeedbackScore: request.sellerFeedbackScore ?? null,
        sellerFeedbackPct: request.sellerFeedbackPct ?? null,
        imageCount: images.length,
      },
      {
        tier: "DEEP",
        responseSchema: RESPONSE_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        groundTruthFacts,
        images,
      },
    );

    const result = await this.modelProvider.complete(completionRequest);

    if (!result.available) {
      // Same honest-caveat discipline as NullAiAdvisoryProvider — never a
      // fabricated summary, and the EXACT reason (no key, spend cap,
      // upstream error, or a guardrail rejection) is surfaced, not
      // paraphrased or swallowed.
      return {
        available: false,
        summary: null,
        caveats: [result.error ?? "AI advisory is currently unavailable."],
      };
    }

    const parsed = result.parsedJson as Record<string, unknown> | null;
    const summary = typeof parsed?.summary === "string" ? parsed.summary : result.outputText;
    const modelCaveats = Array.isArray(parsed?.caveats)
      ? (parsed!.caveats as unknown[]).filter((c): c is string => typeof c === "string")
      : [];
    // UNGROUNDED_FIGURE flags (Workstream I) are non-blocking by design —
    // surfaced here as caveats rather than suppressed, same treatment as
    // the model's own self-reported caveats.
    const guardrailCaveats = (result.hallucinationFlags ?? [])
      .filter((f) => f.kind === "UNGROUNDED_FIGURE")
      .map((f) => f.detail);

    return {
      available: true,
      summary,
      caveats: [...modelCaveats, ...guardrailCaveats, STANDING_CAVEAT],
      identity: readAssessment(parsed, "identity"),
      itemType: readAssessment(parsed, "itemType"),
      variant: readAssessment(parsed, "variant"),
      language: readAssessment(parsed, "language"),
      condition: readAssessment(parsed, "condition"),
      visibleDamage: readAssessment(parsed, "visibleDamage"),
      photoQuality: readAssessment(parsed, "photoQuality"),
      reasonCheap: readAssessment(parsed, "reasonCheap"),
    };
  }
}
