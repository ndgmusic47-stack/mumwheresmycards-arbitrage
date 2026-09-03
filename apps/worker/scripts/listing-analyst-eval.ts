#!/usr/bin/env node
/**
 * AI INTELLIGENCE spec Phase 2, Workstream K — LIVE EVALUATION RUN (manual
 * diagnostic, not a product feature, not run in CI).
 *
 * WHY THIS EXISTS, AND HOW IT DIFFERS FROM
 * `packages/providers/test/listingAnalystEvalHarness.test.ts`: that test
 * file runs the SAME 20-fixture table (`evalFixtures.ts`) through a
 * scripted fake `AiModelProvider` — deterministic, free, safe for CI, and
 * a permanent regression guard. It cannot, by construction, tell you
 * whether the Listing Analyst's actual prompt produces good real-world
 * analysis from a real model — Workstream K's own stated purpose
 * ("systematically check the Listing Analyst's real behaviour once a key
 * is live", per `architecture-and-status.md`). This script is that check:
 * it takes only the 12 `liveSafe` fixtures (the ones with no fixed
 * wording pinned down — see `evalFixtures.ts`'s doc comment for exactly
 * why the other 8 are mock-only and never run here) and sends each one
 * through the REAL provider chain — `createAiModelProvider(env)`
 * (Workstream F) -> `GuardedAiModelProvider` (Workstream I) ->
 * `AiListingAnalystProvider` (Workstream J), the same composition
 * `apps/worker/src/routes/opportunities.ts`'s `buildAdvisoryProvider()`
 * uses for a real user-facing request (minus `AiCompletionCache`,
 * deliberately — this script wants a genuine fresh model call for every
 * fixture, every run, not a cached answer from a prior run).
 *
 * Every fixture still gets checked against its own `expect` block via the
 * exact same `checkFixtureExpectations()` the CI test file uses — so a
 * fixture failing here means the real model/pipeline combination broke a
 * STRUCTURAL guarantee (came back unavailable, produced an empty summary,
 * or — most importantly — a genuine model response tripped the
 * GROUND_TRUTH_CONTRADICTION guardrail against this app's own real
 * numbers). It does NOT mean the summary reads badly; judging the
 * *quality* of a passing summary is not automatable and is left to
 * whoever reads this script's printed output.
 *
 * Costs real money (12 real DEEP-tier calls) and is never run
 * automatically — run it by hand, deliberately, after adding/changing
 * anything that could affect the Listing Analyst's real-world behaviour
 * (a prompt edit, a guardrail tolerance change, a new model id).
 *
 * Usage:
 *   cd apps/worker
 *   npx tsx scripts/listing-analyst-eval.ts
 *
 * Reads apps/worker/.dev.vars for OPENAI_API_KEY / AI_FAST_MODEL /
 * AI_DEEP_MODEL / AI_AUDIT_MODEL / AI_BASE_URL, same as
 * openai-smoke-test.ts. Does NOT write to the database (no
 * AiCompletionCache in this script's chain — see above) and does NOT
 * touch any other provider.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createAiModelProvider,
  GuardedAiModelProvider,
  AiListingAnalystProvider,
  LISTING_ANALYST_FIXTURES,
  checkFixtureExpectations,
} from "@mwmc/providers";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDevVars(): Record<string, string> {
  const path = resolve(__dirname, "..", ".dev.vars");
  if (!existsSync(path)) {
    console.error(
      `Could not find ${path}\n` +
        `Copy apps/worker/.dev.vars.example to apps/worker/.dev.vars and fill in OPENAI_API_KEY first.`,
    );
    process.exit(1);
  }
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

let SECRET: string | null = null;

function safe(text: string): string {
  if (SECRET && SECRET.length > 0 && text.includes(SECRET)) {
    throw new Error("Refusing to print: output contained the API key. This is a bug — please report it, don't share the output.");
  }
  return text;
}

function log(text: string = "") {
  console.log(safe(text));
}

async function main() {
  const vars = loadDevVars();
  const apiKey = vars.OPENAI_API_KEY;

  if (!apiKey) {
    console.error("OPENAI_API_KEY is blank in apps/worker/.dev.vars — add your real key there first, then re-run this.");
    process.exit(1);
  }
  SECRET = apiKey;

  const modelProvider = createAiModelProvider({
    OPENAI_API_KEY: apiKey,
    AI_FAST_MODEL: vars.AI_FAST_MODEL,
    AI_DEEP_MODEL: vars.AI_DEEP_MODEL,
    AI_AUDIT_MODEL: vars.AI_AUDIT_MODEL,
    AI_BASE_URL: vars.AI_BASE_URL,
  });
  const guarded = new GuardedAiModelProvider(modelProvider);
  const analyst = new AiListingAnalystProvider(guarded);

  const fixtures = LISTING_ANALYST_FIXTURES.filter((f) => f.liveSafe);

  log("=".repeat(78));
  log("LISTING ANALYST — LIVE EVALUATION RUN (Workstream K)");
  log(`Running ${fixtures.length} liveSafe fixtures against the real model/guardrail chain.`);
  log("The API key itself is never printed below.");
  log("=".repeat(78));

  let passCount = 0;
  let failCount = 0;

  for (const fixture of fixtures) {
    log(`\n--- ${fixture.name} ---`);
    log(safe(fixture.description));

    const response = await analyst.getAdvisory(fixture.request);
    const { passed, failures } = checkFixtureExpectations(fixture, response);

    if (passed) {
      passCount += 1;
      log("✅ PASSED expectations");
    } else {
      failCount += 1;
      log("❌ FAILED expectations:");
      for (const failure of failures) log(`   - ${safe(failure)}`);
    }

    log(`available: ${response.available}`);
    if (response.summary) log(`summary: ${safe(response.summary)}`);
    for (const caveat of response.caveats) log(`caveat: ${safe(caveat)}`);
  }

  log("\n" + "=".repeat(78));
  log("SUMMARY");
  log(`  ${passCount}/${fixtures.length} fixtures passed their structural expectations.`);
  log("  (AiAdvisoryResponse doesn't carry token usage — see AiCompletionResult/apps/worker's");
  log("   api_usage logging, via the normal advisory route, for real per-call cost figures.)");
  log("=".repeat(78));

  if (failCount > 0) {
    log(
      "\nAt least one liveSafe fixture failed a structural expectation against a REAL " +
        "model response. This means the real pipeline — not just the mocked CI test — " +
        "broke a guarantee (unavailable, empty summary, or a guardrail rejection against " +
        "this app's own real numbers). Read the failure detail above before trusting the " +
        "Listing Analyst on real opportunities.",
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(safe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
