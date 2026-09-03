import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from "./AiModelProvider.js";

/**
 * The default provider when no OpenAI API key is configured — see
 * createAiModelProvider.ts. Same discipline as NullAiAdvisoryProvider: no
 * network call, always honest about being unavailable, never a fabricated
 * answer. This is the REAL, INTENTIONAL current behaviour for anyone who
 * hasn't set OPENAI_API_KEY — not a test mock (per the user's own "Not yet
 * — build it wired for a key, test later" decision, this is what every AI
 * feature does today, in production, until a key is added).
 */
export class NullAiModelProvider implements AiModelProvider {
  readonly name = "none";

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    return {
      available: false,
      outputText: null,
      parsedJson: null,
      modelId: null,
      usage: null,
      error: "AI provider is not configured — no OPENAI_API_KEY is set in this environment.",
      promptVersionId: request.promptVersionId,
    };
  }
}
