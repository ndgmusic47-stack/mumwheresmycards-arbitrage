#!/usr/bin/env node
/**
 * AI INTELLIGENCE PHASE 2 — OPENAI LIVE SMOKE TEST (read-only diagnostic, not a product feature)
 *
 * Per the user's own explicit instruction: "Before building the full
 * integration, perform one minimal server-side Responses API smoke test
 * against each configured model using the actual project OpenAI API
 * key/account. If a model returns an account-access/model-availability
 * error, do NOT substitute another model silently. Report the exact error
 * and stop that part of the implementation so we can choose deliberately."
 *
 * This script IS that smoke test. It makes exactly one minimal Responses
 * API call PER CONFIGURED TIER (FAST/DEEP/AUDIT — three calls total),
 * through the real OpenAiModelProvider (the same class every AI feature in
 * this app will use — not a hand-rolled fetch, so this test actually
 * exercises the real code path), and prints each tier's result separately.
 * A failure on one tier is reported and does NOT stop the others from
 * being tried — you get a complete picture of which of your three
 * configured models actually work, in one run.
 *
 * NEVER prints, logs, or otherwise exposes the API key — same redaction
 * discipline as poketrace-smoke-test.ts.
 *
 * Usage:
 *   cd apps/worker
 *   npx tsx scripts/openai-smoke-test.ts
 *
 * Reads apps/worker/.dev.vars for OPENAI_API_KEY / AI_FAST_MODEL /
 * AI_DEEP_MODEL / AI_AUDIT_MODEL (never committed — see .gitignore). Does
 * NOT write to the database, does NOT touch any other provider. This
 * script has NOT been run yet — the user has not added a real
 * OPENAI_API_KEY. Run it, and read every line of its output, before
 * relying on the AI layer for anything real.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  OpenAiModelProvider,
  DEFAULT_AI_FAST_MODEL,
  DEFAULT_AI_DEEP_MODEL,
  DEFAULT_AI_AUDIT_MODEL,
  type AiModelTier,
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

async function testTier(provider: OpenAiModelProvider, tier: AiModelTier, modelId: string) {
  log(`\n--- Tier ${tier} (model: ${modelId}) ---`);
  const result = await provider.complete({
    tier,
    instructions: "Reply with exactly the single word: OK",
    input: "Smoke test — reply with exactly the word OK and nothing else.",
    maxOutputTokens: 16,
  });

  if (!result.available) {
    log(`❌ UNAVAILABLE. Exact error (never substituted with a different model):`);
    log(`   ${safe(result.error ?? "(no error message returned)")}`);
    return { tier, modelId, ok: false };
  }

  log(`✅ Responded. modelId (as echoed by OpenAI): ${result.modelId}`);
  log(`   outputText: ${JSON.stringify(result.outputText)}`);
  if (result.usage) {
    log(`   usage: input=${result.usage.inputTokens} output=${result.usage.outputTokens} total=${result.usage.totalTokens}`);
  }
  return { tier, modelId, ok: true };
}

async function main() {
  const vars = loadDevVars();
  const apiKey = vars.OPENAI_API_KEY;

  if (!apiKey) {
    console.error(
      "OPENAI_API_KEY is blank in apps/worker/.dev.vars — add your real key there first, then re-run this.",
    );
    process.exit(1);
  }
  SECRET = apiKey;

  const fastModel = vars.AI_FAST_MODEL || DEFAULT_AI_FAST_MODEL;
  const deepModel = vars.AI_DEEP_MODEL || DEFAULT_AI_DEEP_MODEL;
  const auditModel = vars.AI_AUDIT_MODEL || DEFAULT_AI_AUDIT_MODEL;

  const provider = new OpenAiModelProvider({ apiKey, fastModel, deepModel, auditModel, baseUrl: vars.AI_BASE_URL });

  log("=".repeat(78));
  log("OPENAI LIVE SMOKE TEST — sanitized diagnostic output only");
  log(`FAST model:  ${fastModel}`);
  log(`DEEP model:  ${deepModel}`);
  log(`AUDIT model: ${auditModel}`);
  log("The API key itself is never printed below.");
  log("Each tier is tried independently — one tier failing does not stop the others.");
  log("=".repeat(78));

  const results = [
    await testTier(provider, "FAST", fastModel),
    await testTier(provider, "DEEP", deepModel),
    await testTier(provider, "AUDIT", auditModel),
  ];

  log("\n" + "=".repeat(78));
  log("SUMMARY");
  for (const r of results) {
    log(`  ${r.tier} (${r.modelId}): ${r.ok ? "✅ working" : "❌ FAILED — see exact error above, do not proceed with this tier"}`);
  }
  const anyFailed = results.some((r) => !r.ok);
  log("=".repeat(78));
  if (anyFailed) {
    log("\nAt least one configured model failed. Per the project's own rule: do NOT");
    log("substitute a different model for a failing tier — decide deliberately");
    log("(fix the model id, request account access, or choose a different one)");
    log("before wiring that tier into a real feature.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(safe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
