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
 * top-level `model` + `instructions` + `input` (string), optional
 * `text.format` for JSON-Schema-constrained structured output
 * (`{type: "json_schema", name, schema, strict: true}` -> response's
 * `output_parsed`), `usage.input_tokens`/`output_tokens`/`total_tokens`.
 *
 * NOT YET EXERCISED AGAINST A LIVE ACCOUNT — the user's own "Not yet —
 * build it wired for a key, test later" decision. Built as correctly as
 * documentation allows; apps/worker/scripts/openai-smoke-test.ts is the
 * one minimal live call (one per configured tier) that should be run,
 * against the real key/account, before anything depending on this class
 * ships to production — per the user's own explicit instruction: "If a
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
      input: request.input,
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

    const outputText = extractOutputText(json);
    const usageRaw = json.usage as { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined;

    return {
      available: true,
      outputText,
      parsedJson: (json.output_parsed as unknown) ?? null,
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
