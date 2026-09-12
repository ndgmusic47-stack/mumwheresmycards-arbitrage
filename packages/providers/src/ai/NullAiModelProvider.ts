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
export type MissingKeyReason = "ABSENT" | "EMPTY";

/**
 * WHY THE REASON MATTERS. "No OPENAI_API_KEY is set" was true of two very
 * different situations and it cost an hour to tell them apart:
 *
 *   ABSENT — the binding does not exist. `wrangler secret list` will not
 *            show it. You need to add it.
 *   EMPTY  — the binding EXISTS and holds an empty string. `wrangler secret
 *            list` shows it, so it looks configured, and the worker still
 *            refuses. This is what happens when a paste does not land in
 *            wrangler's hidden prompt: it stores "" and prints "Success".
 *
 * The old message sent you looking for a missing secret that was sitting
 * right there in the list. A failure that describes the wrong problem is
 * worse than one that says nothing.
 */
export class NullAiModelProvider implements AiModelProvider {
  readonly name = "none";

  constructor(private readonly reason: MissingKeyReason = "ABSENT") {}

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    return {
      available: false,
      outputText: null,
      parsedJson: null,
      modelId: null,
      usage: null,
      error:
        this.reason === "EMPTY"
          ? "OPENAI_API_KEY exists on this Worker but its value is EMPTY. It will appear in `wrangler secret list`, which is misleading — set it again (the Cloudflare dashboard is more reliable than wrangler's hidden prompt, which silently accepts an unpasted value)."
          : "AI provider is not configured — no OPENAI_API_KEY binding exists in this environment.",
      promptVersionId: request.promptVersionId,
    };
  }
}
