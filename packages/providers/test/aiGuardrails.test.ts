import { describe, it, expect } from "vitest";
import {
  GuardedAiModelProvider,
  extractFiguresFromText,
  checkGroundTruthContradictions,
  checkUngroundedFigures,
} from "../src/ai/AiGuardrails.js";
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from "../src/ai/AiModelProvider.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream I
 * (hallucination protections / guardrails). Pins down the two contracts
 * from AiGuardrails.ts's own doc comment: a GROUND_TRUTH_CONTRADICTION
 * (the model restates a given fact wrong) always forces `available: false`
 * and never leaks outputText/parsedJson; an UNGROUNDED_FIGURE (a novel
 * currency/percent figure with no basis in the supplied context) is always
 * a non-blocking caveat, never a rejection.
 */
function fakeProvider(result: AiCompletionResult): AiModelProvider {
  return { name: "fake", complete: async () => result };
}

function baseResult(overrides: Partial<AiCompletionResult> = {}): AiCompletionResult {
  return {
    available: true,
    outputText: "ok",
    parsedJson: null,
    modelId: "gpt-5.6-terra",
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    error: null,
    ...overrides,
  };
}

const baseRequest: AiCompletionRequest = {
  tier: "DEEP",
  instructions: "You are a listing analyst. Net profit is £45.20 and QSV is £62.00.",
  input: "Charizard #146/144 raw NM listing at £38.",
};

describe("extractFiguresFromText", () => {
  it("extracts £ and $ currency figures", () => {
    const figures = extractFiguresFromText("This costs £45.20 and that one is $12.");
    expect(figures).toEqual([
      { raw: "£45.20", value: 45.2, kind: "CURRENCY" },
      { raw: "$12", value: 12, kind: "CURRENCY" },
    ]);
  });

  it("extracts percent figures", () => {
    const figures = extractFiguresFromText("That's roughly 23.5% below QSV.");
    expect(figures).toEqual([{ raw: "23.5%", value: 23.5, kind: "PERCENT" }]);
  });

  it("never matches bare numbers — card numbers, PSA grades, set years", () => {
    const figures = extractFiguresFromText("Card 146/144, graded PSA 9, from the 2022 set.");
    expect(figures).toEqual([]);
  });
});

describe("checkGroundTruthContradictions", () => {
  it("returns no flags when groundTruthFacts is undefined", () => {
    expect(checkGroundTruthContradictions({ netProfit: 999 }, undefined)).toEqual([]);
  });

  it("returns no flags when parsedJson is null", () => {
    expect(checkGroundTruthContradictions(null, { netProfit: 45.2 })).toEqual([]);
  });

  it("returns no flags when the claimed value matches within tolerance", () => {
    expect(checkGroundTruthContradictions({ netProfit: 45.2 }, { netProfit: 45.2 })).toEqual([]);
    // Within the 0.5%/1-cent tolerance — legitimate rounding noise.
    expect(checkGroundTruthContradictions({ netProfit: 45.205 }, { netProfit: 45.2 })).toEqual([]);
  });

  it("flags a genuinely different value as a contradiction", () => {
    const flags = checkGroundTruthContradictions({ netProfit: 200 }, { netProfit: 45.2 });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.kind).toBe("GROUND_TRUTH_CONTRADICTION");
    expect(flags[0]!.detail).toContain("netProfit");
    expect(flags[0]!.detail).toContain("200");
    expect(flags[0]!.detail).toContain("45.2");
  });

  it("skips a ground-truth key the model's schema never echoed back — no contradiction", () => {
    expect(checkGroundTruthContradictions({ summary: "looks good" }, { netProfit: 45.2 })).toEqual([]);
  });

  it("skips (never crashes on) a non-numeric value under a matching key", () => {
    expect(checkGroundTruthContradictions({ netProfit: "high" }, { netProfit: 45.2 })).toEqual([]);
  });

  it("checks every ground-truth key independently, in one pass", () => {
    const flags = checkGroundTruthContradictions({ netProfit: 45.2, qsv: 999 }, { netProfit: 45.2, qsv: 62 });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail).toContain("qsv");
  });
});

describe("checkUngroundedFigures", () => {
  it("returns no flags for null outputText", () => {
    expect(checkUngroundedFigures(null, baseRequest)).toEqual([]);
  });

  it("does not flag a figure that appears verbatim in the instructions or input", () => {
    const flags = checkUngroundedFigures("Net profit here is £45.20 on a £38 listing.", baseRequest);
    expect(flags).toEqual([]);
  });

  it("does not flag a currency figure that numerically matches a ground-truth fact, even reformatted", () => {
    const flags = checkUngroundedFigures("Expected profit: £45.2", {
      ...baseRequest,
      groundTruthFacts: { netProfit: 45.2 },
    });
    expect(flags).toEqual([]);
  });

  it("flags a currency figure with no basis anywhere in context or ground truth", () => {
    const flags = checkUngroundedFigures("This card is worth about £500 easily.", baseRequest);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.kind).toBe("UNGROUNDED_FIGURE");
    expect(flags[0]!.detail).toContain("£500");
  });

  it("flags a derived percentage not present verbatim in context — non-blocking caveat, not proof of error", () => {
    const flags = checkUngroundedFigures("That's about 34% under QSV.", baseRequest);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.kind).toBe("UNGROUNDED_FIGURE");
  });

  it("flags every distinct ungrounded figure, not just the first", () => {
    const flags = checkUngroundedFigures("Worth £500, or maybe £750 graded.", baseRequest);
    expect(flags).toHaveLength(2);
  });
});

describe("GuardedAiModelProvider", () => {
  it("names itself guarded(<inner name>)", () => {
    const guarded = new GuardedAiModelProvider(fakeProvider(baseResult()));
    expect(guarded.name).toBe("guarded(fake)");
  });

  it("passes an already-unavailable inner result through unchanged, adding an empty flags array", async () => {
    const inner = fakeProvider({
      available: false,
      outputText: null,
      parsedJson: null,
      modelId: null,
      usage: null,
      error: "no API key configured",
    });
    const guarded = new GuardedAiModelProvider(inner);

    const result = await guarded.complete(baseRequest);

    expect(result.available).toBe(false);
    expect(result.error).toBe("no API key configured");
    expect(result.hallucinationFlags).toEqual([]);
  });

  it("returns available:true with an empty flags array when nothing is suspicious", async () => {
    const inner = fakeProvider(baseResult({ outputText: "This listing looks like a genuine raw NM Charizard at £38." }));
    const guarded = new GuardedAiModelProvider(inner);

    const result = await guarded.complete(baseRequest);

    expect(result.available).toBe(true);
    expect(result.hallucinationFlags).toEqual([]);
  });

  it("stays available:true but flags an ungrounded figure as a non-blocking caveat", async () => {
    const inner = fakeProvider(baseResult({ outputText: "Graded, this could fetch £500." }));
    const guarded = new GuardedAiModelProvider(inner);

    const result = await guarded.complete(baseRequest);

    expect(result.available).toBe(true);
    expect(result.outputText).toBe("Graded, this could fetch £500.");
    expect(result.hallucinationFlags).toHaveLength(1);
    expect(result.hallucinationFlags![0]!.kind).toBe("UNGROUNDED_FIGURE");
  });

  it("forces available:false and nulls outputText/parsedJson on a ground-truth contradiction", async () => {
    const inner = fakeProvider(
      baseResult({
        outputText: "Net profit is £200 on this one.",
        parsedJson: { netProfit: 200, summary: "great flip" },
      }),
    );
    const guarded = new GuardedAiModelProvider(inner);

    const result = await guarded.complete({
      ...baseRequest,
      responseSchema: { name: "analysis", schema: { type: "object" } },
      groundTruthFacts: { netProfit: 45.2 },
    });

    expect(result.available).toBe(false);
    expect(result.outputText).toBeNull();
    expect(result.parsedJson).toBeNull();
    expect(result.error).toContain("netProfit");
    expect(result.error).toContain("45.2");
    expect(result.hallucinationFlags!.some((f) => f.kind === "GROUND_TRUTH_CONTRADICTION")).toBe(true);
    // Real token usage/modelId are preserved even on rejection — the call
    // genuinely happened and was genuinely billed; only the untrustworthy
    // content is withheld.
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(result.modelId).toBe("gpt-5.6-terra");
  });

  it("re-validates a cache-hit-shaped result against the CURRENT request's ground truth every time — a wrong answer never earns lasting trust just because it matched before", async () => {
    // Simulates the exact same underlying model output being served twice
    // (e.g. once fresh, once from AiCompletionCache) against two requests
    // whose groundTruthFacts genuinely differ.
    const wrongAnswer = baseResult({
      outputText: "Net profit is £45.20.",
      parsedJson: { netProfit: 45.2 },
    });
    const guarded = new GuardedAiModelProvider(fakeProvider(wrongAnswer));

    const firstPass = await guarded.complete({
      ...baseRequest,
      groundTruthFacts: { netProfit: 45.2 },
    });
    expect(firstPass.available).toBe(true);

    const secondPass = await guarded.complete({
      ...baseRequest,
      groundTruthFacts: { netProfit: 12.0 },
    });
    expect(secondPass.available).toBe(false);
    expect(secondPass.hallucinationFlags!.some((f) => f.kind === "GROUND_TRUTH_CONTRADICTION")).toBe(true);
  });
});
