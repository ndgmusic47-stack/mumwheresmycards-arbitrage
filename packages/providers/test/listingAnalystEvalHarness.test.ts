import { describe, it, expect } from "vitest";
import { AiListingAnalystProvider } from "../src/advisory/AiListingAnalystProvider.js";
import { GuardedAiModelProvider } from "../src/ai/AiGuardrails.js";
import type { AiAdvisoryRequest } from "../src/advisory/AiAdvisoryProvider.js";
import type { AiCompletionRequest, AiCompletionResult, AiModelProvider } from "../src/ai/AiModelProvider.js";
import { LISTING_ANALYST_FIXTURES, checkFixtureExpectations, type ListingAnalystFixture } from "../src/advisory/evalFixtures.js";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream K (evaluation harness).
 *
 * This is the CI-safe half of the fixture table defined in
 * `evalFixtures.ts` — see that file's doc comment for the full
 * liveSafe/mock-only split and why this file and
 * `apps/worker/scripts/listing-analyst-eval.ts` share the exact same
 * fixture list and the exact same `checkFixtureExpectations` function.
 *
 * Runs EVERY fixture (all 20, liveSafe and mock-only alike) through the
 * REAL production chain — `GuardedAiModelProvider` (Workstream I) wrapping
 * a scripted fake `AiModelProvider` — into a REAL `AiListingAnalystProvider`
 * (Workstream J), never a hand-rolled shortcut. The only thing faked is the
 * network call itself:
 *
 * - A mock-only fixture (`liveSafe: false`) supplies its own
 *   `mockCompletion` — the RAW, pre-guardrail response the fake
 *   `AiModelProvider` returns, exactly as a real upstream call would. The
 *   real `GuardedAiModelProvider` then runs its real contradiction/
 *   ungrounded-figure checks against it, so these fixtures are genuine
 *   regression tests of Workstream I's behaviour on realistic inputs, not
 *   just its own unit tests' minimal synthetic ones.
 * - A liveSafe fixture (`liveSafe: true`) has no fixed wording to script —
 *   its point is to prove the pipeline handles a REALISTIC request shape
 *   without crashing or misfiring the guardrail, so this file generates one
 *   shared, deliberately bland "happy path" completion for it (correct
 *   canary echo, no £/% figures) and lets the fixture's purely-structural
 *   expectations (available, non-empty summary, standing caveat present)
 *   check the result. The eval script runs these same 12 fixtures against
 *   a REAL model instead — see that file for why liveSafe fixtures never
 *   pin down exact wording.
 */

class ScriptedAiModelProvider implements AiModelProvider {
  readonly name = "scripted-fake";
  constructor(private readonly response: AiCompletionResult) {}
  async complete(_request: AiCompletionRequest): Promise<AiCompletionResult> {
    return this.response;
  }
}

/**
 * The shared "happy path" completion used for every liveSafe fixture (see
 * file doc comment). Deliberately echoes the canary field correctly and
 * keeps free text free of £/$/% characters, so it never trips either
 * guardrail check regardless of which fixture's request it's answering —
 * these fixtures exist to prove the PIPELINE behaves, not to pin down any
 * particular wording.
 */
function buildHappyPathCompletion(request: AiAdvisoryRequest): AiCompletionResult {
  const summary = `${request.strategy} opportunity for ${request.cardName} — review the app's own computed figures before acting.`;
  return {
    available: true,
    outputText: JSON.stringify({ summary, caveats: [], statedTotalAcquisitionCost: request.totalAcquisitionCost }),
    parsedJson: { summary, caveats: [], statedTotalAcquisitionCost: request.totalAcquisitionCost },
    modelId: "gpt-5.6-terra-fake",
    usage: { inputTokens: 150, outputTokens: 40, totalTokens: 190 },
    error: null,
  };
}

async function runFixture(fixture: ListingAnalystFixture) {
  const rawCompletion = fixture.liveSafe ? buildHappyPathCompletion(fixture.request) : fixture.mockCompletion!;
  const guarded = new GuardedAiModelProvider(new ScriptedAiModelProvider(rawCompletion));
  const analyst = new AiListingAnalystProvider(guarded);
  return analyst.getAdvisory(fixture.request);
}

describe("Listing Analyst evaluation harness (Workstream K)", () => {
  it("defines exactly 20 fixtures, 12 liveSafe and 8 mock-only, with no duplicate names", () => {
    expect(LISTING_ANALYST_FIXTURES).toHaveLength(20);
    expect(LISTING_ANALYST_FIXTURES.filter((f) => f.liveSafe)).toHaveLength(12);
    expect(LISTING_ANALYST_FIXTURES.filter((f) => !f.liveSafe)).toHaveLength(8);
    expect(new Set(LISTING_ANALYST_FIXTURES.map((f) => f.name)).size).toBe(20);
  });

  it("every mock-only fixture supplies a mockCompletion, and every liveSafe fixture omits one", () => {
    for (const fixture of LISTING_ANALYST_FIXTURES) {
      if (fixture.liveSafe) {
        expect(fixture.mockCompletion, `${fixture.name} is liveSafe but defines a mockCompletion`).toBeUndefined();
      } else {
        expect(fixture.mockCompletion, `${fixture.name} is mock-only but has no mockCompletion`).toBeDefined();
      }
    }
  });

  for (const fixture of LISTING_ANALYST_FIXTURES) {
    it(`${fixture.name}: ${fixture.description}`, async () => {
      const response = await runFixture(fixture);
      const { passed, failures } = checkFixtureExpectations(fixture, response);
      expect(passed, failures.join("; ")).toBe(true);
    });
  }
});
