import { describe, it, expect, vi } from "vitest";
import { OpenAiModelProvider } from "../src/ai/OpenAiModelProvider.js";

/**
 * REGRESSION GUARD for the 2026-09-03 structured-output bug: this class
 * used to read `json.output_parsed` directly off the raw HTTP response —
 * a field that only ever exists on the official SDK's `responses.parse()`
 * client-side convenience wrapper, never in the raw JSON body a plain
 * `fetch()` POST to `/responses` actually receives (confirmed against
 * OpenAI's own docs and SDK issue tracker). That meant every real
 * structured-output call silently came back with `parsedJson: null`, even
 * when `output_text` held perfectly valid, schema-conformant JSON — a bug
 * that could only ever be caught by a live call or a test that models the
 * REAL raw response shape (no `output_parsed` field anywhere), which is
 * exactly what every test below does.
 */

function fakeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as unknown as typeof fetch;
}

const config = {
  apiKey: "sk-test",
  fastModel: "gpt-5.6-luna",
  deepModel: "gpt-5.6-terra",
  auditModel: "gpt-5.6-sol",
};

const SCHEMA = {
  name: "test_schema",
  schema: {
    type: "object",
    properties: { verdict: { type: "string" }, confidence: { type: "number" } },
    required: ["verdict", "confidence"],
    additionalProperties: false,
  },
};

describe("OpenAiModelProvider", () => {
  it("parses plain-text (no schema) responses via output_text, with parsedJson null", async () => {
    const fetchImpl = fakeFetch(200, {
      model: "gpt-5.6-luna",
      output_text: "OK",
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
    });
    const provider = new OpenAiModelProvider({ ...config, fetchImpl });
    const result = await provider.complete({ tier: "FAST", instructions: "x", input: "y" });

    expect(result.available).toBe(true);
    expect(result.outputText).toBe("OK");
    expect(result.parsedJson).toBeNull();
  });

  it("REGRESSION: parses structured JSON output from output_text — never trusts a nonexistent output_parsed field", async () => {
    // This is the exact real shape: no `output_parsed` anywhere, only
    // `output_text` holding the schema-conformant JSON as a raw string.
    const fetchImpl = fakeFetch(200, {
      model: "gpt-5.6-terra",
      output_text: JSON.stringify({ verdict: "PASS_THROUGH", confidence: 0.92 }),
      usage: { input_tokens: 50, output_tokens: 12, total_tokens: 62 },
    });
    const provider = new OpenAiModelProvider({ ...config, fetchImpl });
    const result = await provider.complete({
      tier: "DEEP",
      instructions: "x",
      input: "y",
      responseSchema: SCHEMA,
    });

    expect(result.available).toBe(true);
    expect(result.parsedJson).toEqual({ verdict: "PASS_THROUGH", confidence: 0.92 });
  });

  it("REGRESSION: still parses structured output when the API omits the output_text convenience field, using the output[].content[] fallback", async () => {
    const fetchImpl = fakeFetch(200, {
      model: "gpt-5.6-sol",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ verdict: "BLOCK_FROM_ACTIONABLE", confidence: 0.4 }) }],
        },
      ],
      usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 },
    });
    const provider = new OpenAiModelProvider({ ...config, fetchImpl });
    const result = await provider.complete({
      tier: "AUDIT",
      instructions: "x",
      input: "y",
      responseSchema: SCHEMA,
    });

    expect(result.available).toBe(true);
    expect(result.parsedJson).toEqual({ verdict: "BLOCK_FROM_ACTIONABLE", confidence: 0.4 });
  });

  it("reports available:false with a specific error when a schema was requested but output_text isn't valid JSON — never silently returns null", async () => {
    const fetchImpl = fakeFetch(200, {
      model: "gpt-5.6-terra",
      output_text: "not json at all",
    });
    const provider = new OpenAiModelProvider({ ...config, fetchImpl });
    const result = await provider.complete({
      tier: "DEEP",
      instructions: "x",
      input: "y",
      responseSchema: SCHEMA,
    });

    expect(result.available).toBe(false);
    expect(result.parsedJson).toBeNull();
    expect(result.error).toMatch(/not valid JSON/i);
  });

  it("reports available:false with a specific error when a schema was requested but there is no output text at all", async () => {
    const fetchImpl = fakeFetch(200, { model: "gpt-5.6-terra", status: "incomplete" });
    const provider = new OpenAiModelProvider({ ...config, fetchImpl });
    const result = await provider.complete({
      tier: "DEEP",
      instructions: "x",
      input: "y",
      responseSchema: SCHEMA,
    });

    expect(result.available).toBe(false);
    expect(result.error).toMatch(/no output text to parse/i);
  });

  it("treats a refusal content item as an honest unavailable result, distinct from empty output", async () => {
    const fetchImpl = fakeFetch(200, {
      model: "gpt-5.6-terra",
      output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }],
    });
    const provider = new OpenAiModelProvider({ ...config, fetchImpl });
    const result = await provider.complete({ tier: "DEEP", instructions: "x", input: "y" });

    expect(result.available).toBe(false);
    expect(result.parsedJson).toBeNull();
    expect(result.error).toMatch(/refused/i);
    expect(result.error).toContain("I can't help with that.");
  });

  it("never substitutes a model on an upstream HTTP error — reports the exact error", async () => {
    const fetchImpl = fakeFetch(404, { error: { message: "The model `gpt-9.9-fake` does not exist", code: "model_not_found" } });
    const provider = new OpenAiModelProvider({ ...config, fetchImpl });
    const result = await provider.complete({ tier: "FAST", instructions: "x", input: "y" });

    expect(result.available).toBe(false);
    expect(result.error).toContain("gpt-9.9-fake");
    expect(result.error).toContain("model_not_found");
  });
});
