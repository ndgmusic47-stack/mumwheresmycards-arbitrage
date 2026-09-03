import type { AiModelProvider } from "./AiModelProvider.js";
import { NullAiModelProvider } from "./NullAiModelProvider.js";
import { OpenAiModelProvider } from "./OpenAiModelProvider.js";

/**
 * Real, current OpenAI model ids for the three configured tiers — verified
 * live against developer.openai.com during this spec's own planning phase
 * (GPT-5.6 family: Sol = flagship/AUDIT, Terra = balanced/DEEP, Luna =
 * cost-efficient/FAST). These are DEFAULTS only, used when the
 * corresponding env var isn't set — see the user's own explicit
 * instruction: "Implement them through configuration/environment variables
 * exactly as specified, not hardcoded throughout the application." Every
 * other file in this codebase reaches a model id through
 * createAiModelProvider()/AiModelTier, never these constants directly.
 */
export const DEFAULT_AI_FAST_MODEL = "gpt-5.6-luna";
export const DEFAULT_AI_DEEP_MODEL = "gpt-5.6-terra";
export const DEFAULT_AI_AUDIT_MODEL = "gpt-5.6-sol";

export interface AiProviderEnvConfig {
  OPENAI_API_KEY?: string;
  AI_FAST_MODEL?: string;
  AI_DEEP_MODEL?: string;
  AI_AUDIT_MODEL?: string;
  AI_BASE_URL?: string;
}

/**
 * The one place an `AiModelProvider` gets constructed. No OPENAI_API_KEY
 * configured -> NullAiModelProvider (every AI feature degrades to
 * "unavailable", nothing crashes, nothing silently calls a real API this
 * project isn't ready to pay for) — this is what every environment does
 * today, since no key has been added yet (per the user's own "test later"
 * decision). A key present -> a real OpenAiModelProvider, model ids read
 * from env with the confirmed-real GPT-5.6 defaults above as fallback.
 */
export function createAiModelProvider(env: AiProviderEnvConfig, fetchImpl?: typeof fetch): AiModelProvider {
  if (!env.OPENAI_API_KEY) {
    return new NullAiModelProvider();
  }
  return new OpenAiModelProvider({
    apiKey: env.OPENAI_API_KEY,
    fastModel: env.AI_FAST_MODEL ?? DEFAULT_AI_FAST_MODEL,
    deepModel: env.AI_DEEP_MODEL ?? DEFAULT_AI_DEEP_MODEL,
    auditModel: env.AI_AUDIT_MODEL ?? DEFAULT_AI_AUDIT_MODEL,
    baseUrl: env.AI_BASE_URL,
    fetchImpl,
  });
}
