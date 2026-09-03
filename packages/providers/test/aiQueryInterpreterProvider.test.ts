import { describe, it, expect } from "vitest";
import { AiQueryInterpreterProvider, QUERY_INTERPRETER_TEMPLATE, sanitizeInterpretedFilters } from "../src/query/AiQueryInterpreterProvider.js";
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from "../src/ai/AiModelProvider.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream L
 * (natural-language query interpreter). Pins down: the request built for
 * the underlying AiModelProvider is correctly assembled (FAST tier, schema,
 * promptVersionId), an unavailable/rejected inner result degrades to the
 * same honest-caveat shape every other AI feature in this app uses, and a
 * successful result correctly separates "understood, here are filters"
 * from "not a filtering query at all" (unrecognizedIntent) — plus the
 * sanitizeInterpretedFilters() re-validation guardrail this file's own doc
 * comment explains is the real trust boundary here (never
 * GROUND_TRUTH_CONTRADICTION, since there's no pre-existing true value for
 * a user's own stated filter thresholds).
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

function fullValidParsedJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    category: "ACTIONABLE",
    strategy: "GRADE",
    auctionsOnly: false,
    minNetProfit: 40,
    minReturnOnCapital: 0.4,
    maxAcquisitionCost: 200,
    minQsv: null,
    minLiquidity: "MEDIUM",
    minConfidence: 0.6,
    maxTotalGradedBasis: null,
    minPsa10Profit: 200,
    minPsa9Profit: null,
    maxBreakEvenGrade: 9,
    explanation: "Showing GRADE opportunities under £200 with at least £40 profit and a PSA10 profit over £200.",
    caveats: [],
    unrecognizedIntent: false,
    ...overrides,
  };
}

function availableResult(overrides: Partial<AiCompletionResult> = {}): AiCompletionResult {
  const parsed = fullValidParsedJson();
  return {
    available: true,
    outputText: JSON.stringify(parsed),
    parsedJson: parsed,
    modelId: "gpt-5.6-luna",
    usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
    error: null,
    hallucinationFlags: [],
    ...overrides,
  };
}

describe("AiQueryInterpreterProvider", () => {
  it("exposes a stable provider name", () => {
    const { provider } = capturingProvider(availableResult());
    const interpreter = new AiQueryInterpreterProvider(provider);
    expect(interpreter.name).toBe("query-interpreter");
  });

  it("builds a FAST-tier, schema-constrained request stamped with the template's promptVersionId", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const interpreter = new AiQueryInterpreterProvider(provider);

    await interpreter.interpretQuery({ queryText: "grade opportunities under £200" });

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.tier).toBe("FAST");
    expect(req.responseSchema?.name).toBe("query_interpretation");
    expect(req.promptVersionId).toBe(`query_interpreter@v${QUERY_INTERPRETER_TEMPLATE.version}`);
  });

  it("includes the user's exact query text in the built input", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const interpreter = new AiQueryInterpreterProvider(provider);

    await interpreter.interpretQuery({ queryText: "cheap flips over 50% ROC" });

    expect(captured[0]!.input).toContain("cheap flips over 50% ROC");
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
    const interpreter = new AiQueryInterpreterProvider(provider);

    const result = await interpreter.interpretQuery({ queryText: "grade under £100" });

    expect(result.available).toBe(false);
    expect(result.filters).toBeNull();
    expect(result.explanation).toBeNull();
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
    const interpreter = new AiQueryInterpreterProvider(provider);

    const result = await interpreter.interpretQuery({ queryText: "grade under £100" });

    expect(result.caveats).toEqual(["AI query interpretation is currently unavailable."]);
  });

  it("on success: returns the sanitized filters and the model's explanation", async () => {
    const { provider } = capturingProvider(availableResult());
    const interpreter = new AiQueryInterpreterProvider(provider);

    const result = await interpreter.interpretQuery({ queryText: "grade opportunities under £200 with psa10 profit over £200" });

    expect(result.available).toBe(true);
    expect(result.explanation).toBe(
      "Showing GRADE opportunities under £200 with at least £40 profit and a PSA10 profit over £200.",
    );
    expect(result.filters).toEqual({
      category: "ACTIONABLE",
      strategy: "GRADE",
      auctionsOnly: false,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
      maxAcquisitionCost: 200,
      minLiquidity: "MEDIUM",
      minConfidence: 0.6,
      minPsa10Profit: 200,
      maxBreakEvenGrade: 9,
    });
  });

  it("returns null filters (never a fabricated guess) when the model judges the query unrelated to filtering", async () => {
    const { provider } = capturingProvider(
      availableResult({
        parsedJson: fullValidParsedJson({
          unrecognizedIntent: true,
          explanation: "This doesn't look like a request about filtering sourcing opportunities.",
          caveats: ["The query asks about something unrelated to this tool's filters."],
        }),
      }),
    );
    const interpreter = new AiQueryInterpreterProvider(provider);

    const result = await interpreter.interpretQuery({ queryText: "what's the weather today" });

    expect(result.available).toBe(true);
    expect(result.filters).toBeNull();
    expect(result.caveats).toContain("The query asks about something unrelated to this tool's filters.");
  });

  it("surfaces the model's own self-reported caveats", async () => {
    const { provider } = capturingProvider(
      availableResult({
        parsedJson: fullValidParsedJson({ caveats: ["Ignored 'recent' — this app has no listing-age filter."] }),
      }),
    );
    const interpreter = new AiQueryInterpreterProvider(provider);

    const result = await interpreter.interpretQuery({ queryText: "recent grade opportunities" });

    expect(result.caveats).toContain("Ignored 'recent' — this app has no listing-age filter.");
  });

  it("surfaces guardrail-derived UNGROUNDED_FIGURE flags as caveats too (defense in depth)", async () => {
    const { provider } = capturingProvider(
      availableResult({
        hallucinationFlags: [{ kind: "UNGROUNDED_FIGURE", detail: 'Output mentions "£500", a figure with no basis in context.' }],
      }),
    );
    const interpreter = new AiQueryInterpreterProvider(provider);

    const result = await interpreter.interpretQuery({ queryText: "grade under £200" });

    expect(result.caveats).toContain('Output mentions "£500", a figure with no basis in context.');
  });

  it("drops a nonsensical field from a malformed parsedJson rather than trusting it, and explains the drop", async () => {
    const { provider } = capturingProvider(
      availableResult({
        parsedJson: fullValidParsedJson({ category: "URGENT", minConfidence: 60 }),
      }),
    );
    const interpreter = new AiQueryInterpreterProvider(provider);

    const result = await interpreter.interpretQuery({ queryText: "urgent grade opportunities, 60% confidence" });

    expect(result.filters?.category).toBeUndefined();
    expect(result.filters?.minConfidence).toBeUndefined();
    expect(result.caveats.some((c) => c.includes("category"))).toBe(true);
    expect(result.caveats.some((c) => c.includes("minConfidence"))).toBe(true);
  });
});

describe("sanitizeInterpretedFilters", () => {
  it("passes through a fully valid object with no drops", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters(fullValidParsedJson());
    expect(droppedFieldCaveats).toEqual([]);
    expect(filters.category).toBe("ACTIONABLE");
    expect(filters.strategy).toBe("GRADE");
    expect(filters.minPsa10Profit).toBe(200);
    expect(filters.maxBreakEvenGrade).toBe(9);
  });

  it("omits null/undefined fields with no caveat at all — that's a genuine 'not mentioned', not an error", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ category: null, minNetProfit: undefined });
    expect(filters).toEqual({});
    expect(droppedFieldCaveats).toEqual([]);
  });

  it("drops an invalid category", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ category: "NOT_REAL" });
    expect(filters.category).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("category");
  });

  it("drops an invalid strategy", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ strategy: "AUCTION" });
    expect(filters.strategy).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("strategy");
  });

  it("drops an invalid liquidity level", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ minLiquidity: "SUPER_HIGH" });
    expect(filters.minLiquidity).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("minLiquidity");
  });

  it("drops a non-boolean auctionsOnly", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ auctionsOnly: "yes" });
    expect(filters.auctionsOnly).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("auctionsOnly");
  });

  it("drops a negative GBP figure", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ minNetProfit: -40 });
    expect(filters.minNetProfit).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("minNetProfit");
  });

  it("drops a GBP figure over the sane ceiling", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ maxAcquisitionCost: 50_000_000 });
    expect(filters.maxAcquisitionCost).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("maxAcquisitionCost");
  });

  it("drops minReturnOnCapital when it looks like a units mistake (a raw percentage, not a fraction)", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ minReturnOnCapital: 40 });
    expect(filters.minReturnOnCapital).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("minReturnOnCapital");
  });

  it("accepts a real minReturnOnCapital fraction", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ minReturnOnCapital: 0.4 });
    expect(filters.minReturnOnCapital).toBe(0.4);
    expect(droppedFieldCaveats).toEqual([]);
  });

  // AI INTELLIGENCE gap 4: minMargin added to InterpretedOpportunityFilters.
  it("drops minMargin when it looks like a units mistake (a raw percentage, not a fraction)", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ minMargin: 30 });
    expect(filters.minMargin).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("minMargin");
  });

  it("accepts a real minMargin fraction", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ minMargin: 0.3 });
    expect(filters.minMargin).toBe(0.3);
    expect(droppedFieldCaveats).toEqual([]);
  });

  it("leaves minMargin unset when the query didn't mention it", () => {
    const { filters } = sanitizeInterpretedFilters({});
    expect(filters.minMargin).toBeUndefined();
  });

  it("drops minConfidence above 1", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ minConfidence: 1.5 });
    expect(filters.minConfidence).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("minConfidence");
  });

  it("drops a non-integer maxBreakEvenGrade", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ maxBreakEvenGrade: 8.5 });
    expect(filters.maxBreakEvenGrade).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("maxBreakEvenGrade");
  });

  it("drops a maxBreakEvenGrade outside 1-10", () => {
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters({ maxBreakEvenGrade: 11 });
    expect(filters.maxBreakEvenGrade).toBeUndefined();
    expect(droppedFieldCaveats[0]).toContain("maxBreakEvenGrade");
  });
});
