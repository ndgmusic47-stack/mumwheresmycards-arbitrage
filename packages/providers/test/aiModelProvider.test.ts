import { describe, it, expect, vi } from "vitest";
import { NullAiModelProvider } from "../src/ai/NullAiModelProvider.js";
import { OpenAiModelProvider } from "../src/ai/OpenAiModelProvider.js";
import {
  createAiModelProvider,
  DEFAULT_AI_FAST_MODEL,
  DEFAULT_AI_DEEP_MODEL,
  DEFAULT_AI_AUDIT_MODEL,
} from "../src/ai/createAiModelProvider.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2's foundation: the
 * AiModelProvider abstraction. Pins down the two non-negotiable contracts
 * from the user's own explicit instructions: (1) no key configured never
 * crashes and never fabricates output, and (2) an upstream model error is
 * ALWAYS reported exactly, NEVER silently substituted for a different
 * model.
 */
function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockImplementation(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const baseConfig = {
  apiKey: "sk-test",
  fastModel: "gpt-5.6-luna",
  deepModel: "gpt-5.6-terra",
  auditModel: "gpt-5.6-sol",
};

describe("NullAiModelProvider", () => {
  it("always reports unavailable, with no network call, never a fabricated answer", async () => {
    const provider = new NullAiModelProvider();
    const result = await provider.complete({ tier: "FAST", instructions: "x", input: "y" });

    expect(result.available).toBe(false);
    expect(result.outputText).toBeNull();
    expect(result.parsedJson).toBeNull();
    expect(result.error).toMatch(/not configured/);
  });

  it("carries promptVersionId through even when unavailable", async () => {
    const provider = new NullAiModelProvider();
    const result = await provider.complete({ tier: "DEEP", instructions: "x", input: "y", promptVersionId: "v1" });

    expect(result.promptVersionId).toBe("v1");
  });
});

describe("OpenAiModelProvider", () => {
  it("maps FAST/DEEP/AUDIT tiers to the configured model ids", async () => {
    const fetchImpl = mockFetch(200, { output_text: "ok", model: "gpt-5.6-luna", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    const provider = new OpenAiModelProvider({ ...baseConfig, fetchImpl });

    await provider.complete({ tier: "FAST", instructions: "sys", input: "hi" });

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe("gpt-5.6-luna");
    expect(body.instructions).toBe("sys");
    expect(body.input).toBe("hi");
  });

  it("returns a successful completion with output text and usage", async () => {
    const fetchImpl = mockFetch(200, {
      output_text: "The card looks genuine raw NM.",
      model: "gpt-5.6-terra",
      usage: { input_tokens: 120, output_tokens: 40, total_tokens: 160 },
    });
    const provider = new OpenAiModelProvider({ ...baseConfig, fetchImpl });

    const result = await provider.complete({ tier: "DEEP", instructions: "sys", input: "hi" });

    expect(result.available).toBe(true);
    expect(result.outputText).toBe("The card looks genuine raw NM.");
    expect(result.modelId).toBe("gpt-5.6-terra");
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 40, totalTokens: 160 });
    expect(result.error).toBeNull();
  });

  it("falls back to reading the output[].content[].text array when output_text is absent", async () => {
    const fetchImpl = mockFetch(200, {
      output: [{ type: "message", content: [{ type: "output_text", text: "fallback text" }] }],
    });
    const provider = new OpenAiModelProvider({ ...baseConfig, fetchImpl });

    const result = await provider.complete({ tier: "FAST", instructions: "sys", input: "hi" });

    expect(result.outputText).toBe("fallback text");
  });

  it("returns output_parsed verbatim when a responseSchema was requested and honoured", async () => {
    const parsed = { routing: "REVIEW", confidence: 0.7 };
    const fetchImpl = mockFetch(200, { output_text: JSON.stringify(parsed), output_parsed: parsed });
    const provider = new OpenAiModelProvider({ ...baseConfig, fetchImpl });

    const result = await provider.complete({
      tier: "FAST",
      instructions: "sys",
      input: "hi",
      responseSchema: { name: "routing_decision", schema: { type: "object" } },
    });

    expect(result.parsedJson).toEqual(parsed);

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(call[1].body as string);
    expect(body.text.format).toEqual({ type: "json_schema", name: "routing_decision", strict: true, schema: { type: "object" } });
  });

  it("NEVER substitutes a different model on an upstream error — reports the exact error and stops", async () => {
    const fetchImpl = mockFetch(404, { error: { message: "The model `gpt-5.6-luna` does not exist or you do not have access to it.", code: "model_not_found" } });
    const provider = new OpenAiModelProvider({ ...baseConfig, fetchImpl });

    const result = await provider.complete({ tier: "FAST", instructions: "sys", input: "hi" });

    expect(result.available).toBe(false);
    expect(result.outputText).toBeNull();
    expect(result.parsedJson).toBeNull();
    expect(result.modelId).toBe("gpt-5.6-luna");
    expect(result.error).toContain("gpt-5.6-luna");
    expect(result.error).toContain("does not exist or you do not have access");
    expect(result.error).toContain("model_not_found");
    // Only ONE call was ever made — proving no retry-with-a-different-model
    // fallback path exists.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a network-level failure honestly rather than throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("fetch failed: ECONNRESET")) as unknown as typeof fetch;
    const provider = new OpenAiModelProvider({ ...baseConfig, fetchImpl });

    const result = await provider.complete({ tier: "AUDIT", instructions: "sys", input: "hi" });

    expect(result.available).toBe(false);
    expect(result.error).toContain("ECONNRESET");
  });

  it("reports a non-JSON response body honestly rather than throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token");
      },
    }) as unknown as typeof fetch;
    const provider = new OpenAiModelProvider({ ...baseConfig, fetchImpl });

    const result = await provider.complete({ tier: "FAST", instructions: "sys", input: "hi" });

    expect(result.available).toBe(false);
    expect(result.error).toMatch(/non-JSON/);
  });
});

describe("createAiModelProvider", () => {
  it("returns NullAiModelProvider when no OPENAI_API_KEY is configured", () => {
    const provider = createAiModelProvider({});
    expect(provider.name).toBe("none");
  });

  it("returns a real OpenAiModelProvider when a key is present", () => {
    const provider = createAiModelProvider({ OPENAI_API_KEY: "sk-live" });
    expect(provider.name).toBe("openai");
  });

  it("uses the confirmed-real GPT-5.6 defaults when tier env vars are unset", async () => {
    const fetchImpl = mockFetch(200, { output_text: "ok" });
    const provider = createAiModelProvider({ OPENAI_API_KEY: "sk-live" }, fetchImpl);

    await provider.complete({ tier: "AUDIT", instructions: "sys", input: "hi" });

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe(DEFAULT_AI_AUDIT_MODEL);
    expect(DEFAULT_AI_FAST_MODEL).toBe("gpt-5.6-luna");
    expect(DEFAULT_AI_DEEP_MODEL).toBe("gpt-5.6-terra");
  });

  it("prefers explicit env model ids over the defaults", async () => {
    const fetchImpl = mockFetch(200, { output_text: "ok" });
    const provider = createAiModelProvider(
      { OPENAI_API_KEY: "sk-live", AI_FAST_MODEL: "gpt-5.6-luna-preview" },
      fetchImpl,
    );

    await provider.complete({ tier: "FAST", instructions: "sys", input: "hi" });

    const call = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(call[1].body as string);
    expect(body.model).toBe("gpt-5.6-luna-preview");
  });
});
