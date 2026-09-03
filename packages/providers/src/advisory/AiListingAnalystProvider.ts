import type { AiModelProvider } from "../ai/AiModelProvider.js";
import { definePromptTemplate, buildAiRequest } from "../ai/promptVersioning.js";
import type { AiAdvisoryProvider, AiAdvisoryRequest, AiAdvisoryResponse } from "./AiAdvisoryProvider.js";

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
 */
interface ListingAnalystVars {
  cardName: string;
  strategy: "FLIP" | "GRADE";
  listingTitle: string;
  listingPrice: number;
  totalAcquisitionCost: number;
  economicsFacts: Record<string, number>;
  reasoning: string[];
}

const INSTRUCTIONS = [
  "You are a cautious trading-card sourcing analyst helping a human decide whether to buy a listed card for arbitrage (FLIP resale) or grading (GRADE resale).",
  "You are given exact numbers this app's own deterministic pricing engine already computed — treat every number in the input as ground truth. Never recompute, round differently, or restate any given figure with a different value; if you reference a given number, use it exactly as given.",
  "Never invent a price, comp, sale, or fact that was not given to you. If you are uncertain about something, say so plainly rather than guessing.",
  'Respond with the exact JSON shape described: "summary" (2-4 plain-English sentences on this specific opportunity — what stands out, what to verify before buying), "caveats" (a short list of specific risks or things worth double-checking; may be an empty array if there genuinely are none beyond the obvious), and "statedTotalAcquisitionCost" (echo the total acquisition cost figure from the input, completely unchanged, as a bare number).',
].join("\n\n");

function renderListingAnalystInput(vars: ListingAnalystVars): string {
  const factLines = Object.entries(vars.economicsFacts)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
  const reasoningLines = vars.reasoning.length > 0 ? vars.reasoning.map((r) => `- ${r}`).join("\n") : "(none recorded)";

  return [
    `Card: ${vars.cardName}`,
    `Strategy: ${vars.strategy}`,
    `Listing title: ${vars.listingTitle}`,
    `Listing price: £${vars.listingPrice}`,
    `Total acquisition cost (price + postage + fees, already computed — this is the figure to echo back exactly as statedTotalAcquisitionCost): £${vars.totalAcquisitionCost}`,
    `Already-computed economics:\n${factLines || "(none available for this strategy/state)"}`,
    `This app's own engine reasoning for this opportunity:\n${reasoningLines}`,
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
  version: 1,
  description:
    "AI Listing Analyst (Workstream J) — a short narrative risk/opportunity summary for a single opportunity, grounded against this app's own already-computed economics.",
  render: (vars) => ({
    instructions: INSTRUCTIONS,
    input: renderListingAnalystInput(vars),
  }),
});

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
    },
    required: ["summary", "caveats", "statedTotalAcquisitionCost"],
    additionalProperties: false,
  },
} as const;

const MAX_OUTPUT_TOKENS = 500;

/** Always present in `caveats`, in addition to whatever the model reported
 *  itself and whatever the guardrail flagged — same "surface for a human
 *  to verify, never silently decide" discipline as every other AI/derived
 *  panel in this app (the condition-truth and "why is this cheap?"
 *  panels). */
const STANDING_CAVEAT =
  "AI-generated analysis — this app's own deterministic pricing (not the model) is what qualified this opportunity; verify against those numbers before acting.";

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
      },
      {
        tier: "DEEP",
        responseSchema: RESPONSE_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        groundTruthFacts,
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

    const parsed = result.parsedJson as { summary?: unknown; caveats?: unknown } | null;
    const summary = typeof parsed?.summary === "string" ? parsed.summary : result.outputText;
    const modelCaveats = Array.isArray(parsed?.caveats)
      ? parsed.caveats.filter((c): c is string => typeof c === "string")
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
    };
  }
}
