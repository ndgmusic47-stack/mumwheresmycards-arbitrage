import type { AiModelProvider } from "../ai/AiModelProvider.js";
import { definePromptTemplate, buildAiRequest } from "../ai/promptVersioning.js";
import type { ScenarioNarratorProvider, ScenarioNarrationRequest, ScenarioNarrationResponse } from "./ScenarioNarratorProvider.js";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream M: the AI Scenario Narrator —
 * the real `ScenarioNarratorProvider` implementation. Wraps a
 * fully-assembled provider chain (created by the caller — see
 * apps/worker/src/routes/scenario.ts — as `createAiModelProvider(env)` ->
 * `AiCompletionCache` (Workstream G) -> `GuardedAiModelProvider`
 * (Workstream I)), the exact same composition Workstream J's
 * `AiListingAnalystProvider` and Workstream L's `AiQueryInterpreterProvider`
 * use. DEEP tier: like the Listing Analyst, this is short free-form
 * reasoning over already-computed figures, not a classification/extraction
 * task (which is what FAST tier is for — see Workstream L).
 *
 * SAME CANARY DISCIPLINE AS WORKSTREAM J: the response schema asks the
 * model to echo back `statedKeyMetricBaseline`/`statedKeyMetricScenario` —
 * two numbers it was already given, not something new. This exists purely
 * so GuardedAiModelProvider's exact-match GROUND_TRUTH_CONTRADICTION check
 * has a genuine, reliable structured field to verify a response against —
 * a free-text narrative alone could restate a £340 delta as £3,400 without
 * ever tripping a currency-figure regex if it phrased things unusually. The
 * app doesn't need these echoed values for anything itself — they're a
 * canary, not a feature.
 *
 * WHY THE INSTRUCTIONS EXPLICITLY FORBID SPECULATING ABOUT *WHY* A
 * HYPOTHETICAL CHANGE MIGHT HAPPEN: a "what if the acquisition cost were
 * £20 lower" scenario is the human's own hypothesis, not a prediction this
 * app is making — the model's job is to describe the computed CONSEQUENCE
 * of that hypothesis (how the economics move), never to invent a reason a
 * seller might actually drop their price or a card might actually grade
 * lower. Inventing a cause would be exactly the kind of fabricated,
 * ungrounded claim GuardedAiModelProvider (Workstream I) and this app's
 * founding "AI never a source of financial numbers OR unearned certainty"
 * discipline exist to prevent.
 */
interface ScenarioNarratorVars {
  cardName: string;
  strategy: "FLIP" | "GRADE";
  changesDescription: string;
  keyMetricLabel: string;
  keyMetricBaseline: number;
  keyMetricScenario: number;
  economicsFacts: Record<string, number>;
}

const INSTRUCTIONS = [
  "You are a cautious trading-card sourcing analyst helping a human understand a hypothetical 'what if' scenario against an opportunity this app's own deterministic pricing engine already computed.",
  "Every number in the input — the baseline, the scenario, and every economics fact — was computed by that deterministic engine, not by you. Treat every given number as ground truth: never recompute, round differently, or restate any given figure with a different value. If you reference a given number, use it exactly as given.",
  "Never invent a price, comp, sale, or fact that was not given to you. Do not speculate about WHY the hypothetical change described might actually happen (e.g. a seller dropping their price, a card grading lower than hoped) — the human is asking 'what would this be worth if X', not 'will X happen'. Describe the financial CONSEQUENCE of the change already specified, never its cause or likelihood.",
  'Respond with the exact JSON shape described: "summary" (2-3 plain-English sentences comparing the baseline to the scenario — what changed and what it is worth), "caveats" (a short list of things worth double-checking before relying on this scenario; may be an empty array if there genuinely are none beyond the obvious), and "statedKeyMetricBaseline"/"statedKeyMetricScenario" (echo those two exact figures from the input, completely unchanged, as bare numbers).',
].join("\n\n");

function renderScenarioNarratorInput(vars: ScenarioNarratorVars): string {
  const factLines = Object.entries(vars.economicsFacts)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");

  return [
    `Card: ${vars.cardName}`,
    `Strategy: ${vars.strategy}`,
    `What changed: ${vars.changesDescription}`,
    `Headline metric: ${vars.keyMetricLabel}`,
    `Baseline ${vars.keyMetricLabel} (echo this exactly as statedKeyMetricBaseline): ${vars.keyMetricBaseline}`,
    `Scenario ${vars.keyMetricLabel} (echo this exactly as statedKeyMetricScenario): ${vars.keyMetricScenario}`,
    `Every other already-computed economics figure, baseline and scenario:\n${factLines || "(none beyond the headline metric)"}`,
  ].join("\n\n");
}

/**
 * Defined once, at module scope, per the promptVersioning.ts (Workstream H)
 * contract — every real prompt template goes through definePromptTemplate()
 * so a malformed id/version fails loudly at startup, never silently at the
 * first real call.
 */
export const SCENARIO_NARRATOR_TEMPLATE = definePromptTemplate<ScenarioNarratorVars>({
  id: "scenario_narrator",
  version: 1,
  description:
    "AI Scenario Narrator (Workstream M) — a short narrative comparison of a deterministic what-if scenario against its baseline, grounded against the scenario engine's own computed figures.",
  render: (vars) => ({
    instructions: INSTRUCTIONS,
    input: renderScenarioNarratorInput(vars),
  }),
});

const RESPONSE_SCHEMA = {
  name: "scenario_narrator",
  schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "2-3 sentence plain-English comparison of the baseline and scenario economics for a human evaluating this hypothetical.",
      },
      caveats: {
        type: "array",
        items: { type: "string" },
        description: "Specific things worth double-checking before relying on this scenario. May be an empty array.",
      },
      statedKeyMetricBaseline: {
        type: "number",
        description: "Echo the exact baseline headline-metric figure given in the input, unchanged — do not recalculate or round it.",
      },
      statedKeyMetricScenario: {
        type: "number",
        description: "Echo the exact scenario headline-metric figure given in the input, unchanged — do not recalculate or round it.",
      },
    },
    required: ["summary", "caveats", "statedKeyMetricBaseline", "statedKeyMetricScenario"],
    additionalProperties: false,
  },
} as const;

const MAX_OUTPUT_TOKENS = 400;

/** Always present in `caveats`, in addition to whatever the model reported
 *  itself and whatever the guardrail flagged — same "surface for a human to
 *  verify, never silently decide" discipline as every other AI/derived
 *  panel in this app. */
const STANDING_CAVEAT =
  "AI-generated scenario narration — this app's own deterministic scenario engine (not the model) computed every number above; verify against those figures before acting.";

export class AiScenarioNarratorProvider implements ScenarioNarratorProvider {
  readonly name = "scenario-narrator";

  constructor(private readonly modelProvider: AiModelProvider) {}

  async narrateScenario(request: ScenarioNarrationRequest): Promise<ScenarioNarrationResponse> {
    const economicsFacts = request.economicsFacts ?? {};
    // The canary fields (see file doc comment) are added here, not by the
    // caller — an implementation detail of how THIS provider grounds its
    // own responses, not real economics figures other callers of
    // ScenarioNarrationRequest should have to know about.
    const groundTruthFacts: Record<string, number> = {
      ...economicsFacts,
      statedKeyMetricBaseline: request.keyMetricBaseline,
      statedKeyMetricScenario: request.keyMetricScenario,
    };

    const completionRequest = buildAiRequest(
      SCENARIO_NARRATOR_TEMPLATE,
      {
        cardName: request.cardName,
        strategy: request.strategy,
        changesDescription: request.changesDescription,
        keyMetricLabel: request.keyMetricLabel,
        keyMetricBaseline: request.keyMetricBaseline,
        keyMetricScenario: request.keyMetricScenario,
        economicsFacts,
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
      // Same honest-caveat discipline as NullScenarioNarratorProvider —
      // never a fabricated summary, and the EXACT reason (no key, spend
      // cap, upstream error, or a guardrail rejection) is surfaced, not
      // paraphrased or swallowed.
      return {
        available: false,
        summary: null,
        caveats: [result.error ?? "AI scenario narration is currently unavailable."],
      };
    }

    const parsed = result.parsedJson as { summary?: unknown; caveats?: unknown } | null;
    const summary = typeof parsed?.summary === "string" ? parsed.summary : result.outputText;
    const modelCaveats = Array.isArray(parsed?.caveats)
      ? parsed.caveats.filter((c): c is string => typeof c === "string")
      : [];
    // UNGROUNDED_FIGURE flags (Workstream I) are non-blocking by design —
    // surfaced here as caveats rather than suppressed, same treatment as
    // every other AI panel in this app.
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
