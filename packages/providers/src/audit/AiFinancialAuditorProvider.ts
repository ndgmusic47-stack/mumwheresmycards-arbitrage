import type { VarianceSummary } from "@mwmc/core";
import type { AiModelProvider } from "../ai/AiModelProvider.js";
import { definePromptTemplate, buildAiRequest } from "../ai/promptVersioning.js";
import type { FinancialAuditorProvider, FinancialAuditRequest, FinancialAuditResponse } from "./FinancialAuditorProvider.js";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream N: the AI Financial Auditor —
 * the real `FinancialAuditorProvider` implementation, and the first
 * feature in this app to actually use the AUDIT tier (defined since
 * Workstream F, unused until now). Same chain composition every AI route
 * has used since Workstream J — `createAiModelProvider(env)` ->
 * `AiCompletionCache` (G) -> `GuardedAiModelProvider` (I) — built fresh per
 * request by the caller (see apps/worker/src/routes/reconciliation.ts).
 *
 * SAME CANARY DISCIPLINE AS WORKSTREAMS J AND M: the response schema asks
 * the model to echo back `statedSampleSize`/`statedMeanProfitVariance` —
 * two numbers it was already given, not something new — purely so
 * `GuardedAiModelProvider`'s exact-match `GROUND_TRUTH_CONTRADICTION` check
 * has a genuine, reliable structured field to verify a response against.
 *
 * WHY THE INSTRUCTIONS ALLOW (CAREFULLY BOUNDED) SPECULATION, UNLIKE
 * WORKSTREAM M'S SCENARIO NARRATOR: an auditor reviewing a pattern of
 * underperformance is naturally expected to suggest what might be worth
 * investigating ("fee estimates may be running optimistic") — that's the
 * actual job. The line this app still enforces is that any such suggestion
 * must be explicitly framed as a hypothesis to check, never asserted as the
 * proven cause, since the model was only ever given AGGREGATE statistics —
 * never the underlying trade records that would let anyone actually know
 * why. Same "surface for a human to verify, never silently decide"
 * discipline as every other AI/derived panel in this app, just applied to
 * causation instead of a computed figure.
 */
interface FinancialAuditorVars {
  sampleSize: number;
  overallSummary: VarianceSummary;
  flipSummary?: VarianceSummary;
  gradeSummary?: VarianceSummary;
}

const INSTRUCTIONS = [
  "You are a cautious financial auditor reviewing this app's own track record of forecast-vs-realised performance on completed (sold) trades.",
  "Every number in the input was computed by this app's own deterministic reconciliation engine, not by you — treat every given figure as ground truth. Never recompute, round differently, or restate a given figure with a different value. If you reference a given number, use it exactly as given.",
  "You are given AGGREGATE statistics only — sample size, mean/median profit variance, outperform rate, mean ROC and capital-lock variance — never individual trade records. Never claim to know about, or describe, any specific trade; you were not shown any.",
  "Identify the most notable pattern in the numbers — for example a strategy consistently running above or below forecast, a wide spread between mean and median suggesting a few outliers, or a genuinely small sample limiting how much confidence to place in any of it. You may suggest a plausible reason worth investigating, but always frame it explicitly as a hypothesis to check, never as a proven cause — you were not given the underlying trade data that would let anyone actually know why.",
  "If the overall sample size is small (under 10), say so explicitly and keep any conclusion correspondingly tentative rather than drawing a strong claim from a handful of trades.",
  'Respond with the exact JSON shape described: "summary" (2-4 plain-English sentences on the most notable pattern(s) in this performance data), "caveats" (a short list of specific things worth double-checking or investigating further; may be an empty array if there genuinely are none beyond the obvious), and "statedSampleSize"/"statedMeanProfitVariance" (echo those two exact figures from the overall summary in the input, completely unchanged, as bare numbers).',
].join("\n\n");

function summaryLines(label: string, summary: VarianceSummary | undefined): string {
  if (!summary || summary.sampleSize === 0) return `${label}: no realised trades with a forecast yet.`;
  const lines = [
    `${label} (n=${summary.sampleSize}):`,
    `- outperformed: ${summary.outperformedCount}, underperformed: ${summary.underperformedCount} (outperform rate ${summary.outperformedRate})`,
    `- mean profit variance: ${summary.meanProfitVariance}`,
    `- median profit variance: ${summary.medianProfitVariance}`,
  ];
  if (summary.meanRocVariance !== null) lines.push(`- mean ROC variance: ${summary.meanRocVariance}`);
  if (summary.meanCapitalLockVarianceDays !== null) lines.push(`- mean capital-lock variance (days): ${summary.meanCapitalLockVarianceDays}`);
  return lines.join("\n");
}

function renderFinancialAuditorInput(vars: FinancialAuditorVars): string {
  return [
    `Overall sample size (all strategies combined, echo this exactly as statedSampleSize): ${vars.sampleSize}`,
    `Overall mean profit variance (echo this exactly as statedMeanProfitVariance): ${vars.overallSummary.meanProfitVariance}`,
    summaryLines("Overall", vars.overallSummary),
    summaryLines("FLIP", vars.flipSummary),
    summaryLines("GRADE", vars.gradeSummary),
  ].join("\n\n");
}

/**
 * Defined once, at module scope, per the promptVersioning.ts (Workstream H)
 * contract — every real prompt template goes through definePromptTemplate()
 * so a malformed id/version fails loudly at startup, never silently at the
 * first real call.
 */
export const FINANCIAL_AUDITOR_TEMPLATE = definePromptTemplate<FinancialAuditorVars>({
  id: "financial_auditor",
  version: 1,
  description:
    "AI Financial Auditor (Workstream N) — narrates systemic forecast-vs-realised patterns across this app's own completed trades, from pre-aggregated variance statistics only.",
  render: (vars) => ({
    instructions: INSTRUCTIONS,
    input: renderFinancialAuditorInput(vars),
  }),
});

const RESPONSE_SCHEMA = {
  name: "financial_auditor",
  schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "2-4 sentence plain-English analysis of the most notable pattern(s) in this forecast-vs-realised performance data.",
      },
      caveats: {
        type: "array",
        items: { type: "string" },
        description: "Specific things worth double-checking or investigating further. May be an empty array.",
      },
      statedSampleSize: {
        type: "number",
        description: "Echo the exact overall sample size given in the input, unchanged.",
      },
      statedMeanProfitVariance: {
        type: "number",
        description: "Echo the exact overall mean profit variance given in the input, unchanged — do not recalculate or round it.",
      },
    },
    required: ["summary", "caveats", "statedSampleSize", "statedMeanProfitVariance"],
    additionalProperties: false,
  },
} as const;

const MAX_OUTPUT_TOKENS = 500;

/** Always present in `caveats`, in addition to whatever the model reported
 *  itself and whatever the guardrail flagged — same "surface for a human to
 *  verify, never silently decide" discipline as every other AI/derived
 *  panel in this app. */
const STANDING_CAVEAT =
  "AI-generated audit narration over aggregate statistics only — this app's own deterministic reconciliation engine (not the model) computed every number above, and the model was never shown individual trades; verify against the underlying records before acting.";

export class AiFinancialAuditorProvider implements FinancialAuditorProvider {
  readonly name = "financial-auditor";

  constructor(private readonly modelProvider: AiModelProvider) {}

  async auditPerformance(request: FinancialAuditRequest): Promise<FinancialAuditResponse> {
    // The canary fields (see file doc comment) are added here, not by the
    // caller — an implementation detail of how THIS provider grounds its
    // own responses.
    const groundTruthFacts: Record<string, number> = {
      statedSampleSize: request.sampleSize,
    };
    if (request.overallSummary.meanProfitVariance !== null) {
      groundTruthFacts.statedMeanProfitVariance = request.overallSummary.meanProfitVariance;
    }

    const completionRequest = buildAiRequest(
      FINANCIAL_AUDITOR_TEMPLATE,
      {
        sampleSize: request.sampleSize,
        overallSummary: request.overallSummary,
        flipSummary: request.flipSummary,
        gradeSummary: request.gradeSummary,
      },
      {
        tier: "AUDIT",
        responseSchema: RESPONSE_SCHEMA,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        groundTruthFacts,
      },
    );

    const result = await this.modelProvider.complete(completionRequest);

    if (!result.available) {
      // Same honest-caveat discipline as NullFinancialAuditorProvider —
      // never a fabricated summary, and the EXACT reason (no key, spend
      // cap, upstream error, or a guardrail rejection) is surfaced, not
      // paraphrased or swallowed.
      return {
        available: false,
        summary: null,
        caveats: [result.error ?? "AI financial audit is currently unavailable."],
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
