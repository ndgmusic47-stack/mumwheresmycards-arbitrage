import { describe, it, expect } from "vitest";
import type { VarianceSummary } from "@mwmc/core";
import { AiFinancialAuditorProvider, FINANCIAL_AUDITOR_TEMPLATE } from "../src/audit/AiFinancialAuditorProvider.js";
import { NullFinancialAuditorProvider } from "../src/audit/FinancialAuditorProvider.js";
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from "../src/ai/AiModelProvider.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream N (AI
 * financial auditor + realised-vs-predicted reconciliation) — the AI
 * narration layer specifically. The deterministic
 * `summarizeForecastVariance` arithmetic is covered exhaustively in
 * packages/core/test/varianceSummary.test.ts; this file pins down: the
 * request built for the underlying AiModelProvider is correctly assembled
 * (AUDIT tier — this app's first real use of it — schema, promptVersionId,
 * the canary ground-truth fields), an unavailable/rejected inner result
 * degrades to the exact same honest-caveat shape every other AI feature in
 * this app uses, and a successful result correctly surfaces the model's
 * summary/caveats plus the standing verify-the-numbers caveat.
 */
function capturingProvider(result: AiCompletionResult): { provider: AiModelProvider; captured: AiCompletionRequest[] } {
  const captured: AiCompletionRequest[] = [];
  return {
    provider: {
      name: "captured",
      complete: async (request) => {
        captured.push(request);
        return result;
      },
    },
    captured,
  };
}

function summary(overrides: Partial<VarianceSummary> = {}): VarianceSummary {
  return {
    sampleSize: 14,
    outperformedCount: 5,
    underperformedCount: 9,
    outperformedRate: 0.3571,
    meanProfitVariance: -8.4,
    medianProfitVariance: -6,
    meanRocVariance: -0.03,
    meanCapitalLockVarianceDays: 4,
    ...overrides,
  };
}

function availableResult(overrides: Partial<AiCompletionResult> = {}): AiCompletionResult {
  const parsed = {
    summary: "GRADE trades have consistently underperformed their forecast profit across the sample, averaging £8.40 below forecast.",
    caveats: ["Worth checking whether grading turnaround estimates are running optimistic."],
    statedSampleSize: 14,
    statedMeanProfitVariance: -8.4,
    ...overrides.parsedJson,
  };
  return {
    available: true,
    outputText: JSON.stringify(parsed),
    parsedJson: parsed,
    modelId: "gpt-5.6-sol",
    usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 },
    error: null,
    hallucinationFlags: [],
    ...overrides,
  };
}

describe("NullFinancialAuditorProvider", () => {
  it("always reports unavailable with an explanatory caveat, never a fabricated summary", async () => {
    const provider = new NullFinancialAuditorProvider();

    const result = await provider.auditPerformance({ sampleSize: 14, overallSummary: summary() });

    expect(provider.name).toBe("none");
    expect(result).toEqual({
      available: false,
      summary: null,
      caveats: ["Financial audit narration is not connected in this build."],
    });
  });
});

describe("AiFinancialAuditorProvider", () => {
  it("exposes a stable provider name", () => {
    const { provider } = capturingProvider(availableResult());
    const auditor = new AiFinancialAuditorProvider(provider);
    expect(auditor.name).toBe("financial-auditor");
  });

  it("builds an AUDIT-tier, schema-constrained request stamped with the template's promptVersionId", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const auditor = new AiFinancialAuditorProvider(provider);

    await auditor.auditPerformance({ sampleSize: 14, overallSummary: summary() });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.tier).toBe("AUDIT");
    expect(req.responseSchema?.name).toBe("financial_auditor");
    expect(req.promptVersionId).toBe(`financial_auditor@v${FINANCIAL_AUDITOR_TEMPLATE.version}`);
  });

  it("includes the overall sample size and per-strategy breakdowns in the built input", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const auditor = new AiFinancialAuditorProvider(provider);

    await auditor.auditPerformance({
      sampleSize: 14,
      overallSummary: summary(),
      flipSummary: summary({ sampleSize: 6, meanProfitVariance: 3 }),
      gradeSummary: summary({ sampleSize: 8, meanProfitVariance: -15 }),
    });

    const input = captured[0]!.input;
    expect(input).toContain("Overall sample size");
    expect(input).toContain("14");
    expect(input).toContain("FLIP (n=6)");
    expect(input).toContain("GRADE (n=8)");
  });

  it("reports 'no realised trades with a forecast yet' for an omitted per-strategy summary, never a fabricated one", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const auditor = new AiFinancialAuditorProvider(provider);

    await auditor.auditPerformance({ sampleSize: 14, overallSummary: summary() });

    const input = captured[0]!.input;
    expect(input).toContain("FLIP: no realised trades with a forecast yet.");
    expect(input).toContain("GRADE: no realised trades with a forecast yet.");
  });

  it("stamps groundTruthFacts with the canary echo fields", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const auditor = new AiFinancialAuditorProvider(provider);

    await auditor.auditPerformance({ sampleSize: 14, overallSummary: summary({ meanProfitVariance: -8.4 }) });

    expect(captured[0]!.groundTruthFacts).toEqual({ statedSampleSize: 14, statedMeanProfitVariance: -8.4 });
  });

  it("omits the statedMeanProfitVariance canary when the overall summary has none (never a fabricated 0)", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const auditor = new AiFinancialAuditorProvider(provider);

    await auditor.auditPerformance({ sampleSize: 0, overallSummary: summary({ sampleSize: 0, meanProfitVariance: null }) });

    expect(captured[0]!.groundTruthFacts).toEqual({ statedSampleSize: 0 });
  });

  it("degrades to an honest unavailable response, with the exact upstream/guardrail error as the caveat", async () => {
    const { provider } = capturingProvider({
      available: false,
      outputText: null,
      parsedJson: null,
      modelId: null,
      usage: null,
      error: "AI daily spend cap reached: $5.00 already spent today...",
    });
    const auditor = new AiFinancialAuditorProvider(provider);

    const result = await auditor.auditPerformance({ sampleSize: 14, overallSummary: summary() });

    expect(result.available).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.caveats).toEqual(["AI daily spend cap reached: $5.00 already spent today..."]);
  });

  it("never fabricates a caveat when an unavailable result carries no error string", async () => {
    const { provider } = capturingProvider({
      available: false,
      outputText: null,
      parsedJson: null,
      modelId: null,
      usage: null,
      error: null,
    });
    const auditor = new AiFinancialAuditorProvider(provider);

    const result = await auditor.auditPerformance({ sampleSize: 14, overallSummary: summary() });

    expect(result.caveats).toEqual(["AI financial audit is currently unavailable."]);
  });

  it("on success: returns the model's summary, its own caveats, and always appends the standing verify-the-numbers caveat", async () => {
    const { provider } = capturingProvider(availableResult());
    const auditor = new AiFinancialAuditorProvider(provider);

    const result = await auditor.auditPerformance({ sampleSize: 14, overallSummary: summary() });

    expect(result.available).toBe(true);
    expect(result.summary).toBe(
      "GRADE trades have consistently underperformed their forecast profit across the sample, averaging £8.40 below forecast.",
    );
    expect(result.caveats).toEqual([
      "Worth checking whether grading turnaround estimates are running optimistic.",
      "AI-generated audit narration over aggregate statistics only — this app's own deterministic reconciliation engine (not the model) computed every number above, and the model was never shown individual trades; verify against the underlying records before acting.",
    ]);
  });

  it("falls back to result.outputText when parsedJson.summary is missing or malformed", async () => {
    const { provider } = capturingProvider(
      availableResult({
        outputText: "fallback narrative text",
        parsedJson: { caveats: [], statedSampleSize: 14, statedMeanProfitVariance: -8.4 },
      }),
    );
    const auditor = new AiFinancialAuditorProvider(provider);

    const result = await auditor.auditPerformance({ sampleSize: 14, overallSummary: summary() });

    expect(result.summary).toBe("fallback narrative text");
  });

  it("surfaces UNGROUNDED_FIGURE guardrail flags as non-blocking caveats, alongside the model's own", async () => {
    const { provider } = capturingProvider(
      availableResult({
        hallucinationFlags: [{ kind: "UNGROUNDED_FIGURE", detail: "Mentioned a specific trade's £340 variance not present in any given figure." }],
      }),
    );
    const auditor = new AiFinancialAuditorProvider(provider);

    const result = await auditor.auditPerformance({ sampleSize: 14, overallSummary: summary() });

    expect(result.caveats).toEqual([
      "Worth checking whether grading turnaround estimates are running optimistic.",
      "Mentioned a specific trade's £340 variance not present in any given figure.",
      "AI-generated audit narration over aggregate statistics only — this app's own deterministic reconciliation engine (not the model) computed every number above, and the model was never shown individual trades; verify against the underlying records before acting.",
    ]);
  });

  it("never surfaces a GROUND_TRUTH_CONTRADICTION flag as a mere caveat — only UNGROUNDED_FIGURE is non-blocking here", async () => {
    const { provider } = capturingProvider(
      availableResult({
        hallucinationFlags: [{ kind: "GROUND_TRUTH_CONTRADICTION", detail: "This should already have been hard-blocked upstream." }],
      }),
    );
    const auditor = new AiFinancialAuditorProvider(provider);

    const result = await auditor.auditPerformance({ sampleSize: 14, overallSummary: summary() });

    expect(result.caveats).not.toContain("This should already have been hard-blocked upstream.");
  });
});
