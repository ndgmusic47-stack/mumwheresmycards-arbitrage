import { describe, it, expect } from "vitest";
import { AiScenarioNarratorProvider, SCENARIO_NARRATOR_TEMPLATE } from "../src/scenario/AiScenarioNarratorProvider.js";
import { NullScenarioNarratorProvider } from "../src/scenario/ScenarioNarratorProvider.js";
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from "../src/ai/AiModelProvider.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream M
 * (scenario/what-if engine) — the AI narration layer specifically. The
 * deterministic scenarioEngine.ts arithmetic is covered exhaustively in
 * packages/core/test/scenarioEngine.test.ts; this file pins down: the
 * request built for the underlying AiModelProvider is correctly assembled
 * (DEEP tier, schema, promptVersionId, the canary ground-truth fields), an
 * unavailable/rejected inner result degrades to the exact same
 * honest-caveat shape every other AI feature in this app uses, and a
 * successful result correctly surfaces the model's summary/caveats plus the
 * standing verify-the-numbers caveat and any non-blocking guardrail flags.
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

function availableResult(overrides: Partial<AiCompletionResult> = {}): AiCompletionResult {
  const parsed = {
    summary: "Dropping the acquisition cost by £20 lifts net profit from £30.00 to £50.00, a meaningfully higher return on the same capital.",
    caveats: ["Confirm the lower acquisition cost is actually achievable before relying on this."],
    statedKeyMetricBaseline: 30,
    statedKeyMetricScenario: 50,
    ...overrides.parsedJson,
  };
  return {
    available: true,
    outputText: JSON.stringify(parsed),
    parsedJson: parsed,
    modelId: "gpt-5.6-luna",
    usage: { inputTokens: 90, outputTokens: 40, totalTokens: 130 },
    error: null,
    hallucinationFlags: [],
    ...overrides,
  };
}

describe("NullScenarioNarratorProvider", () => {
  it("always reports unavailable with an explanatory caveat, never a fabricated summary", async () => {
    const provider = new NullScenarioNarratorProvider();

    const result = await provider.narrateScenario({
      cardName: "Charizard VMAX",
      strategy: "FLIP",
      changesDescription: "Total acquisition cost: £100.00 -> £80.00",
      keyMetricLabel: "net profit",
      keyMetricBaseline: 30,
      keyMetricScenario: 50,
    });

    expect(provider.name).toBe("none");
    expect(result).toEqual({
      available: false,
      summary: null,
      caveats: ["Scenario narration is not connected in this build."],
    });
  });
});

describe("AiScenarioNarratorProvider", () => {
  it("exposes a stable provider name", () => {
    const { provider } = capturingProvider(availableResult());
    const narrator = new AiScenarioNarratorProvider(provider);
    expect(narrator.name).toBe("scenario-narrator");
  });

  it("builds a DEEP-tier, schema-constrained request stamped with the template's promptVersionId", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const narrator = new AiScenarioNarratorProvider(provider);

    await narrator.narrateScenario({
      cardName: "Charizard VMAX",
      strategy: "FLIP",
      changesDescription: "Total acquisition cost: £100.00 -> £80.00",
      keyMetricLabel: "net profit",
      keyMetricBaseline: 30,
      keyMetricScenario: 50,
    });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.tier).toBe("DEEP");
    expect(req.responseSchema?.name).toBe("scenario_narrator");
    expect(req.promptVersionId).toBe(`scenario_narrator@v${SCENARIO_NARRATOR_TEMPLATE.version}`);
  });

  it("includes the card, the changes description, and the headline metric figures in the built input", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const narrator = new AiScenarioNarratorProvider(provider);

    await narrator.narrateScenario({
      cardName: "Charizard VMAX",
      strategy: "FLIP",
      changesDescription: "Total acquisition cost: £100.00 -> £80.00",
      keyMetricLabel: "net profit",
      keyMetricBaseline: 30,
      keyMetricScenario: 50,
    });

    const input = captured[0]!.input;
    expect(input).toContain("Charizard VMAX");
    expect(input).toContain("Total acquisition cost: £100.00 -> £80.00");
    expect(input).toContain("Baseline net profit");
    expect(input).toContain("30");
    expect(input).toContain("Scenario net profit");
    expect(input).toContain("50");
  });

  it("stamps groundTruthFacts with the canary echo fields plus every passed economicsFact, for GuardedAiModelProvider to check against", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const narrator = new AiScenarioNarratorProvider(provider);

    await narrator.narrateScenario({
      cardName: "Charizard VMAX",
      strategy: "GRADE",
      changesDescription: "PSA9 slab value: £600.00 -> £700.00",
      keyMetricLabel: "PSA10 profit",
      keyMetricBaseline: 900,
      keyMetricScenario: 900,
      economicsFacts: { baselinePsa9Profit: 200, scenarioPsa9Profit: 280 },
    });

    expect(captured[0]!.groundTruthFacts).toEqual({
      baselinePsa9Profit: 200,
      scenarioPsa9Profit: 280,
      statedKeyMetricBaseline: 900,
      statedKeyMetricScenario: 900,
    });
  });

  it("defaults economicsFacts to an empty object and still stamps the canary fields when the caller passes none", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const narrator = new AiScenarioNarratorProvider(provider);

    await narrator.narrateScenario({
      cardName: "Pikachu Illustrator",
      strategy: "FLIP",
      changesDescription: "QSV: £150.00 -> £200.00",
      keyMetricLabel: "net profit",
      keyMetricBaseline: 30,
      keyMetricScenario: 65,
    });

    expect(captured[0]!.groundTruthFacts).toEqual({ statedKeyMetricBaseline: 30, statedKeyMetricScenario: 65 });
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
    const narrator = new AiScenarioNarratorProvider(provider);

    const result = await narrator.narrateScenario({
      cardName: "Charizard VMAX",
      strategy: "FLIP",
      changesDescription: "Total acquisition cost: £100.00 -> £80.00",
      keyMetricLabel: "net profit",
      keyMetricBaseline: 30,
      keyMetricScenario: 50,
    });

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
    const narrator = new AiScenarioNarratorProvider(provider);

    const result = await narrator.narrateScenario({
      cardName: "Charizard VMAX",
      strategy: "FLIP",
      changesDescription: "Total acquisition cost: £100.00 -> £80.00",
      keyMetricLabel: "net profit",
      keyMetricBaseline: 30,
      keyMetricScenario: 50,
    });

    expect(result.caveats).toEqual(["AI scenario narration is currently unavailable."]);
  });

  it("on success: returns the model's summary, its own caveats, and always appends the standing verify-the-numbers caveat", async () => {
    const { provider } = capturingProvider(availableResult());
    const narrator = new AiScenarioNarratorProvider(provider);

    const result = await narrator.narrateScenario({
      cardName: "Charizard VMAX",
      strategy: "FLIP",
      changesDescription: "Total acquisition cost: £100.00 -> £80.00",
      keyMetricLabel: "net profit",
      keyMetricBaseline: 30,
      keyMetricScenario: 50,
    });

    expect(result.available).toBe(true);
    expect(result.summary).toBe(
      "Dropping the acquisition cost by £20 lifts net profit from £30.00 to £50.00, a meaningfully higher return on the same capital.",
    );
    expect(result.caveats).toEqual([
      "Confirm the lower acquisition cost is actually achievable before relying on this.",
      "AI-generated scenario narration — this app's own deterministic scenario engine (not the model) computed every number above; verify against those figures before acting.",
    ]);
  });

  it("falls back to result.outputText when parsedJson.summary is missing or malformed", async () => {
    const { provider } = capturingProvider(
      availableResult({
        outputText: "fallback narrative text",
        parsedJson: { caveats: [], statedKeyMetricBaseline: 30, statedKeyMetricScenario: 50 },
      }),
    );
    const narrator = new AiScenarioNarratorProvider(provider);

    const result = await narrator.narrateScenario({
      cardName: "Charizard VMAX",
      strategy: "FLIP",
      changesDescription: "Total acquisition cost: £100.00 -> £80.00",
      keyMetricLabel: "net profit",
      keyMetricBaseline: 30,
      keyMetricScenario: 50,
    });

    expect(result.summary).toBe("fallback narrative text");
  });

  it("surfaces UNGROUNDED_FIGURE guardrail flags as non-blocking caveats, alongside the model's own", async () => {
    const { provider } = capturingProvider(
      availableResult({
        hallucinationFlags: [
          { kind: "UNGROUNDED_FIGURE", detail: "Mentioned a £1,200 comp sale not present in any given figure." },
          { kind: "UNGROUNDED_FIGURE", detail: "Referenced a grading turnaround estimate not provided." },
        ],
      }),
    );
    const narrator = new AiScenarioNarratorProvider(provider);

    const result = await narrator.narrateScenario({
      cardName: "Charizard VMAX",
      strategy: "FLIP",
      changesDescription: "Total acquisition cost: £100.00 -> £80.00",
      keyMetricLabel: "net profit",
      keyMetricBaseline: 30,
      keyMetricScenario: 50,
    });

    expect(result.caveats).toEqual([
      "Confirm the lower acquisition cost is actually achievable before relying on this.",
      "Mentioned a £1,200 comp sale not present in any given figure.",
      "Referenced a grading turnaround estimate not provided.",
      "AI-generated scenario narration — this app's own deterministic scenario engine (not the model) computed every number above; verify against those figures before acting.",
    ]);
  });

  it("never surfaces a GROUND_TRUTH_CONTRADICTION flag as a mere caveat — only UNGROUNDED_FIGURE is non-blocking here", async () => {
    const { provider } = capturingProvider(
      availableResult({
        hallucinationFlags: [{ kind: "GROUND_TRUTH_CONTRADICTION", detail: "This should already have been hard-blocked upstream." }],
      }),
    );
    const narrator = new AiScenarioNarratorProvider(provider);

    const result = await narrator.narrateScenario({
      cardName: "Charizard VMAX",
      strategy: "FLIP",
      changesDescription: "Total acquisition cost: £100.00 -> £80.00",
      keyMetricLabel: "net profit",
      keyMetricBaseline: 30,
      keyMetricScenario: 50,
    });

    expect(result.caveats).not.toContain("This should already have been hard-blocked upstream.");
  });
});
