/**
 * AI INTELLIGENCE spec, Phase 2 foundation: the generic AI-model-calling
 * interface every AI-layer feature (Listing Analyst, financial auditor,
 * natural-language query interpreter, scenario engine) is built on top of.
 *
 * Mirrors this codebase's existing provider-abstraction pattern
 * (MarketDataProvider, EbayListingsProvider, AiAdvisoryProvider) — nothing
 * that calls an AiModelProvider needs to know or care whether it's talking
 * to OpenAI, a mock, or (later) a different vendor.
 *
 * MODEL-ID CONFIGURABILITY (explicit user requirement): callers never name
 * a literal model id. They ask for a TIER — FAST / DEEP / AUDIT — and the
 * provider maps that to whichever model id is currently configured via
 * AI_FAST_MODEL / AI_DEEP_MODEL / AI_AUDIT_MODEL (see createAiModelProvider.ts).
 * Swapping which model backs a tier is a config change, never a business-
 * logic change, matching the DO-NOT-DO list's "no hidden/silent assumption
 * changes" — the tier names are the stable contract.
 *
 * NO SILENT SUBSTITUTION (explicit user requirement): if a configured model
 * is unavailable/inaccessible, the provider reports that failure honestly
 * (`available: false`, `error` populated with the exact upstream message) —
 * it never falls back to a different model and pretends nothing went
 * wrong. Every caller of `complete()` MUST check `available` before using
 * `outputText`/`parsedJson`, exactly the same discipline
 * NullAiAdvisoryProvider already established for `AiAdvisoryResponse`.
 *
 * NEVER A SOURCE OF FINANCIAL NUMBERS: this interface only relays model
 * output. It performs no arithmetic, invents no comps, and nothing in
 * packages/core ever calls it — the deterministic engine's own numbers
 * (net profit, ROC, QSV, ...) are computed exactly as before Phase 2 and
 * are handed TO the AI layer as read-only context, never the reverse. See
 * AiGuardrails.ts (Workstream I) for how AI output is checked — before it
 * can influence routing — against exactly those numbers.
 */

export type AiModelTier = "FAST" | "DEEP" | "AUDIT";

/** One image attached to an AiCompletionRequest — see its `images` field.
 *  `url` is a direct https URL or a base64 `data:` URL (OpenAI's Responses
 *  API accepts either as `input_image.image_url`, confirmed 2026-09-03).
 *  `detail` mirrors OpenAI's own preprocessing/token-cost knob; omitted
 *  requests default to "auto" at the OpenAiModelProvider layer, never
 *  guessed differently by any other caller. */
export interface AiCompletionImageInput {
  url: string;
  detail?: "low" | "high" | "original" | "auto";
}

/**
 * AI INTELLIGENCE spec Phase 2, Workstream I (hallucination protections /
 * guardrails). Defined here, alongside the request/result shapes they
 * attach to, rather than in AiGuardrails.ts itself — see that file for the
 * checking logic and the GuardedAiModelProvider wrapper that produces
 * these.
 */
export type HallucinationFlagKind = "GROUND_TRUTH_CONTRADICTION" | "UNGROUNDED_FIGURE";

export interface HallucinationFlag {
  kind: HallucinationFlagKind;
  /** Specific and human-readable — which fact was contradicted (and by
   *  what), or the exact figure that couldn't be grounded. Never a generic
   *  "something looked off" message — same discipline as every other
   *  reasoning/caveat string already surfaced elsewhere in this app (e.g.
   *  qualification_failures, the condition-truth panel). */
  detail: string;
}

export interface AiCompletionRequest {
  /** Which configured model tier to use — see the class doc comment above.
   *  FAST = quick/cheap classification-style calls (e.g. per-listing
   *  routing signal). DEEP = higher-reasoning calls (e.g. the Listing
   *  Analyst's narrative). AUDIT = the financial-auditor/consistency-check
   *  role, deliberately kept separate so its own cost/rate budget never
   *  competes with routine FAST/DEEP traffic. */
  tier: AiModelTier;
  /** System-level instructions — the persona/constraints, never user data. */
  instructions: string;
  /** The actual request content — card/listing/economics context, always
   *  built from data the caller already has (deterministic output, listing
   *  text), never free user input passed through unvalidated. */
  input: string;
  /** AI INTELLIGENCE gap 2 (multimodal Listing Analyst): optional images to
   *  attach alongside `input`'s text — e.g. a listing's own eBay photos.
   *  Omit (or an empty array) for a text-only request; every existing
   *  caller/provider continues to work completely unchanged. When present,
   *  OpenAiModelProvider sends these as real Responses API `input_image`
   *  content items (not merely described in text) — see its doc comment.
   *  Never a source of financial numbers any more than text input is: this
   *  is read-only visual evidence handed to the model, exactly like the
   *  read-only textual context already passed via `input`. */
  images?: AiCompletionImageInput[];
  /** When set, the model is constrained to this JSON Schema (OpenAI
   *  structured outputs, `strict: true`) and a successful response's
   *  `parsedJson` is guaranteed to match it — no regex-scraping of free
   *  text for anything a caller intends to act on programmatically. */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  maxOutputTokens?: number;
  /** Stable id (see promptVersioning.ts, Workstream H) identifying which
   *  prompt template produced `instructions`/`input` — carried through to
   *  AiCompletionResult so a caller can record which version produced a
   *  given stored answer. Purely a label; providers don't interpret it. */
  promptVersionId?: string;
  /** Known-true numeric facts — e.g. {netProfit: 45.2, qsv: 62} — computed
   *  by packages/core and already woven into `input`'s context text. NOT
   *  sent to the model as extra data (see OpenAiModelProvider.ts's request
   *  body — this field never appears in it); used ONLY by
   *  GuardedAiModelProvider (AiGuardrails.ts, Workstream I) to verify the
   *  model's own output never restates one of these numbers differently
   *  from what it was actually given. Omit for a request with no
   *  ground-truth numbers worth checking (e.g. a purely qualitative ask). */
  groundTruthFacts?: Record<string, number>;
}

export interface AiCompletionUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiCompletionResult {
  /** false whenever no trustworthy model output exists — missing key,
   *  network failure, upstream error, or an unavailable/inaccessible
   *  model. Callers MUST check this before reading outputText/parsedJson. */
  available: boolean;
  /** Raw text output, or null when unavailable. */
  outputText: string | null;
  /** Present only when the request set `responseSchema` AND the model
   *  returned schema-conformant output. Null otherwise — never a best-
   *  effort parse of free text. */
  parsedJson: unknown | null;
  /** The actual model id used (e.g. "gpt-5.6-luna") — surfaced so a caller
   *  or log can see exactly what answered, not just which tier was asked
   *  for. Null when unavailable before a model could even be selected. */
  modelId: string | null;
  usage: AiCompletionUsage | null;
  /** The exact upstream error message when available is false — e.g.
   *  OpenAI's own `error.message`/`error.code`, or a local reason
   *  ("no API key configured"). Never paraphrased or swallowed, per the
   *  "report the exact error, don't substitute silently" requirement. */
  error: string | null;
  promptVersionId?: string;
  /** Populated only by GuardedAiModelProvider (AiGuardrails.ts, Workstream
   *  I) — absent (undefined) means no guardrail wrapper was in the call
   *  chain, NOT "checked and clean". An empty array means checked and
   *  nothing found. See that file for what each flag kind means and why a
   *  GROUND_TRUTH_CONTRADICTION forces `available: false`. */
  hallucinationFlags?: HallucinationFlag[];
}

export interface AiModelProvider {
  readonly name: string;
  complete(request: AiCompletionRequest): Promise<AiCompletionResult>;
}
