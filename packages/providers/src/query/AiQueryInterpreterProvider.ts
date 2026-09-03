import type { AiModelProvider } from "../ai/AiModelProvider.js";
import { definePromptTemplate, buildAiRequest } from "../ai/promptVersioning.js";
import type {
  QueryInterpreterProvider,
  QueryInterpretationRequest,
  QueryInterpretationResponse,
  InterpretedOpportunityFilters,
} from "./QueryInterpreterProvider.js";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream L: the real
 * `QueryInterpreterProvider` implementation. Wraps a fully-assembled
 * provider chain (created by the caller — see
 * apps/worker/src/routes/queryInterpreter.ts — as
 * `createAiModelProvider(env)` (Workstream F) -> `AiCompletionCache`
 * (Workstream G) -> `GuardedAiModelProvider` (Workstream I)), same
 * composition Workstream J's `AiListingAnalystProvider` uses. When no
 * `OPENAI_API_KEY` is configured, `createAiModelProvider` still returns a
 * `NullAiModelProvider`, so this class degrades to the same honest
 * `available: false` shape every other AI feature in this app uses — this
 * class is never itself the thing deciding whether AI is "on."
 *
 * TIER CHOICE: FAST, not DEEP. Per `AiModelProvider.ts`'s own tier doc
 * comment, FAST is for "quick/cheap classification-style calls (e.g.
 * per-listing routing signal)" — mapping a short sentence onto a dozen
 * fixed, pre-named fields is exactly that shape of task, not the
 * higher-reasoning narrative work Workstream J's DEEP tier exists for.
 *
 * WHY THIS ISN'T A GROUND-TRUTH-CONTRADICTION CANDIDATE: unlike Workstream
 * J (which grounds a response against this app's own already-computed
 * economics numbers), there is no pre-existing "true" value for what
 * filter thresholds a user wants — their own query text IS the source of
 * truth. `GuardedAiModelProvider` is still kept in the chain for the same
 * honest-degradation behaviour and defense in depth, but no
 * `groundTruthFacts` are set on this request. What this file adds INSTEAD
 * is its own guardrail, `sanitizeInterpretedFilters()`: never trust a
 * numeric/enum value from the model without re-validating it against the
 * exact same bounds a human typing into the filter UI would be held to —
 * a model returning `minConfidence: 4` (not a valid 0-1 fraction) or
 * `category: "URGENT"` (not a real category) gets that field DROPPED, with
 * a caveat explaining why, never silently passed through to the filter
 * pipeline as-is.
 */
interface QueryInterpreterVars {
  queryText: string;
}

const INSTRUCTIONS = [
  "You are a query interpreter for a Pokémon card sourcing tool that finds underpriced raw-card flips (FLIP) and raw-to-graded arbitrage (GRADE) opportunities on eBay.",
  "Your ONLY job is to translate the user's plain-English request into a FIXED set of named filter fields, each with a fixed meaning and unit. Never invent a field that isn't in this list, and never invent a value the user didn't state or clearly imply — leave a field null if the query doesn't mention it.",
  [
    "The fixed fields, with their exact meaning and unit:",
    '- category: one of "ALL", "ACTIONABLE" (qualified flips/grades, the default view), "REVIEW" (needs a human photo check), "NEAR_MISS" (real economics, just below the qualifying bar), "REJECTED" (no market data or uncertain identity — always empty by design, mention this if asked for).',
    '- strategy: one of "ALL", "FLIP", "GRADE".',
    "- auctionsOnly: true if the user specifically wants only auction-format listings.",
    "- minNetProfit: minimum net profit in GBP (a plain number, e.g. 40 for \"£40\").",
    '- minReturnOnCapital: minimum return on capital as a FRACTION, e.g. 0.4 for "40% ROC" (never 40).',
    '- minMargin: minimum profit margin as a FRACTION of the buyer\'s total payment, e.g. 0.3 for "30% margin" (never 30). FLIP only — this app has no single "margin" figure for a GRADE ladder.',
    "- maxAcquisitionCost: maximum total acquisition cost (price + postage + fees) in GBP.",
    "- minQsv: minimum quick sale value reference in GBP (FLIP only).",
    '- minLiquidity: one of "LOW", "MEDIUM", "HIGH", "VERY_HIGH".',
    '- minConfidence: minimum data confidence as a FRACTION 0-1, e.g. 0.6 for "60% confidence" (never 60).',
    "- maxTotalGradedBasis: maximum total graded-cost basis in GBP (GRADE only).",
    "- minPsa10Profit: minimum PSA10-outcome profit in GBP (GRADE only).",
    "- minPsa9Profit: minimum PSA9-outcome profit in GBP (GRADE only).",
    "- maxBreakEvenGrade: worst acceptable break-even PSA grade, an integer 1-10 (GRADE only).",
  ].join("\n"),
  "Never compute, estimate, or invent a card price, profit figure, or economics number yourself — you are only mapping numbers the USER stated onto this fixed schema, never producing new ones.",
  'Always fill "explanation" with a short (1-2 sentence) plain-English restatement of what you understood, so the user can see and correct it. Use "caveats" for anything ambiguous, unsupported, or that you deliberately left out. Set "unrecognizedIntent" true (and explain why in caveats) only if the query is clearly NOT about filtering/searching sourcing opportunities at all (e.g. a completely unrelated question) — for genuine but vague filtering requests, do your best and explain the gap instead.',
].join("\n\n");

function renderQueryInterpreterInput(vars: QueryInterpreterVars): string {
  return `User's request: "${vars.queryText}"`;
}

export const QUERY_INTERPRETER_TEMPLATE = definePromptTemplate<QueryInterpreterVars>({
  id: "query_interpreter",
  version: 2,
  description:
    "AI INTELLIGENCE Workstream L — translates a natural-language sourcing request into DashboardFilters' own fixed field set. v2 (gap 4, 2026-09-03): added minMargin.",
  render: (vars) => ({
    instructions: INSTRUCTIONS,
    input: renderQueryInterpreterInput(vars),
  }),
});

const NULLABLE_STRING_ENUM = (values: readonly string[]) => ({
  type: ["string", "null"] as const,
  enum: [...values, null],
});
const NULLABLE_NUMBER = { type: ["number", "null"] as const };
const NULLABLE_BOOLEAN = { type: ["boolean", "null"] as const };

const RESPONSE_SCHEMA = {
  name: "query_interpretation",
  schema: {
    type: "object",
    properties: {
      category: NULLABLE_STRING_ENUM(["ALL", "ACTIONABLE", "REVIEW", "NEAR_MISS", "REJECTED"]),
      strategy: NULLABLE_STRING_ENUM(["ALL", "FLIP", "GRADE"]),
      auctionsOnly: NULLABLE_BOOLEAN,
      minNetProfit: NULLABLE_NUMBER,
      minReturnOnCapital: NULLABLE_NUMBER,
      minMargin: NULLABLE_NUMBER,
      maxAcquisitionCost: NULLABLE_NUMBER,
      minQsv: NULLABLE_NUMBER,
      minLiquidity: NULLABLE_STRING_ENUM(["LOW", "MEDIUM", "HIGH", "VERY_HIGH"]),
      minConfidence: NULLABLE_NUMBER,
      maxTotalGradedBasis: NULLABLE_NUMBER,
      minPsa10Profit: NULLABLE_NUMBER,
      minPsa9Profit: NULLABLE_NUMBER,
      maxBreakEvenGrade: NULLABLE_NUMBER,
      explanation: { type: "string", description: "1-2 sentence plain-English restatement of what was understood." },
      caveats: { type: "array", items: { type: "string" } },
      unrecognizedIntent: {
        type: "boolean",
        description: "true only if the query is clearly not about filtering/searching sourcing opportunities at all.",
      },
    },
    required: [
      "category",
      "strategy",
      "auctionsOnly",
      "minNetProfit",
      "minReturnOnCapital",
      "minMargin",
      "maxAcquisitionCost",
      "minQsv",
      "minLiquidity",
      "minConfidence",
      "maxTotalGradedBasis",
      "minPsa10Profit",
      "minPsa9Profit",
      "maxBreakEvenGrade",
      "explanation",
      "caveats",
      "unrecognizedIntent",
    ],
    additionalProperties: false,
  },
} as const;

const MAX_OUTPUT_TOKENS = 400;

const VALID_CATEGORIES = new Set(["ALL", "ACTIONABLE", "REVIEW", "NEAR_MISS", "REJECTED"]);
const VALID_STRATEGIES = new Set(["ALL", "FLIP", "GRADE"]);
const VALID_LIQUIDITY = new Set(["LOW", "MEDIUM", "HIGH", "VERY_HIGH"]);
/** Sanity ceiling for any single GBP figure the model returns — well above
 *  any real listing this app has ever seen, purely to stop a wildly
 *  malformed value (e.g. a units mistake) reaching the filter UI/SQL as-is. */
const MAX_SANE_GBP = 1_000_000;

/**
 * Re-validates every field of a raw parsed-JSON response against the exact
 * bounds a human using the filter UI is held to, BEFORE it's trusted as an
 * `InterpretedOpportunityFilters`. A field failing its check is dropped
 * (never clamped to a nearby "close enough" value — a wrong unit or a
 * malformed enum is a sign the model misunderstood the query, not a
 * rounding error to paper over) and a caveat explaining the drop is
 * appended. Exported and pure so it's independently testable without a
 * live model call — see AiQueryInterpreterProvider's own doc comment for
 * why this exists instead of (or alongside) GuardedAiModelProvider.
 */
export function sanitizeInterpretedFilters(raw: Record<string, unknown>): {
  filters: InterpretedOpportunityFilters;
  droppedFieldCaveats: string[];
} {
  const filters: InterpretedOpportunityFilters = {};
  const droppedFieldCaveats: string[] = [];

  const dropped = (field: string, reason: string) => {
    droppedFieldCaveats.push(`Ignored the model's "${field}" value — ${reason}.`);
  };

  const category = raw.category;
  if (category !== null && category !== undefined) {
    if (typeof category === "string" && VALID_CATEGORIES.has(category)) {
      filters.category = category as InterpretedOpportunityFilters["category"];
    } else {
      dropped("category", `"${String(category)}" is not a real category`);
    }
  }

  const strategy = raw.strategy;
  if (strategy !== null && strategy !== undefined) {
    if (typeof strategy === "string" && VALID_STRATEGIES.has(strategy)) {
      filters.strategy = strategy as InterpretedOpportunityFilters["strategy"];
    } else {
      dropped("strategy", `"${String(strategy)}" is not a real strategy`);
    }
  }

  const auctionsOnly = raw.auctionsOnly;
  if (auctionsOnly !== null && auctionsOnly !== undefined) {
    if (typeof auctionsOnly === "boolean") {
      filters.auctionsOnly = auctionsOnly;
    } else {
      dropped("auctionsOnly", "not a true/false value");
    }
  }

  const minLiquidity = raw.minLiquidity;
  if (minLiquidity !== null && minLiquidity !== undefined) {
    if (typeof minLiquidity === "string" && VALID_LIQUIDITY.has(minLiquidity)) {
      filters.minLiquidity = minLiquidity as InterpretedOpportunityFilters["minLiquidity"];
    } else {
      dropped("minLiquidity", `"${String(minLiquidity)}" is not a real liquidity level`);
    }
  }

  const positiveGbp = (field: keyof InterpretedOpportunityFilters, value: unknown) => {
    if (value === null || value === undefined) return;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_SANE_GBP) {
      dropped(field, "not a plausible non-negative £ amount");
      return;
    }
    (filters[field] as number) = value;
  };
  positiveGbp("minNetProfit", raw.minNetProfit);
  positiveGbp("maxAcquisitionCost", raw.maxAcquisitionCost);
  positiveGbp("minQsv", raw.minQsv);
  positiveGbp("maxTotalGradedBasis", raw.maxTotalGradedBasis);
  positiveGbp("minPsa10Profit", raw.minPsa10Profit);
  positiveGbp("minPsa9Profit", raw.minPsa9Profit);

  const fraction = (field: "minReturnOnCapital" | "minConfidence" | "minMargin", value: unknown, max: number) => {
    if (value === null || value === undefined) return;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
      dropped(field, `expected a fraction between 0 and ${max}`);
      return;
    }
    filters[field] = value;
  };
  // ROC is genuinely unbounded above in principle (a great flip can clear
  // several hundred percent), but a bare value like 40 or 60 — almost
  // certainly meant as "40%"/"60%" — is far more likely a units mistake
  // (the model returning a percentage instead of the fraction the schema
  // asks for) than a real 4,000%/6,000% ROC threshold. 20 (2,000% ROC) is
  // chosen as a ceiling generous enough never to reject a real threshold a
  // human would actually type, while still catching that common mistake.
  fraction("minReturnOnCapital", raw.minReturnOnCapital, 20);
  // Confidence is a genuine 0-1 probability-like figure — no legitimate
  // value exceeds 1.
  fraction("minConfidence", raw.minConfidence, 1);
  // Margin (net profit / buyer payment) is normally well under 1, but a
  // deeply discounted acquisition can genuinely clear 100%+ — same
  // percent-vs-fraction guard as minReturnOnCapital, with a tighter ceiling
  // since margin is bounded by the sale price in a way ROC on capital isn't.
  fraction("minMargin", raw.minMargin, 5);

  const maxBreakEvenGrade = raw.maxBreakEvenGrade;
  if (maxBreakEvenGrade !== null && maxBreakEvenGrade !== undefined) {
    if (
      typeof maxBreakEvenGrade === "number" &&
      Number.isInteger(maxBreakEvenGrade) &&
      maxBreakEvenGrade >= 1 &&
      maxBreakEvenGrade <= 10
    ) {
      filters.maxBreakEvenGrade = maxBreakEvenGrade;
    } else {
      dropped("maxBreakEvenGrade", "not a whole PSA grade between 1 and 10");
    }
  }

  return { filters, droppedFieldCaveats };
}

export class AiQueryInterpreterProvider implements QueryInterpreterProvider {
  readonly name = "query-interpreter";

  constructor(private readonly modelProvider: AiModelProvider) {}

  async interpretQuery(request: QueryInterpretationRequest): Promise<QueryInterpretationResponse> {
    const completionRequest = buildAiRequest(
      QUERY_INTERPRETER_TEMPLATE,
      { queryText: request.queryText },
      { tier: "FAST", responseSchema: RESPONSE_SCHEMA, maxOutputTokens: MAX_OUTPUT_TOKENS },
    );

    const result = await this.modelProvider.complete(completionRequest);

    if (!result.available) {
      return {
        available: false,
        filters: null,
        explanation: null,
        caveats: [result.error ?? "AI query interpretation is currently unavailable."],
      };
    }

    const parsed = (result.parsedJson ?? {}) as Record<string, unknown>;
    const { filters, droppedFieldCaveats } = sanitizeInterpretedFilters(parsed);
    const modelCaveats = Array.isArray(parsed.caveats) ? parsed.caveats.filter((c): c is string => typeof c === "string") : [];
    const explanation = typeof parsed.explanation === "string" ? parsed.explanation : null;
    const unrecognizedIntent = parsed.unrecognizedIntent === true;
    // UNGROUNDED_FIGURE flags don't apply here in practice (every numeric
    // value lives in a schema-typed field, never free text with a £/$/%
    // character), but the guardrail wrapper is still in the chain for
    // honest-degradation/defense-in-depth — surface anything it did flag
    // rather than silently drop it, same treatment as Workstream J.
    const guardrailCaveats = (result.hallucinationFlags ?? []).filter((f) => f.kind === "UNGROUNDED_FIGURE").map((f) => f.detail);

    // RELEASE HARDENING 2026-09-03 (honesty/failure-state fix, per spec item
    // 4 — NOT a smarter interpreter, just an honest one): a query can be
    // genuinely ABOUT filtering (unrecognizedIntent stays false — the model
    // shouldn't lie about that either) while still not containing anything
    // concrete to act on, e.g. "make the filters less harsh" — no threshold,
    // no direction of any specific field. sanitizeInterpretedFilters() only
    // ever adds a key for a value it could validate, so `filters` here is an
    // EMPTY object in exactly that case — and an empty object is truthy in
    // JS, so callers checking `if (filters)` would previously go ahead and
    // "apply" a no-op change while still telling the user something was
    // applied. Collapsing it to `null` here (the same value already used for
    // unrecognizedIntent) means every caller's existing "no filters" branch
    // handles this case too, honestly, with no new response shape needed.
    const hasConcreteFilters = Object.keys(filters).length > 0;

    return {
      available: true,
      filters: unrecognizedIntent || !hasConcreteFilters ? null : filters,
      explanation,
      caveats: [...modelCaveats, ...droppedFieldCaveats, ...guardrailCaveats],
    };
  }
}
