import { fetchWithBackoff } from "../http/backoff.js";
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider, AiModelTier } from "./AiModelProvider.js";

export interface OpenAiModelConfig {
  apiKey: string;
  /** Model id for each tier — see AiModelProvider.ts's doc comment on why
   *  callers never name a literal model id themselves. Sourced from
   *  AI_FAST_MODEL / AI_DEEP_MODEL / AI_AUDIT_MODEL — see
   *  createAiModelProvider.ts. Required, not defaulted here: this class
   *  never silently picks a model on the caller's behalf. */
  fastModel: string;
  deepModel: string;
  auditModel: string;
  /** Defaults to OpenAI's real API. Overridable for testing against a
   *  local fixture server, never for silently talking to a different
   *  vendor under an "OpenAI" label. */
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch — same pattern as
   *  PokeTraceProvider/EbayBrowseProvider. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * Real OpenAI Responses API adapter (POST {baseUrl}/responses), built
 * against the documented request/response shape (developers.openai.com):
 * top-level `model` + `instructions` + `input` (a plain string, or — when
 * `request.images` is set, see below — an array of message content items),
 * optional `text.format` for JSON-Schema-constrained structured output
 * (`{type: "json_schema", name, schema, strict: true}`),
 * `usage.input_tokens`/`output_tokens`/`total_tokens`. Structured output is
 * parsed from `output_text` by THIS class, not read from a nonexistent
 * `output_parsed` field on the raw response — see the doc comment further
 * down, at the parsing site, for the full story (a real live bug, fixed and
 * live-verified 2026-09-03).
 *
 * LIVE-VERIFIED, 2026-09-03 — release gap 1: plain-text and real
 * structured-JSON calls both confirmed working against the real account for
 * every configured tier (apps/worker/scripts/openai-smoke-test.ts), plus
 * `listing-analyst:eval` against real fixtures. Re-run those two scripts
 * after any change to this file's request/response handling — per the
 * user's own explicit instruction: "If a
 * model returns an account-access/model-availability error, do NOT
 * substitute another model silently. Report the exact error and stop that
 * part of the implementation." This class follows that instruction exactly
 * — see below, no fallback path exists anywhere in `complete()`.
 */
export class OpenAiModelProvider implements AiModelProvider {
  readonly name = "openai";

  constructor(private readonly config: OpenAiModelConfig) {}

  private modelForTier(tier: AiModelTier): string {
    switch (tier) {
      case "FAST":
        return this.config.fastModel;
      case "DEEP":
        return this.config.deepModel;
      case "AUDIT":
        return this.config.auditModel;
    }
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const model = this.modelForTier(request.tier);
    const doFetch = this.config.fetchImpl ?? fetch;
    const baseUrl = this.config.baseUrl ?? DEFAULT_BASE_URL;

    const body: Record<string, unknown> = {
      model,
      instructions: request.instructions,
      // AI INTELLIGENCE gap 2 (multimodal): a plain string `input` (the
      // original, still the overwhelmingly common case) is the documented
      // shorthand for a single user-role text message. The moment any
      // images are attached, the Responses API instead wants `input` as an
      // array of message items whose `content` mixes `input_text` and
      // `input_image` parts (developers.openai.com/api/docs/guides/
      // images-vision, confirmed 2026-09-03) — never a text description of
      // "here are some images" with the images left out, which would defeat
      // the entire point of gap 2's evidence-rich requirement.
      input:
        request.images && request.images.length > 0
          ? [
              {
                role: "user",
                content: [
                  { type: "input_text", text: request.input },
                  ...request.images.map((img) => ({
                    type: "input_image",
                    image_url: img.url,
                    detail: img.detail ?? "auto",
                  })),
                ],
              },
            ]
          : request.input,
    };
    if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
    if (request.responseSchema) {
      body.text = {
        format: {
          type: "json_schema",
          name: request.responseSchema.name,
          strict: true,
          schema: request.responseSchema.schema,
        },
      };
    }

    let response: Response;
    try {
      response = await fetchWithBackoff(() =>
        doFetch(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }),
      );
    } catch (err) {
      // Network-level failure (no response at all) — never silently
      // retried with a different model, just reported honestly.
      return {
        available: false,
        outputText: null,
        parsedJson: null,
        modelId: model,
        usage: null,
        error: `Network error calling OpenAI Responses API: ${err instanceof Error ? err.message : String(err)}`,
        promptVersionId: request.promptVersionId,
      };
    }

    let json: Record<string, unknown>;
    try {
      json = (await response.json()) as Record<string, unknown>;
    } catch {
      return {
        available: false,
        outputText: null,
        parsedJson: null,
        modelId: model,
        usage: null,
        error: `OpenAI Responses API returned a non-JSON body (HTTP ${response.status})`,
        promptVersionId: request.promptVersionId,
      };
    }

    if (!response.ok) {
      // EXPLICIT REQUIREMENT: report the exact upstream error and stop —
      // never substitute a different model or fabricate a fallback answer.
      const errorObj = json.error as { message?: string; type?: string; code?: string } | undefined;
      const detail = errorObj?.message ?? JSON.stringify(json);
      const code = errorObj?.code ? ` (code: ${errorObj.code})` : "";
      return {
        available: false,
        outputText: null,
        parsedJson: null,
        modelId: model,
        usage: null,
        error: `OpenAI Responses API error for model "${model}": HTTP ${response.status} — ${detail}${code}`,
        promptVersionId: request.promptVersionId,
      };
    }

    const refusal = extractRefusal(json);
    if (refusal) {
      // The model declined to answer at the content-safety layer. Never
      // treated as a parse failure or silently swallowed — surfaced exactly
      // like any other unavailable result, with the model's own reason.
      return {
        available: false,
        outputText: null,
        parsedJson: null,
        modelId: (json.model as string | undefined) ?? model,
        usage: null,
        error: `OpenAI model "${model}" refused to respond: ${refusal}`,
        promptVersionId: request.promptVersionId,
      };
    }

    const outputText = extractOutputText(json);
    const usageRaw = json.usage as { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined;

    let parsedJson: unknown | null = null;
    if (request.responseSchema) {
      // IMPORTANT: `output_parsed` is NOT a field the raw Responses API
      // returns — confirmed 2026-09-03 (was previously read directly off
      // `json.output_parsed`, which meant structured output silently came
      // back as `parsedJson: null` on every single real call, even a fully
      // schema-conformant one). `output_parsed` only exists on the
      // `ParsedResponse` object the official SDK's `responses.parse()`
      // convenience wrapper constructs CLIENT-SIDE, by JSON-parsing
      // `output_text` itself against the caller's schema after the raw HTTP
      // response comes back — it is never present in the raw JSON body a
      // plain `fetch()` POST to `/responses` receives, which is what this
      // class does (see the class doc comment: "built against the
      // documented request/response shape", not against the SDK). So this
      // class now does exactly what `responses.parse()` does internally:
      // JSON.parse `output_text` itself. A `strict: true` json_schema
      // request guarantees (per OpenAI's own contract) that a `completed`
      // response's `output_text` is valid JSON conforming to the schema, so
      // a parse failure here means something genuinely went wrong (a
      // truncated response, a non-`completed` status) — surfaced as a real
      // error, never a silently-null parsedJson a caller might mistake for
      // "no schema was requested".
      if (outputText === null) {
        return {
          available: false,
          outputText: null,
          parsedJson: null,
          modelId: (json.model as string | undefined) ?? model,
          usage: null,
          error: `OpenAI Responses API requested structured output (schema "${request.responseSchema.name}") but returned no output text to parse (status: ${String(json.status ?? "unknown")})`,
          promptVersionId: request.promptVersionId,
        };
      }
      try {
        parsedJson = JSON.parse(outputText);
      } catch (err) {
        return {
          available: false,
          outputText,
          parsedJson: null,
          modelId: (json.model as string | undefined) ?? model,
          usage: null,
          error: `OpenAI Responses API's output_text was not valid JSON despite requesting schema "${request.responseSchema.name}": ${err instanceof Error ? err.message : String(err)}`,
          promptVersionId: request.promptVersionId,
        };
      }
    }

    return {
      available: true,
      outputText,
      parsedJson,
      modelId: (json.model as string | undefined) ?? model,
      usage: usageRaw
        ? {
            inputTokens: usageRaw.input_tokens ?? 0,
            outputTokens: usageRaw.output_tokens ?? 0,
            totalTokens: usageRaw.total_tokens ?? 0,
          }
        : null,
      error: null,
      promptVersionId: request.promptVersionId,
    };
  }
}

/** `output_text` is documented as a convenience field, but this reads
 *  through the full `output` array as a fallback in case a given response
 *  omits it — never crashes on an unexpected shape, just returns null. */
function extractOutputText(json: Record<string, unknown>): string | null {
  if (typeof json.output_text === "string") return json.output_text;

  const output = json.output;
  if (!Array.isArray(output)) return null;

  const parts: string[] = [];
  for (const item of output) {
    if (item && typeof item === "object" && Array.isArray((item as { content?: unknown[] }).content)) {
      for (const contentItem of (item as { content: unknown[] }).content) {
        if (
          contentItem &&
          typeof contentItem === "object" &&
          typeof (contentItem as { text?: unknown }).text === "string"
        ) {
          parts.push((contentItem as { text: string }).text);
        }
      }
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

/** A content item of type "refusal" (distinct from "output_text") is how
 *  the Responses API represents a model declining to answer at the
 *  content-safety layer — never mistaken for empty/missing output text. */
function extractRefusal(json: Record<string, unknown>): string | null {
  const output = json.output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (item && typeof item === "object" && Array.isArray((item as { content?: unknown[] }).content)) {
      for (const contentItem of (item as { content: unknown[] }).content) {
        if (
          contentItem &&
          typeof contentItem === "object" &&
          (contentItem as { type?: unknown }).type === "refusal" &&
          typeof (contentItem as { refusal?: unknown }).refusal === "string"
        ) {
          return (contentItem as { refusal: string }).refusal;
        }
      }
    }
  }
  return null;
}
