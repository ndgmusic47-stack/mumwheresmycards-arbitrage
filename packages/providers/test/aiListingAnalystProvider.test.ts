import { describe, it, expect } from "vitest";
import { AiListingAnalystProvider, LISTING_ANALYST_TEMPLATE } from "../src/advisory/AiListingAnalystProvider.js";
import type { AiAdvisoryRequest } from "../src/advisory/AiAdvisoryProvider.js";
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from "../src/ai/AiModelProvider.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream J (AI
 * Listing Analyst). Pins down: the request built for the underlying
 * AiModelProvider is correctly assembled (tier, schema, promptVersionId,
 * groundTruthFacts including the canary field), an unavailable/rejected
 * inner result degrades to the same honest-caveat shape
 * NullAiAdvisoryProvider always used, and a successful result correctly
 * surfaces both the model's own caveats and any guardrail-derived ones
 * alongside the standing verify-before-acting caveat.
 */
const SAMPLE_REQUEST: AiAdvisoryRequest = {
  opportunityId: "opp-1",
  cardName: "Charizard ex 199/197",
  strategy: "FLIP",
  listingTitle: "Charizard ex 199/197 PSA 10 raw NM",
  listingPrice: 120,
  totalAcquisitionCost: 135,
  reasoning: ["QSV covers acquisition cost with margin to spare"],
  economicsFacts: { expectedNetProfit: 45.2, qsv: 190 },
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
    outputText: JSON.stringify({ summary: "Looks solid.", caveats: [], statedTotalAcquisitionCost: 135 }),
    parsedJson: { summary: "Looks solid.", caveats: [], statedTotalAcquisitionCost: 135 },
    modelId: "gpt-5.6-terra",
    usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
    error: null,
    hallucinationFlags: [],
    ...overrides,
  };
}

describe("AiListingAnalystProvider", () => {
  it("exposes a stable provider name", () => {
    const { provider } = capturingProvider(availableResult());
    const analyst = new AiListingAnalystProvider(provider);
    expect(analyst.name).toBe("listing-analyst");
  });

  it("builds a DEEP-tier, schema-constrained request stamped with the template's promptVersionId", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const analyst = new AiListingAnalystProvider(provider);

    await analyst.getAdvisory(SAMPLE_REQUEST);

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.tier).toBe("DEEP");
    expect(req.responseSchema?.name).toBe("listing_analyst_advisory");
    expect(req.promptVersionId).toBe(`listing_analyst_advisory@v${LISTING_ANALYST_TEMPLATE.version}`);
  });

  it("passes economicsFacts through as groundTruthFacts, plus the statedTotalAcquisitionCost canary field", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const analyst = new AiListingAnalystProvider(provider);

    await analyst.getAdvisory(SAMPLE_REQUEST);

    expect(captured[0]!.groundTruthFacts).toEqual({
      expectedNetProfit: 45.2,
      qsv: 190,
      statedTotalAcquisitionCost: 135,
    });
  });

  it("handles a request with no economicsFacts at all — still adds the canary field, never crashes", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const analyst = new AiListingAnalystProvider(provider);

    await analyst.getAdvisory({ ...SAMPLE_REQUEST, economicsFacts: undefined });

    expect(captured[0]!.groundTruthFacts).toEqual({ statedTotalAcquisitionCost: 135 });
  });

  it("includes the card name, listing price, and engine reasoning in the built input text", async () => {
    const { provider, captured } = capturingProvider(availableResult());
    const analyst = new AiListingAnalystProvider(provider);

    await analyst.getAdvisory(SAMPLE_REQUEST);

    const input = captured[0]!.input;
    expect(input).toContain("Charizard ex 199/197");
    expect(input).toContain("£120");
    expect(input).toContain("QSV covers acquisition cost with margin to spare");
  });

  it("degrades to an honest unavailable response, with the exact upstream/guardrail error as the caveat, when the inner provider is unavailable", async () => {
    const { provider } = capturingProvider({
      available: false,
      outputText: null,
      parsedJson: null,
      modelId: null,
      usage: null,
      error: "AI daily spend cap reached: $5.00 already spent today...",
    });
    const analyst = new AiListingAnalystProvider(provider);

    const result = await analyst.getAdvisory(SAMPLE_REQUEST);

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
    const analyst = new AiListingAnalystProvider(provider);

    const result = await analyst.getAdvisory(SAMPLE_REQUEST);

    expect(result.caveats).toEqual(["AI advisory is currently unavailable."]);
  });

  it("on success: reads summary from parsedJson, and always appends the standing verify-before-acting caveat", async () => {
    const { provider } = capturingProvider(
      availableResult({
        parsedJson: { summary: "Strong FLIP: profit clears the bar with room to spare.", caveats: [], statedTotalAcquisitionCost: 135 },
      }),
    );
    const analyst = new AiListingAnalystProvider(provider);

    const result = await analyst.getAdvisory(SAMPLE_REQUEST);

    expect(result.available).toBe(true);
    expect(result.summary).toBe("Strong FLIP: profit clears the bar with room to spare.");
    expect(result.caveats).toContain(
      "AI-generated analysis — this app's own deterministic pricing (not the model) is what qualified this opportunity; verify against those numbers before acting.",
    );
  });

  it("surfaces the model's own self-reported caveats", async () => {
    const { provider } = capturingProvider(
      availableResult({
        parsedJson: {
          summary: "Looks fine.",
          caveats: ["Listing has no photo of the card back — worth confirming condition before bidding."],
          statedTotalAcquisitionCost: 135,
        },
      }),
    );
    const analyst = new AiListingAnalystProvider(provider);

    const result = await analyst.getAdvisory(SAMPLE_REQUEST);

    expect(result.caveats).toContain("Listing has no photo of the card back — worth confirming condition before bidding.");
  });

  it("surfaces guardrail-derived UNGROUNDED_FIGURE flags as caveats too", async () => {
    const { provider } = capturingProvider(
      availableResult({
        hallucinationFlags: [{ kind: "UNGROUNDED_FIGURE", detail: 'Output mentions "£500", a figure with no basis in context.' }],
      }),
    );
    const analyst = new AiListingAnalystProvider(provider);

    const result = await analyst.getAdvisory(SAMPLE_REQUEST);

    expect(result.caveats).toContain('Output mentions "£500", a figure with no basis in context.');
  });

  it("falls back to outputText for summary if parsedJson is unexpectedly missing a string summary — defensive, never crashes", async () => {
    const { provider } = capturingProvider(
      availableResult({ outputText: "raw fallback text", parsedJson: { caveats: [], statedTotalAcquisitionCost: 135 } }),
    );
    const analyst = new AiListingAnalystProvider(provider);

    const result = await analyst.getAdvisory(SAMPLE_REQUEST);

    expect(result.summary).toBe("raw fallback text");
  });

  /**
   * AI INTELLIGENCE gap 2 (multimodal, evidence-rich Listing Analyst) —
   * regression guards added 2026-09-03.
   */
  describe("gap 2: evidence in the input text", () => {
    it("weaves condition description, raw condition-descriptor codes, item description, aspects, and seller feedback into the input when present", async () => {
      const { provider, captured } = capturingProvider(availableResult());
      const analyst = new AiListingAnalystProvider(provider);

      await analyst.getAdvisory({
        ...SAMPLE_REQUEST,
        itemCondition: "USED",
        conditionDescription: "Excellent - Lightly played, minor edge wear",
        conditionDescriptors: [{ name: "27501", values: ["400010"] }],
        itemDescription: "Pulled from a binder, never played.",
        aspects: [{ name: "Language", value: "English" }],
        sellerFeedbackScore: 4200,
        sellerFeedbackPct: 99.6,
      });

      const input = captured[0]!.input;
      expect(input).toContain("USED");
      expect(input).toContain("Excellent - Lightly played, minor edge wear");
      expect(input).toContain("27501: 400010");
      expect(input).toContain("Pulled from a binder, never played.");
      expect(input).toContain("Language=English");
      expect(input).toContain("4200");
      expect(input).toContain("99.6");
      // Raw codes must never be presented as if they were mapped/decoded.
      expect(input).toContain("RAW/unmapped");
    });

    it("omits evidence lines entirely for fields the request didn't supply — no fabricated 'unknown' evidence", async () => {
      const { provider, captured } = capturingProvider(availableResult());
      const analyst = new AiListingAnalystProvider(provider);

      await analyst.getAdvisory(SAMPLE_REQUEST);

      const input = captured[0]!.input;
      expect(input).toContain("No listing photos were available for this request.");
      expect(input).not.toContain("eBay condition description");
      expect(input).not.toContain("eBay item specifics");
    });
  });

  describe("gap 2: images", () => {
    it("passes imageUrls through as AiCompletionRequest.images", async () => {
      const { provider, captured } = capturingProvider(availableResult());
      const analyst = new AiListingAnalystProvider(provider);

      await analyst.getAdvisory({
        ...SAMPLE_REQUEST,
        imageUrls: ["https://img.example/1.jpg", "https://img.example/2.jpg"],
      });

      expect(captured[0]!.images).toEqual([
        { url: "https://img.example/1.jpg", detail: "auto" },
        { url: "https://img.example/2.jpg", detail: "auto" },
      ]);
    });

    it("caps images at MAX_IMAGES (4), never sending an unbounded number", async () => {
      const { provider, captured } = capturingProvider(availableResult());
      const analyst = new AiListingAnalystProvider(provider);

      await analyst.getAdvisory({
        ...SAMPLE_REQUEST,
        imageUrls: Array.from({ length: 10 }, (_, i) => `https://img.example/${i}.jpg`),
      });

      expect(captured[0]!.images).toHaveLength(4);
      expect(captured[0]!.images![0]!.url).toBe("https://img.example/0.jpg");
    });

    it("sends no images (undefined-equivalent empty array) when imageUrls is absent — text-only request, unchanged from before gap 2", async () => {
      const { provider, captured } = capturingProvider(availableResult());
      const analyst = new AiListingAnalystProvider(provider);

      await analyst.getAdvisory(SAMPLE_REQUEST);

      expect(captured[0]!.images).toEqual([]);
    });

    it("reflects the actual (post-cap) image count in the input text, not the raw request count", async () => {
      const { provider, captured } = capturingProvider(availableResult());
      const analyst = new AiListingAnalystProvider(provider);

      await analyst.getAdvisory({
        ...SAMPLE_REQUEST,
        imageUrls: Array.from({ length: 10 }, (_, i) => `https://img.example/${i}.jpg`),
      });

      expect(captured[0]!.input).toContain("4 listing photo(s) are attached");
    });
  });

  describe("gap 2: structured assessments in the response", () => {
    function assessment(value: string, confidence = 0.8, evidence = "some evidence") {
      return { value, confidence, evidence };
    }

    it("parses all eight structured assessments from parsedJson when present", async () => {
      const { provider } = capturingProvider(
        availableResult({
          parsedJson: {
            summary: "Looks solid.",
            caveats: [],
            statedTotalAcquisitionCost: 135,
            identity: assessment("MATCH"),
            itemType: assessment("RAW_SINGLE"),
            variant: assessment("none observed"),
            language: assessment("English"),
            condition: assessment("Near mint based on photos"),
            visibleDamage: assessment("none observed"),
            photoQuality: assessment("GOOD"),
            reasonCheap: assessment("Seller has low feedback count, may be inexperienced"),
          },
        }),
      );
      const analyst = new AiListingAnalystProvider(provider);

      const result = await analyst.getAdvisory(SAMPLE_REQUEST);

      expect(result.identity).toEqual(assessment("MATCH"));
      expect(result.itemType).toEqual(assessment("RAW_SINGLE"));
      expect(result.variant).toEqual(assessment("none observed"));
      expect(result.language).toEqual(assessment("English"));
      expect(result.condition).toEqual(assessment("Near mint based on photos"));
      expect(result.visibleDamage).toEqual(assessment("none observed"));
      expect(result.photoQuality).toEqual(assessment("GOOD"));
      expect(result.reasonCheap).toEqual(assessment("Seller has low feedback count, may be inexperienced"));
    });

    it("leaves every assessment field undefined (never a fabricated placeholder) when parsedJson doesn't carry them", async () => {
      const { provider } = capturingProvider(
        availableResult({ parsedJson: { summary: "ok", caveats: [], statedTotalAcquisitionCost: 135 } }),
      );
      const analyst = new AiListingAnalystProvider(provider);

      const result = await analyst.getAdvisory(SAMPLE_REQUEST);

      expect(result.identity).toBeUndefined();
      expect(result.itemType).toBeUndefined();
      expect(result.photoQuality).toBeUndefined();
    });

    it("drops a malformed assessment (missing evidence, or wrong types) rather than surfacing a half-valid one", async () => {
      const { provider } = capturingProvider(
        availableResult({
          parsedJson: {
            summary: "ok",
            caveats: [],
            statedTotalAcquisitionCost: 135,
            identity: { value: "MATCH" }, // missing confidence/evidence — malformed
            itemType: "RAW_SINGLE", // wrong shape entirely (bare string) — malformed
          },
        }),
      );
      const analyst = new AiListingAnalystProvider(provider);

      const result = await analyst.getAdvisory(SAMPLE_REQUEST);

      expect(result.identity).toBeUndefined();
      expect(result.itemType).toBeUndefined();
    });

    it("never populates any assessment field on an unavailable result", async () => {
      const { provider } = capturingProvider({
        available: false,
        outputText: null,
        parsedJson: null,
        modelId: null,
        usage: null,
        error: "no key configured",
      });
      const analyst = new AiListingAnalystProvider(provider);

      const result = await analyst.getAdvisory(SAMPLE_REQUEST);

      expect(result.identity).toBeUndefined();
      expect(result.photoQuality).toBeUndefined();
      expect(result.reasonCheap).toBeUndefined();
    });
  });
});
