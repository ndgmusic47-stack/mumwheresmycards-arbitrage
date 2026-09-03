import type { AiCompletionResult } from "../ai/AiModelProvider.js";
import type { AiAdvisoryRequest, AiAdvisoryResponse } from "./AiAdvisoryProvider.js";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream K (evaluation harness — 20
 * fixture cases).
 *
 * WHY THIS EXISTS, AND HOW IT'S DIFFERENT FROM
 * aiListingAnalystProvider.test.ts's hand-written unit tests: those pin
 * down individual behavioural CONTRACTS (how groundTruthFacts get built,
 * how a rejection nulls content, etc.) against minimal synthetic stubs.
 * This file is a single, reviewable TABLE of realistic scenarios — the
 * spread of card/strategy/economics shapes this app's real catalogue
 * actually produces — each with STRUCTURAL (never exact-wording)
 * expectations, so the exact same fixture set can be run two ways:
 *
 * 1. CI-safe, deterministic, free: `listingAnalystEvalHarness.test.ts`
 *    runs every fixture through a scripted fake `AiModelProvider` built
 *    from its own `mockCompletion`, and asserts every fixture passes its
 *    own expectations — a permanent regression guard.
 * 2. Manual, against a real account, once a key is live:
 *    `apps/worker/scripts/listing-analyst-eval.ts` runs only the
 *    `liveSafe` fixtures (see below) through the REAL provider chain and
 *    prints a report for a human to read — this is what actually
 *    "evaluates the Listing Analyst's real behaviour" per this
 *    workstream's own name, something no amount of mocked unit testing
 *    can do.
 *
 * LIVESAFE vs NOT: a fixture is `liveSafe: true` when its expectations are
 * purely structural (a non-empty summary, the standing caveat present,
 * `available: true`) — safe to check against whatever a real model
 * actually says, since nothing pins down its exact wording. A fixture is
 * `liveSafe: false` when it exists specifically to prove the pipeline
 * (almost always the Workstream I guardrail) reacts correctly to a SPECIFIC
 * model response a real model can't be relied on to reliably reproduce on
 * demand (e.g. "the model contradicts a given fact") — these always carry
 * their own scripted `mockCompletion` and are never run against a live
 * account.
 */
export interface FixtureExpectations {
  available: boolean;
  /** Only meaningful when `available: true`. */
  summaryNonEmpty?: boolean;
  /** Every one of these substrings must appear in at least one caveat. */
  caveatsInclude?: string[];
  /** Only meaningful when `available: false` — a substring the sole
   *  unavailable-reason caveat must contain. */
  errorContains?: string;
}

export interface ListingAnalystFixture {
  name: string;
  description: string;
  request: AiAdvisoryRequest;
  liveSafe: boolean;
  /** Required when liveSafe is false; must be omitted when liveSafe is
   *  true (a live run supplies a real response instead — see
   *  listing-analyst-eval.ts). */
  mockCompletion?: AiCompletionResult;
  expect: FixtureExpectations;
}

const STANDING_CAVEAT_SUBSTRING = "this app's own deterministic pricing";

function flipRequest(overrides: Partial<AiAdvisoryRequest> = {}): AiAdvisoryRequest {
  return {
    opportunityId: "opp-flip-1",
    cardName: "Charizard ex 199/197",
    strategy: "FLIP",
    listingTitle: "Charizard ex 199/197 Obsidian Flames raw NM",
    listingPrice: 118,
    totalAcquisitionCost: 128,
    reasoning: ["QSV covers acquisition cost with margin to spare", "Seller feedback is strong (99.6%, 4,200+ ratings)"],
    economicsFacts: { qsv: 190, expectedNetProfit: 46.5, returnOnCapital: 0.36, profitMargin: 0.25 },
    ...overrides,
  };
}

function gradeRequest(overrides: Partial<AiAdvisoryRequest> = {}): AiAdvisoryRequest {
  return {
    opportunityId: "opp-grade-1",
    cardName: "Mewtwo VSTAR 216/196",
    strategy: "GRADE",
    listingTitle: "Mewtwo VSTAR 216/196 raw NM",
    listingPrice: 32,
    totalAcquisitionCost: 39,
    reasoning: ["PSA9/PSA10 ladder clears required hit rate", "Break-even grade: PSA 7"],
    economicsFacts: { totalGradedBasis: 104, psa9Profit: 61, psa10Profit: 310, profitPerCapitalDay: 0.42 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// liveSafe fixtures (12) — realistic scenarios, structural expectations only.
// ---------------------------------------------------------------------------

const LIVE_SAFE_FIXTURES: ListingAnalystFixture[] = [
  {
    name: "flip_strong_margin",
    description: "FLIP with a comfortable margin above the £40/40% bar — the common qualifying case.",
    request: flipRequest(),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "flip_thin_margin",
    description: "FLIP that only just clears the qualification bar.",
    request: flipRequest({
      opportunityId: "opp-flip-2",
      totalAcquisitionCost: 150,
      economicsFacts: { qsv: 191, expectedNetProfit: 41.2, returnOnCapital: 0.41, profitMargin: 0.09 },
    }),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "flip_auction_listing",
    description: "FLIP sourced from an AUCTION listing — reasoning mentions bid/max-bid dynamics.",
    request: flipRequest({
      opportunityId: "opp-flip-3",
      listingTitle: "Charizard ex 199/197 — AUCTION, 4 bids, 6h remaining",
      reasoning: ["Current bid £84, computed max bid £121 — room to bid further and still qualify"],
    }),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "flip_no_economics_facts",
    description: "FLIP request with economicsFacts entirely absent — the canary field is still added, nothing crashes.",
    request: flipRequest({ opportunityId: "opp-flip-4", economicsFacts: undefined }),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "grade_strong_ladder",
    description: "GRADE with a healthy PSA9/PSA10 profit ladder — the common qualifying GRADE case.",
    request: gradeRequest(),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "grade_thin_asymmetric",
    description: "GRADE classified ASYMMETRIC — no PSA8/9 profitability, PSA10 alone carries it.",
    request: gradeRequest({
      opportunityId: "opp-grade-2",
      reasoning: ["Economic class: ASYMMETRIC — PSA10 required for profit, PSA7-9 all break even or worse"],
      economicsFacts: { totalGradedBasis: 95, psa9Profit: -4, psa10Profit: 340 },
    }),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "grade_break_even_high",
    description: "GRADE with a high break-even grade — most of the ladder loses money.",
    request: gradeRequest({
      opportunityId: "opp-grade-3",
      reasoning: ["Break-even grade: PSA 9 — only PSA9/PSA10 clear cost, higher risk than typical"],
    }),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "flip_condition_flagged",
    description: "FLIP where the engine's own reasoning flags a non-near-mint condition claim in the title.",
    request: flipRequest({
      opportunityId: "opp-flip-5",
      listingTitle: "Charizard ex 199/197 — Lightly Played",
      reasoning: ["Listing title claims 'Lightly Played' — this app's economics still assume near-mint condition"],
    }),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "flip_low_confidence_qsv",
    description: "FLIP whose QSV reference is a low-confidence single-median fallback, not the usual dual-median.",
    request: flipRequest({
      opportunityId: "opp-flip-6",
      reasoning: ["QSV based on 7-day median only (30-day median unavailable) — lower confidence than usual"],
    }),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "grade_low_liquidity",
    description: "GRADE with a thin comparable-sale sample flagged in reasoning.",
    request: gradeRequest({
      opportunityId: "opp-grade-4",
      reasoning: ["Comp sample size is small (liquidity: LOW) — reference prices carry more uncertainty than usual"],
    }),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "flip_long_reasoning",
    description: "FLIP with an unusually long reasoning list — stresses the input-text formatting, not just typical 1-2 line cases.",
    request: flipRequest({
      opportunityId: "opp-flip-7",
      reasoning: [
        "QSV covers acquisition cost with margin to spare",
        "Seller feedback is strong (99.6%, 4,200+ ratings)",
        "Listing photos show all four corners and both sides clearly",
        "No condition claim detected in the title",
        "Card printing confirmed via name + set + card number corroboration",
        "eBay itemCondition is 'Ungraded' — consistent with a raw single",
      ],
    }),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
  {
    name: "flip_unknown_card_name",
    description: "FLIP where the card join failed and cardName fell back to 'Unknown card' — must not crash the prompt.",
    request: flipRequest({ opportunityId: "opp-flip-8", cardName: "Unknown card" }),
    liveSafe: true,
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
];

// ---------------------------------------------------------------------------
// Mock-only fixtures (8) — prove the pipeline (mostly the Workstream I
// guardrail) reacts correctly to a SPECIFIC scripted response.
// ---------------------------------------------------------------------------

const MOCK_ONLY_FIXTURES: ListingAnalystFixture[] = [
  {
    name: "contradiction_net_profit",
    description: "Model's structured output restates a ground-truth economics figure with a different number — must be rejected.",
    request: flipRequest({ opportunityId: "opp-mock-1" }),
    liveSafe: false,
    mockCompletion: {
      available: true,
      outputText: JSON.stringify({ summary: "Strong flip, ~£300 profit.", caveats: [], statedTotalAcquisitionCost: 128 }),
      parsedJson: { summary: "Strong flip, ~£300 profit.", caveats: [], statedTotalAcquisitionCost: 128, expectedNetProfit: 300 },
      modelId: "gpt-5.6-terra",
      usage: { inputTokens: 200, outputTokens: 50, totalTokens: 250 },
      error: null,
    },
    expect: { available: false, errorContains: "guardrail" },
  },
  {
    name: "contradiction_total_acquisition_cost",
    description: "Model echoes the canary field (statedTotalAcquisitionCost) wrong — must be rejected.",
    request: flipRequest({ opportunityId: "opp-mock-2" }),
    liveSafe: false,
    mockCompletion: {
      available: true,
      outputText: JSON.stringify({ summary: "Looks fine.", caveats: [], statedTotalAcquisitionCost: 999 }),
      parsedJson: { summary: "Looks fine.", caveats: [], statedTotalAcquisitionCost: 999 },
      modelId: "gpt-5.6-terra",
      usage: { inputTokens: 180, outputTokens: 40, totalTokens: 220 },
      error: null,
    },
    expect: { available: false, errorContains: "guardrail" },
  },
  {
    name: "ungrounded_currency_figure",
    description: "Model's summary states a £ figure with no basis anywhere in the supplied context — flagged, not blocked.",
    request: flipRequest({ opportunityId: "opp-mock-3" }),
    liveSafe: false,
    mockCompletion: {
      available: true,
      outputText: JSON.stringify({
        summary: "Solid flip — graded PSA10 copies have sold for £500+ recently.",
        caveats: [],
        statedTotalAcquisitionCost: 128,
      }),
      parsedJson: {
        summary: "Solid flip — graded PSA10 copies have sold for £500+ recently.",
        caveats: [],
        statedTotalAcquisitionCost: 128,
      },
      modelId: "gpt-5.6-terra",
      usage: { inputTokens: 190, outputTokens: 45, totalTokens: 235 },
      error: null,
    },
    expect: {
      available: true,
      summaryNonEmpty: true,
      caveatsInclude: [STANDING_CAVEAT_SUBSTRING, "£500"],
    },
  },
  {
    name: "ungrounded_percent_figure",
    description: "Model states a derived percentage not present verbatim in context — flagged as a non-blocking caveat.",
    request: flipRequest({ opportunityId: "opp-mock-4" }),
    liveSafe: false,
    mockCompletion: {
      available: true,
      outputText: JSON.stringify({
        summary: "This is about 38% under recent comp prices.",
        caveats: [],
        statedTotalAcquisitionCost: 128,
      }),
      parsedJson: { summary: "This is about 38% under recent comp prices.", caveats: [], statedTotalAcquisitionCost: 128 },
      modelId: "gpt-5.6-terra",
      usage: { inputTokens: 185, outputTokens: 42, totalTokens: 227 },
      error: null,
    },
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING, "38%"] },
  },
  {
    name: "model_unavailable_no_key",
    description: "No OPENAI_API_KEY configured — NullAiModelProvider's honest unavailable response.",
    request: flipRequest({ opportunityId: "opp-mock-5" }),
    liveSafe: false,
    mockCompletion: {
      available: false,
      outputText: null,
      parsedJson: null,
      modelId: null,
      usage: null,
      error: "AI provider is not configured — no OPENAI_API_KEY is set in this environment.",
    },
    expect: { available: false, errorContains: "not configured" },
  },
  {
    name: "model_unavailable_spend_cap",
    description: "Today's daily AI spend cap has been reached — the request is refused before any network call.",
    request: flipRequest({ opportunityId: "opp-mock-6" }),
    liveSafe: false,
    mockCompletion: {
      available: false,
      outputText: null,
      parsedJson: null,
      modelId: null,
      usage: null,
      error: "AI daily spend cap reached: $5.0000 already spent today against a $5.00 cap.",
    },
    expect: { available: false, errorContains: "spend cap" },
  },
  {
    name: "model_self_reported_caveat",
    description: "Model's own caveats array flags a genuine risk (missing photo) — must be surfaced to the user.",
    request: gradeRequest({ opportunityId: "opp-mock-7" }),
    liveSafe: false,
    mockCompletion: {
      available: true,
      outputText: JSON.stringify({
        summary: "Reasonable GRADE candidate.",
        caveats: ["Listing has no photo of the card back — worth confirming condition before bidding."],
        statedTotalAcquisitionCost: 39,
      }),
      parsedJson: {
        summary: "Reasonable GRADE candidate.",
        caveats: ["Listing has no photo of the card back — worth confirming condition before bidding."],
        statedTotalAcquisitionCost: 39,
      },
      modelId: "gpt-5.6-terra",
      usage: { inputTokens: 210, outputTokens: 55, totalTokens: 265 },
      error: null,
    },
    expect: {
      available: true,
      summaryNonEmpty: true,
      caveatsInclude: [STANDING_CAVEAT_SUBSTRING, "no photo of the card back"],
    },
  },
  {
    name: "malformed_parsed_json_fallback",
    description: "parsedJson is missing a string 'summary' field — defensive fallback to outputText, never crashes.",
    request: flipRequest({ opportunityId: "opp-mock-8" }),
    liveSafe: false,
    mockCompletion: {
      available: true,
      outputText: "Raw fallback narrative text.",
      parsedJson: { caveats: [], statedTotalAcquisitionCost: 128 },
      modelId: "gpt-5.6-terra",
      usage: { inputTokens: 150, outputTokens: 30, totalTokens: 180 },
      error: null,
    },
    expect: { available: true, summaryNonEmpty: true, caveatsInclude: [STANDING_CAVEAT_SUBSTRING] },
  },
];

/** All 20 fixtures — 12 liveSafe + 8 mock-only. */
export const LISTING_ANALYST_FIXTURES: ListingAnalystFixture[] = [...LIVE_SAFE_FIXTURES, ...MOCK_ONLY_FIXTURES];

/**
 * Checks one fixture's actual AiAdvisoryResponse against its declared
 * expectations. Pure and reusable — the same function backs both the
 * CI-safe mock-based test file and the live-account eval script, so
 * "what counts as passing" is defined exactly once.
 */
export function checkFixtureExpectations(
  fixture: ListingAnalystFixture,
  response: AiAdvisoryResponse,
): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  const exp = fixture.expect;

  if (response.available !== exp.available) {
    failures.push(`expected available=${exp.available}, got ${response.available}`);
  }

  if (exp.available) {
    if (exp.summaryNonEmpty && (!response.summary || response.summary.trim().length === 0)) {
      failures.push("expected a non-empty summary");
    }
    for (const substring of exp.caveatsInclude ?? []) {
      if (!response.caveats.some((c) => c.includes(substring))) {
        failures.push(`expected a caveat containing "${substring}"`);
      }
    }
  } else if (exp.errorContains) {
    const combined = response.caveats.join(" ");
    if (!combined.includes(exp.errorContains)) {
      failures.push(`expected the unavailable caveat to contain "${exp.errorContains}"`);
    }
  }

  return { passed: failures.length === 0, failures };
}
