import type { AiModelProvider } from "../ai/AiModelProvider.js";
import { definePromptTemplate, buildAiRequest } from "../ai/promptVersioning.js";
import type { CandidateRouteRequest, CandidateRouteResponse, CandidateRoute, CandidateRouterProvider } from "./CandidateRouterProvider.js";

/**
 * AI INTELLIGENCE gap 3: the real CandidateRouterProvider implementation —
 * a cheap, FAST-tier triage classifier run automatically by scanRunner.ts
 * for already-qualified (QUALIFIED_FLIP/QUALIFIED_GRADE/INSPECT_PHOTOS)
 * candidates, after stage-two eBay enrichment has had a chance to attach
 * real evidence. Wraps a fully-assembled provider chain (built by the
 * caller — see scanRunner.ts — exactly the same
 * `createAiModelProvider(env)` -> `AiCompletionCache` -> `GuardedAiModelProvider`
 * chain AiListingAnalystProvider is built with) behind
 * `CandidateRouterProvider`. When no OPENAI_API_KEY is configured, that
 * chain's innermost NullAiModelProvider makes `routeCandidate()` return
 * `available: false` here — this class is never itself the thing deciding
 * whether AI is "on", same discipline as AiListingAnalystProvider.
 *
 * FAST TIER, TEXT ONLY (deliberate, both cost decisions): this runs
 * automatically, per-candidate, inside the scan pipeline — not on-demand
 * from a single button click like the Listing Analyst — so it needs to be
 * the cheapest tier and needs to stay bounded (see settings.ai.
 * maxCandidateReviewCallsPerRun). No images are attached: this is a triage
 * classifier deciding whether a HUMAN should look closer, not a substitute
 * for the human's or the Listing Analyst's own visual read — the evidence
 * already collected by stage-two eBay enrichment (condition descriptors,
 * description, seller-declared aspects, seller feedback) is enough signal
 * for that narrower question.
 *
 * A SCHEMA DESIGN CHOICE WORTH CALLING OUT (same discipline as
 * AiListingAnalystProvider's canary field, taken further here): the
 * response schema has NO numeric-financial field at all — not even an
 * echoed one. There is nothing for GuardedAiModelProvider's
 * GROUND_TRUTH_CONTRADICTION check to ever catch here, because there is
 * structurally nothing in the response that could contradict a financial
 * fact. `economicsFacts`/`totalAcquisitionCost` are still passed as
 * `groundTruthFacts` purely so any £/% figure the model mentions in its
 * free-text `reason` (e.g. "priced well below the given £62 QSV") is
 * recognised as grounded rather than flagged as an UNGROUNDED_FIGURE.
 */
interface CandidateRouterVars {
  cardName: string;
  strategy: "FLIP" | "GRADE";
  state: string;
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
}

const INSTRUCTIONS = [
  "You are a fast triage classifier screening trading-card listings a deterministic pricing engine has ALREADY qualified as a promising FLIP or GRADE opportunity. Your only job is deciding whether this specific listing needs a HUMAN to look closer before anyone acts on it, or a clear enough red flag that it should not be shown as actionable at all.",
  "You are given exact numbers this app's own deterministic pricing engine already computed — treat every number in the input as ground truth. Never recompute, restate differently, or invent a price, comp, sale, or fact that was not given to you.",
  'Respond with exactly: "route" (one of PASS_THROUGH, REVIEW, BLOCK_FROM_ACTIONABLE), "confidence" (0 to 1, your own honest certainty), and "reason" (one or two plain-English sentences citing the SPECIFIC evidence — title text, description text, a seller-declared aspect, condition data — your route is based on; never a restated conclusion with no evidence).',
  "PASS_THROUGH is the default and should be your answer whenever nothing specific stands out — this candidate already cleared the deterministic economics bar, so thin or absent evidence is NOT itself a reason to flag it; only route away from PASS_THROUGH when you can cite an ACTUAL, SPECIFIC concern.",
  "REVIEW means something specific is worth a human's eyes before buying but isn't clear-cut — e.g. the description hints at damage the title didn't mention, the seller's own aspects suggest a different language/variant than assumed, or condition evidence is genuinely contradictory.",
  "BLOCK_FROM_ACTIONABLE is reserved for a CLEAR, SPECIFIC red flag that the listing is not what the deterministic engine assumed it was buying — e.g. the description explicitly says this is a lot/bundle of multiple cards being sold as if it were a single card, explicitly says the card is already graded/slabbed when treated as raw, or explicitly names a different card/set/variant than the one being priced. Do not use this for mere uncertainty, thin evidence, or a personal quality judgement — only for something you can point to directly.",
].join("\n\n");

function renderCandidateRouterInput(vars: CandidateRouterVars): string {
  const factLines = Object.entries(vars.economicsFacts)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  const reasoningLines = vars.reasoning.length > 0 ? vars.reasoning.map((r) => `- ${r}`).join("\n") : "(none recorded)";

  const evidenceLines: string[] = [];
  if (vars.itemCondition) evidenceLines.push(`eBay condition label: ${vars.itemCondition}`);
  if (vars.conditionDescription) evidenceLines.push(`eBay condition description (free text): ${vars.conditionDescription}`);
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
  if (evidenceLines.length === 0) evidenceLines.push("No enriched eBay evidence was available for this listing.");

  return [
    `Card: ${vars.cardName}`,
    `Strategy: ${vars.strategy}`,
    `Engine state: ${vars.state} (already qualified — you are deciding whether to route it for review, not whether it qualifies)`,
    `Listing title: ${vars.listingTitle}`,
    `Listing price: £${vars.listingPrice}`,
    `Total acquisition cost (already computed): £${vars.totalAcquisitionCost}`,
    `Already-computed economics:\n${factLines || "(none available for this strategy/state)"}`,
    `This app's own engine reasoning for this opportunity:\n${reasoningLines}`,
    `Enriched eBay evidence:\n${evidenceLines.join("\n")}`,
  ].join("\n\n");
}

export const CANDIDATE_ROUTER_TEMPLATE = definePromptTemplate<CandidateRouterVars>({
  id: "candidate_router",
  version: 1,
  description:
    "AI INTELLIGENCE gap 3 — a cheap FAST-tier triage classifier deciding whether an already-qualified candidate should pass through to the actionable feed unchanged, be routed for human review, or be blocked from the actionable feed pending review. Never touches financial numbers or qualification.",
  render: (vars) => ({
    instructions: INSTRUCTIONS,
    input: renderCandidateRouterInput(vars),
  }),
});

const ROUTES: readonly CandidateRoute[] = ["PASS_THROUGH", "REVIEW", "BLOCK_FROM_ACTIONABLE"];

const RESPONSE_SCHEMA = {
  name: "candidate_router",
  schema: {
    type: "object",
    properties: {
      route: {
        type: "string",
        enum: ROUTES as unknown as string[],
        description:
          "PASS_THROUGH (default — nothing specific stands out), REVIEW (a specific concern worth a human's eyes), or BLOCK_FROM_ACTIONABLE (a clear, specific red flag that this isn't what the engine assumed).",
      },
      confidence: { type: "number", description: "Your own honest certainty in this route, 0 to 1." },
      reason: {
        type: "string",
        description:
          "One or two sentences citing the SPECIFIC evidence this route is based on. State plainly when nothing specific stood out.",
      },
    },
    required: ["route", "confidence", "reason"],
    additionalProperties: false,
  },
} as const;

// Small, closed-vocabulary response — nowhere near AiListingAnalystProvider's
// 1400, since there are no free-form assessment objects here.
const MAX_OUTPUT_TOKENS = 300;

export class AiCandidateRouterProvider implements CandidateRouterProvider {
  readonly name = "candidate-router";

  constructor(private readonly modelProvider: AiModelProvider) {}

  async routeCandidate(request: CandidateRouteRequest): Promise<CandidateRouteResponse> {
    const economicsFacts = request.economicsFacts ?? {};
    const groundTruthFacts: Record<string, number> = {
      ...economicsFacts,
      totalAcquisitionCost: request.totalAcquisitionCost,
    };

    const completionRequest = buildAiRequest(
      CANDIDATE_ROUTER_TEMPLATE,
      {
        cardName: request.cardName,
        strategy: request.strategy,
        state: request.state,
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
      },
      {
        tier: "FAST",
        responseSchema: RESPONSE_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        groundTruthFacts,
      },
    );

    const result = await this.modelProvider.complete(completionRequest);

    if (!result.available) {
      return { available: false, route: null, confidence: null, reason: null, error: result.error };
    }

    const parsed = result.parsedJson as Record<string, unknown> | null;
    const rawRoute = parsed?.route;
    const route = typeof rawRoute === "string" && (ROUTES as string[]).includes(rawRoute) ? (rawRoute as CandidateRoute) : null;

    if (route === null) {
      // Schema conformance should already guarantee this, but this class
      // makes no assumption about what produced parsedJson — same
      // defensive discipline as AiListingAnalystProvider's readAssessment.
      // Degrades to unavailable, never guesses a route.
      return { available: false, route: null, confidence: null, reason: null, error: "AI router returned no usable route." };
    }

    const confidence = typeof parsed?.confidence === "number" ? parsed.confidence : null;
    const reason = typeof parsed?.reason === "string" ? parsed.reason : null;

    return { available: true, route, confidence, reason, error: null };
  }
}
