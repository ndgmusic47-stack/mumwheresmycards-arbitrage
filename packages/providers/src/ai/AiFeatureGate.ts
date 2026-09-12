import type { AiModelProvider, AiCompletionRequest, AiCompletionResult } from "./AiModelProvider.js";

/**
 * PER-FEATURE ON/OFF FOR EVERY AI CALL IN THE APPLICATION.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS HAS TO EXIST. Until now the only thing gating AI in this codebase
 * was the presence of OPENAI_API_KEY, plus a shared daily spend cap. That is
 * an all-or-nothing switch: setting the key turns on FIVE features at once,
 * including one — the candidate router — that runs automatically on every
 * scan and REMOVES ROWS from the operator's actionable feed.
 *
 * An operator who wants one AI feature should not have to accept five, and
 * should certainly not have their working list silently filtered as a side
 * effect of enabling something unrelated.
 *
 * WHAT THIS DELIBERATELY IS NOT: deletion. Every feature's code, prompt,
 * schema and tests stay exactly where they are. A disabled feature is a
 * settings row set to false, reversible in one edit, with no redeploy and no
 * code change. Ripping the code out would make turning it back on a
 * rebuild-and-retest job rather than a decision.
 *
 * HOW IT FAILS: closed, and honestly. A disabled feature never reaches the
 * model — no request is built, no token is spent, no cache row is written —
 * and the caller gets the same `available: false` shape it already handles
 * for a missing key, with an `error` that says plainly which switch is off.
 * Every existing caller already checks `available` before reading output
 * (the discipline AiModelProvider's own doc comment established), so nothing
 * downstream needs to learn a new failure mode.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Every distinct place this application calls a model.
 *
 * Keyed by what the feature DOES rather than by which class implements it,
 * so a refactor cannot silently orphan a switch.
 */
export const AI_FEATURES = [
  /** Pre-grade photo assessment — reads a listing's photographs. On demand. */
  "photoAssessment",
  /** Automatic per-candidate routing opinion during a scan. THIS ONE FILTERS
   *  THE ACTIONABLE FEED, which is why it is off by default. */
  "candidateReview",
  /** The "Check AI advisory" button on a card's detail page. */
  "listingAdvisory",
  /** The natural-language filter box. */
  "queryInterpreter",
  /** The reconciliation page's consistency auditor. */
  "financialAuditor",
  /** Optional prose narration of a what-if scenario. */
  "scenarioNarrator",
] as const;

export type AiFeature = (typeof AI_FEATURES)[number];

export type AiFeatureSwitches = Record<AiFeature, boolean>;

/**
 * DEFAULTS: everything off except the photo assessment.
 *
 * The asymmetry is deliberate and reflects what each feature costs when it
 * is wrong. The photo check is on-demand, returns evidence the operator
 * reads with their own judgement, and changes nothing they did not ask it
 * to. The other five either run automatically, alter what the operator is
 * shown, or narrate numbers that are already correct without them.
 *
 * A new feature added to AI_FEATURES and not listed here resolves to FALSE
 * (see `resolveFeatureSwitches`) — a feature must be switched on
 * deliberately, never by being forgotten.
 */
export const DEFAULT_AI_FEATURE_SWITCHES: AiFeatureSwitches = {
  photoAssessment: true,
  candidateReview: false,
  listingAdvisory: false,
  queryInterpreter: false,
  financialAuditor: false,
  scenarioNarrator: false,
};

/** Human-readable, used in the `error` a disabled feature returns. */
export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  photoAssessment: "Photo check",
  candidateReview: "AI candidate review",
  listingAdvisory: "AI listing advisory",
  queryInterpreter: "Natural-language search",
  financialAuditor: "AI financial auditor",
  scenarioNarrator: "AI scenario narration",
};

/**
 * Normalises whatever is in the settings row into a complete switch map.
 *
 * Anything absent, or not a real boolean, falls back to the default for that
 * feature — a malformed stored value can never accidentally switch a feature
 * ON, because the fallback for everything except the photo check is false.
 */
export function resolveFeatureSwitches(stored: unknown): AiFeatureSwitches {
  const source = (stored ?? {}) as Record<string, unknown>;
  const resolved = {} as AiFeatureSwitches;
  for (const feature of AI_FEATURES) {
    const value = source[feature];
    resolved[feature] = typeof value === "boolean" ? value : DEFAULT_AI_FEATURE_SWITCHES[feature];
  }
  return resolved;
}

/**
 * Wraps a model provider so that one named feature's calls are refused
 * before they are made.
 *
 * Placed OUTSIDE the caching/guardrail wrappers at every call site, so a
 * disabled feature never touches the cache, never records usage, and never
 * counts against the daily spend cap — because it never happens.
 */
export class FeatureGatedAiModelProvider implements AiModelProvider {
  readonly name: string;

  constructor(
    private readonly inner: AiModelProvider,
    private readonly feature: AiFeature,
    private readonly switches: AiFeatureSwitches,
  ) {
    this.name = `gated:${feature}(${inner.name})`;
  }

  get enabled(): boolean {
    return this.switches[this.feature] === true;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    if (!this.enabled) {
      return {
        available: false,
        outputText: null,
        parsedJson: null,
        modelId: null,
        usage: null,
        error: `${AI_FEATURE_LABELS[this.feature]} is switched off in Settings (ai_settings.features.${this.feature}). No model was called and nothing was spent.`,
      };
    }
    return this.inner.complete(request);
  }
}
