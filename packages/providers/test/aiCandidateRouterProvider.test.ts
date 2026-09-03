import { describe, it, expect } from "vitest";
import { AiCandidateRouterProvider, CANDIDATE_ROUTER_TEMPLATE } from "../src/routing/AiCandidateRouterProvider.js";
import type { CandidateRouteRequest } from "../src/routing/CandidateRouterProvider.js";
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from "../src/ai/AiModelProvider.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE gap 3 (selective AI review in the
 * candidate pipeline). Pins down: the request built for the underlying
 * AiModelProvider is FAST-tier, schema-constrained, and stamped with the
 * template's promptVersionId; groundTruthFacts includes the economics
 * context (so a £/% figure in the model's free-text `reason` isn't wrongly
 * flagged as ungrounded) but the RESPONSE schema itself carries no
 * numeric-financial field whatsoever; an unavailable/malformed inner result
 * degrades to `available: false` with `route: null` (NEVER a fabricated or
 * defaulted route); and a successful result surfaces exactly the model's
 * own route/confidence/reason, nothing more.
 */
const SAMPLE_REQUEST: CandidateRouteRequest = {
  cardName: "Charizard ex 199/197",
  strategy: "FLIP",
  state: "QUALIFIED_FLIP",
  listingTitle: "Charizard ex 199/197 PSA 10 raw NM",
  listingPrice: 120,
  totalAcquisitionCost: 135,
  economicsFacts: { expectedNetProfit: 45.2, qsv: 190 },
  reasoning: ["QSV covers acquisition cost with margin to spare"],
};

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
  return {
    available: true,
    outputText: JSON.stringify({ route: "PASS_THROUGH", confidence: 0.9, reason: "Nothing specific stands out." }),
    parsedJson: { route: "PASS_THROUGH", confidence: 0.9, reason: "Nothing specific stands out." },
    modelId: "gpt-5.6-mini",
    usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80 },
    error: null,
    hallucinationFlags: [],
    ...overrides,
  };
}

describe("AiCandidateRouterProvider", () => {
  it("exposes a stable provider name", () => {
    const { provider } = capturingProvider(availableResult());
    const router = new AiCandidateRouterProvider(provider);
    expect(router.name).toBe("candidate-router");
  });

  it("builds a FAST-tier, schema-constrained request stamped with the template's promptVersionId", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const router = new AiCandidateRouterProvider(provider);

    await router.routeCandidate(SAMPLE_REQUEST);

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.tier).toBe("FAST");
    expect(req.responseSchema?.name).toBe("candidate_router");
    expect(req.promptVersionId).toBe(`candidate_router@v${CANDIDATE_ROUTER_TEMPLATE.version}`);
  });

  it("never attaches images — a cheap text-only triage classifier, unlike the multimodal Listing Analyst", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const router = new AiCandidateRouterProvider(provider);

    await router.routeCandidate(SAMPLE_REQUEST);

    expect(captured[0]!.images ?? []).toHaveLength(0);
  });

  it("passes economicsFacts plus totalAcquisitionCost as groundTruthFacts, for ungrounded-figure grounding only", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const router = new AiCandidateRouterProvider(provider);

    await router.routeCandidate(SAMPLE_REQUEST);

    expect(captured[0]!.groundTruthFacts).toEqual({
      expectedNetProfit: 45.2,
      qsv: 190,
      totalAcquisitionCost: 135,
    });
  });

  it("the response schema has NO numeric-financial field — only route/confidence/reason", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const router = new AiCandidateRouterProvider(provider);

    await router.routeCandidate(SAMPLE_REQUEST);

    const schema = captured[0]!.responseSchema!.schema as {
      properties: Record<string, { type: string }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(["confidence", "reason", "route"]);
    expect(schema.properties.route!.type).toBe("string");
    expect(schema.properties.reason!.type).toBe("string");
    // confidence is the ONLY numeric field, and it is a 0-1 self-reported
    // certainty, never a price/profit/QSV-shaped figure.
    expect(schema.properties.confidence!.type).toBe("number");
    expect(schema.required.sort()).toEqual(["confidence", "reason", "route"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("degrades to available:false, route:null when the inner result is unavailable — never a fabricated route", async () => {
    const { provider } = capturingProvider({
      available: false,
      outputText: null,
      parsedJson: null,
      modelId: null,
      usage: null,
      error: "Daily AI spend cap reached ($5.00).",
      hallucinationFlags: [],
    });
    const router = new AiCandidateRouterProvider(provider);

    const result = await router.routeCandidate(SAMPLE_REQUEST);

    expect(result).toEqual({
      available: false,
      route: null,
      confidence: null,
      reason: null,
      error: "Daily AI spend cap reached ($5.00).",
    });
  });

  it("degrades to available:false when parsedJson has no recognisable route value, rather than guessing", async () => {
    const { provider } = capturingProvider(
      availableResult({
        parsedJson: { route: "SOMETHING_UNEXPECTED", confidence: 0.5, reason: "n/a" },
      }),
    );
    const router = new AiCandidateRouterProvider(provider);

    const result = await router.routeCandidate(SAMPLE_REQUEST);

    expect(result.available).toBe(false);
    expect(result.route).toBeNull();
  });

  it("surfaces exactly the model's own route/confidence/reason on a successful, well-formed response", async () => {
    const { provider } = capturingProvider(
      availableResult({
        parsedJson: {
          route: "REVIEW",
          confidence: 0.62,
          reason: "The seller's own description mentions light whitening the title didn't disclose.",
        },
      }),
    );
    const router = new AiCandidateRouterProvider(provider);

    const result = await router.routeCandidate(SAMPLE_REQUEST);

    expect(result).toEqual({
      available: true,
      route: "REVIEW",
      confidence: 0.62,
      reason: "The seller's own description mentions light whitening the title didn't disclose.",
      error: null,
    });
  });

  it("accepts BLOCK_FROM_ACTIONABLE as a valid route", async () => {
    const { provider } = capturingProvider(
      availableResult({
        parsedJson: {
          route: "BLOCK_FROM_ACTIONABLE",
          confidence: 0.85,
          reason: "Description explicitly states this is a lot of 12 cards, not a single card.",
        },
      }),
    );
    const router = new AiCandidateRouterProvider(provider);

    const result = await router.routeCandidate(SAMPLE_REQUEST);

    expect(result.available).toBe(true);
    expect(result.route).toBe("BLOCK_FROM_ACTIONABLE");
  });

  it("weaves supplied eBay evidence (condition, description, aspects, seller feedback) into the request input", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const router = new AiCandidateRouterProvider(provider);

    await router.routeCandidate({
      ...SAMPLE_REQUEST,
      itemCondition: "USED",
      conditionDescription: "Lightly played, minor edge wear",
      itemDescription: "Pulled from a binder, never sleeved.",
      aspects: [{ name: "Language", value: "Japanese" }],
      sellerFeedbackScore: 1500,
      sellerFeedbackPct: 98.2,
    });

    const input = captured[0]!.input;
    expect(input).toContain("USED");
    expect(input).toContain("Lightly played, minor edge wear");
    expect(input).toContain("Pulled from a binder, never sleeved.");
    expect(input).toContain("Language=Japanese");
    expect(input).toContain("1500");
    expect(input).toContain("98.2");
  });

  it("degrades gracefully to omitted evidence lines when nothing was supplied (a never-enriched listing)", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const router = new AiCandidateRouterProvider(provider);

    await router.routeCandidate(SAMPLE_REQUEST);

    expect(captured[0]!.input).toContain("No enriched eBay evidence was available for this listing.");
  });
});
