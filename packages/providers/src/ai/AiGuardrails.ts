import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiModelProvider,
  HallucinationFlag,
} from "./AiModelProvider.js";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream I (hallucination protections /
 * guardrails).
 *
 * WHY THIS EXISTS: Workstream J wires a real AiModelProvider into a
 * user-facing route (the AI Listing Analyst) for the first time — the
 * first point at which a real-money sourcing decision could be influenced
 * by model output. Per AiModelProvider.ts's own "NEVER A SOURCE OF
 * FINANCIAL NUMBERS" discipline, the deterministic engine's numbers are
 * handed TO the model as read-only context, never computed BY it — this
 * file is the one place that checks the model actually respected that,
 * rather than trusting every response by construction.
 *
 * TWO SEPARATE, DELIBERATELY DIFFERENTLY-TREATED CHECKS (same
 * "corroborate confidently, don't guess" discipline already used by
 * titleParser.ts's identity checks and conditionSignal.ts's condition
 * detection — applied here to AI output instead of eBay listing titles):
 *
 * 1. GROUND_TRUTH_CONTRADICTION — the model's own structured `parsedJson`
 *    restates a fact it was GIVEN (via `request.groundTruthFacts`, the
 *    exact same numbers already woven into `request.input`'s context) as a
 *    DIFFERENT number. This is not a judgement call or a fuzzy heuristic —
 *    it's comparing structured data to structured data, so it's exact and
 *    low-false-positive by construction. A contradiction forces
 *    `available: false`: this app never lets AI override its own
 *    deterministic numbers, so a response that gets one wrong is
 *    definitionally untrustworthy for this call, refused exactly like any
 *    other unavailable result — never handed to a caller as "trust it, but
 *    here's a caveat."
 *
 * 2. UNGROUNDED_FIGURE — a currency/percentage figure appears in the
 *    model's free-text `outputText` that doesn't appear (verbatim) in the
 *    supplied instructions/input, and doesn't numerically match a
 *    ground-truth fact either. This is deliberately NON-blocking: a model
 *    legitimately deriving a new figure from ones it was given (e.g. "that
 *    works out to about 23% below QSV") is normal and useful, not a
 *    hallucination — but it's also exactly the shape a fabricated figure
 *    would take, and this app has no way to tell the two apart from text
 *    alone. Same resolution as the condition-truth/"why is this cheap?"
 *    panels: surface it for a human to verify, never silently decide
 *    either way.
 *
 * COMPOSITION ORDER (important, and deliberate): GuardedAiModelProvider is
 * meant to wrap the OUTERMOST layer of the AI call chain — i.e.
 * `new GuardedAiModelProvider(new AiCompletionCache(db, openAiProvider, opts))`,
 * not the reverse. Every result — freshly-called OR served from
 * AiCompletionCache's D1 cache — is re-validated against the CURRENT
 * request's `groundTruthFacts` on EVERY call, never trusted just because
 * it passed the check (or was cached) before. This means a
 * genuinely-wrong answer CAN still get written into `ai_completion_cache`
 * by the inner Cache layer (Cache has no knowledge of a guard sitting
 * outside it, and doesn't need any — the two layers stay independently
 * testable). That's safe, not a gap: since this check is pure and
 * deterministic, re-running it on a cache hit rejects the bad answer
 * exactly as consistently as the first time, at zero further real-API
 * cost — cheaper than refusing to cache it, and requires no coupling
 * between the two layers.
 */
export class GuardedAiModelProvider implements AiModelProvider {
  readonly name: string;

  constructor(private readonly inner: AiModelProvider) {
    this.name = `guarded(${inner.name})`;
  }

  async complete(request: AiCompletionRequest): Promise<AiCompletionResult> {
    const result = await this.inner.complete(request);

    // Nothing to check against an already-unavailable result (no key, spend
    // cap, network/upstream failure) — pass it through unchanged, only
    // adding the empty flags array so callers can rely on the field always
    // being present once a GuardedAiModelProvider is in the chain.
    if (!result.available) {
      return { ...result, hallucinationFlags: [] };
    }

    const flags: HallucinationFlag[] = [
      ...checkGroundTruthContradictions(result.parsedJson, request.groundTruthFacts),
      ...checkUngroundedFigures(result.outputText, request),
    ];

    const contradiction = flags.find((f) => f.kind === "GROUND_TRUTH_CONTRADICTION");
    if (contradiction) {
      return {
        available: false,
        outputText: null,
        parsedJson: null,
        modelId: result.modelId,
        usage: result.usage,
        error: `Hallucination guardrail rejected this response: ${flags
          .filter((f) => f.kind === "GROUND_TRUTH_CONTRADICTION")
          .map((f) => f.detail)
          .join(" ")}`,
        promptVersionId: result.promptVersionId,
        hallucinationFlags: flags,
      };
    }

    return { ...result, hallucinationFlags: flags };
  }
}

const NUMERIC_TOLERANCE_ABS = 0.01;
const NUMERIC_TOLERANCE_REL = 0.005;

/** Two numbers "match" within a small absolute-or-relative tolerance (1
 *  cent, or 0.5% of the ground-truth value, whichever is larger) — enough
 *  to absorb legitimate floating-point/rounding noise without letting a
 *  genuinely different figure slip through as a match. */
function numbersMatch(claimed: number, truth: number): boolean {
  return Math.abs(claimed - truth) <= Math.max(NUMERIC_TOLERANCE_ABS, Math.abs(truth) * NUMERIC_TOLERANCE_REL);
}

/**
 * Compares the model's structured `parsedJson` against `groundTruthFacts`
 * key-by-key. Only checks a key when BOTH the ground-truth fact and a
 * same-named, numeric field in `parsedJson` exist — a schema that doesn't
 * happen to echo a given fact back isn't a contradiction, and a non-numeric
 * value for that key is skipped rather than crashing (defensive; OpenAI's
 * strict-mode schema conformance should already prevent this, but this
 * function makes no assumption about what produced `parsedJson`).
 */
export function checkGroundTruthContradictions(
  parsedJson: unknown,
  groundTruthFacts: Record<string, number> | undefined,
): HallucinationFlag[] {
  if (!groundTruthFacts || parsedJson === null || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
    return [];
  }
  const obj = parsedJson as Record<string, unknown>;
  const flags: HallucinationFlag[] = [];
  for (const [key, truth] of Object.entries(groundTruthFacts)) {
    if (!(key in obj)) continue;
    const claimed = obj[key];
    if (typeof claimed !== "number" || !Number.isFinite(claimed)) continue;
    if (!numbersMatch(claimed, truth)) {
      flags.push({
        kind: "GROUND_TRUTH_CONTRADICTION",
        detail: `parsedJson."${key}" = ${claimed}, but the value supplied as ground truth was ${truth} — the model restated a fact it was given incorrectly.`,
      });
    }
  }
  return flags;
}

const CURRENCY_FIGURE_PATTERN = /[£$]\s?\d[\d,]*(?:\.\d{1,2})?/g;
const PERCENT_FIGURE_PATTERN = /\d[\d,]*(?:\.\d+)?\s?%/g;

interface ExtractedFigure {
  /** Exact matched substring, e.g. "£45.20" or "23%" — used for verbatim
   *  grounding checks against the supplied text. */
  raw: string;
  value: number;
  kind: "CURRENCY" | "PERCENT";
}

/**
 * Pulls only explicitly currency- or percent-marked figures out of free
 * text — deliberately NOT bare numbers. Same false-positive discipline as
 * conditionSignal.ts's refusal to match bare "HP"/"LP" abbreviations: a
 * bare number in this app's domain is routinely something other than
 * money (a card number "146/144", a PSA grade "9", a set year) and
 * flagging every one of those as an "ungrounded figure" would swamp the
 * genuinely useful signal in noise.
 */
export function extractFiguresFromText(text: string): ExtractedFigure[] {
  const figures: ExtractedFigure[] = [];
  for (const match of text.matchAll(CURRENCY_FIGURE_PATTERN)) {
    const value = Number(match[0].replace(/[£$,\s]/g, ""));
    if (Number.isFinite(value)) figures.push({ raw: match[0], value, kind: "CURRENCY" });
  }
  for (const match of text.matchAll(PERCENT_FIGURE_PATTERN)) {
    const value = Number(match[0].replace(/[%,\s]/g, ""));
    if (Number.isFinite(value)) figures.push({ raw: match[0], value, kind: "PERCENT" });
  }
  return figures;
}

/**
 * Flags any currency/percent figure in `outputText` that is grounded
 * NEITHER verbatim in the supplied instructions/input text NOR (for
 * currency figures only — a ground-truth fact is a plain number, not
 * itself a percentage) numerically in `groundTruthFacts`. Non-blocking by
 * design — see the file doc comment above for why.
 */
export function checkUngroundedFigures(
  outputText: string | null,
  request: Pick<AiCompletionRequest, "instructions" | "input" | "groundTruthFacts">,
): HallucinationFlag[] {
  if (!outputText) return [];
  const context = `${request.instructions}\n${request.input}`;
  const groundTruthValues = Object.values(request.groundTruthFacts ?? {});

  const flags: HallucinationFlag[] = [];
  for (const figure of extractFiguresFromText(outputText)) {
    const verbatimInContext = context.includes(figure.raw);
    const matchesGroundTruthValue =
      figure.kind === "CURRENCY" && groundTruthValues.some((truth) => numbersMatch(figure.value, truth));
    if (!verbatimInContext && !matchesGroundTruthValue) {
      flags.push({
        kind: "UNGROUNDED_FIGURE",
        detail: `Output mentions "${figure.raw}", a figure that doesn't appear in the supplied context or ground-truth facts. May be a legitimate calculation derived from given numbers, or may be fabricated — this app can't tell the two apart from text alone, so verify it before relying on it.`,
      });
    }
  }
  return flags;
}
