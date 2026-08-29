#!/usr/bin/env node
/**
 * PHASE 1 — POKETRACE LIVE SMOKE TEST (read-only diagnostic, not a product feature)
 *
 * Makes a small handful of REAL calls to the real PokeTrace API using
 * whatever key you've put in apps/worker/.dev.vars, and prints back a
 * SANITIZED view of the response shape — specifically to nail down the
 * literal tier-key strings PokeTrace actually uses for raw/PSA7/PSA8/PSA9/
 * PSA10 pricing, which the OpenAPI spec doesn't pin down (see the
 * "NOT VERIFIED" doc-comment in packages/providers/src/market/PokeTraceProvider.ts).
 *
 * This script NEVER prints, logs, or otherwise exposes the API key. It only
 * uses it in an outgoing request header. A redaction guard also scrubs the
 * key out of anything printed, as defense in depth.
 *
 * Usage:
 *   cd apps/worker
 *   npx tsx scripts/poketrace-smoke-test.ts
 *
 * Reads apps/worker/.dev.vars for POKETRACE_API_KEY / POKETRACE_API_BASE_URL
 * (never committed — see .gitignore). Does NOT run a catalogue sync, does
 * NOT write to the database, does NOT touch eBay. Just a handful of GET
 * requests and a printed report.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// How many catalogue search results to sample and fetch full pricing for.
// Deliberately tiny — this is a smoke test, not a sync.
const SAMPLE_SIZE = 3;
// A popular, long-printed card so the sample is likely to have both raw AND
// graded (PSA7-10) price data — picking an obscure card risks an empty/thin
// response that tells us nothing about the graded tier keys.
const SEARCH_QUERY = "Charizard";

// ---------------------------------------------------------------------------
// .dev.vars loading (no dependency needed — it's just KEY=VALUE lines)
// ---------------------------------------------------------------------------

function loadDevVars(): Record<string, string> {
  const path = resolve(__dirname, "..", ".dev.vars");
  if (!existsSync(path)) {
    console.error(
      `Could not find ${path}\n` +
        `Copy apps/worker/.dev.vars.example to apps/worker/.dev.vars and fill in POKETRACE_API_KEY first.`,
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

// ---------------------------------------------------------------------------
// Redaction guard — defense in depth. Every console.log in this file goes
// through `safe()` first, which throws rather than print if the secret key
// ever ends up inside the string (it shouldn't — the key is only ever used
// in a request header — but this makes that a hard invariant, not a hope).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Current guesses, mirrored from PokeTraceProvider.ts, so this script can
// report whether the real data matches what the adapter currently assumes.
// ---------------------------------------------------------------------------

const RAW_TIER_CANDIDATES = ["raw", "ungraded", "near_mint", "nm", "loose"];
const PSA_TIER_CANDIDATES: Record<string, string[]> = {
  PSA7: ["psa_7", "psa7"],
  PSA8: ["psa_8", "psa8"],
  PSA9: ["psa_9", "psa9"],
  PSA10: ["psa_10", "psa10"],
};

function matchesAnyCandidate(key: string, candidates: string[]): boolean {
  return candidates.some((c) => c.toLowerCase() === key.toLowerCase());
}

function classifyTierKey(key: string): string {
  if (matchesAnyCandidate(key, RAW_TIER_CANDIDATES)) return "matches current RAW guess ✅";
  for (const [label, candidates] of Object.entries(PSA_TIER_CANDIDATES)) {
    if (matchesAnyCandidate(key, candidates)) return `matches current ${label} guess ✅`;
  }
  return "⚠️  NOT recognized by any current candidate list";
}

// ---------------------------------------------------------------------------
// Minimal fetch helpers (deliberately not importing the provider classes —
// this script wants the TRUE raw JSON shape, before our own field-mapping
// guesses touch it, so we can see exactly what PokeTrace really sends back).
// ---------------------------------------------------------------------------

async function getJson(baseUrl: string, path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const response = await fetch(url.toString(), {
    headers: { "X-API-Key": SECRET as string, Accept: "application/json" },
  });

  const bodyText = await response.text();
  if (!response.ok) {
    // Print status + body (sanitized) so a real error is still diagnosable,
    // but never the request headers (which is where the key lives).
    throw new Error(safe(`${path} -> HTTP ${response.status} ${response.statusText}\nBody: ${bodyText}`));
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error(`${path} returned non-JSON body (first 200 chars): ${bodyText.slice(0, 200)}`);
  }
}

function pickFirstArray(body: Record<string, unknown>, candidates: string[]): unknown[] | null {
  for (const key of candidates) {
    const v = body[key];
    if (Array.isArray(v)) return v;
  }
  return null;
}

function pickFirst(obj: Record<string, unknown>, candidates: string[]): unknown {
  for (const key of candidates) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

/**
 * PokeTrace wraps single-object responses as { data: {...} } — confirmed
 * from a real call (the catalogue-list endpoint returns `data` as an ARRAY
 * directly, which our candidate-key lookup already handled fine, but the
 * single-card detail endpoint returns `data` as an OBJECT wrapper, which
 * the original version of this script — and the current PokeTraceProvider.ts
 * — did not account for). This unwraps that one level, generically.
 */
function unwrapEnvelope(body: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "data" && typeof body.data === "object" && body.data !== null && !Array.isArray(body.data)) {
    return body.data as Record<string, unknown>;
  }
  return body;
}

/** Shared by both the list-item `prices` field and the detail-endpoint `prices` field. */
function dumpPrices(prices: unknown, allTierKeysSeen: Set<string>) {
  if (!prices || typeof prices !== "object" || Object.keys(prices).length === 0) {
    log("    (no `prices` object here)");
    return;
  }
  const pricesObj = prices as Record<string, Record<string, unknown>>;
  for (const sourceKey of Object.keys(pricesObj)) {
    const tiers = pricesObj[sourceKey];
    log(`    source="${sourceKey}" — tier keys: ${Object.keys(tiers).join(", ") || "(none)"}`);
    for (const tierKey of Object.keys(tiers)) {
      allTierKeysSeen.add(tierKey);
      const tier = tiers[tierKey] as Record<string, unknown>;
      log(`      tier="${tierKey}"  [${classifyTierKey(tierKey)}]`);
      log(
        `        avg=${tier.avg} low=${tier.low} high=${tier.high} trend=${JSON.stringify(tier.trend)} ` +
          `confidence=${tier.confidence} saleCount=${tier.saleCount}`,
      );
      log(
        `        avg1d=${tier.avg1d} avg7d=${tier.avg7d} avg30d=${tier.avg30d} ` +
          `median3d=${tier.median3d} median7d=${tier.median7d} median30d=${tier.median30d} ` +
          `country=${JSON.stringify(tier.country)} language=${JSON.stringify(tier.language)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const vars = loadDevVars();
  const apiKey = vars.POKETRACE_API_KEY;
  const baseUrl = vars.POKETRACE_API_BASE_URL || "https://api.poketrace.com";

  if (!apiKey) {
    console.error(
      "POKETRACE_API_KEY is blank in apps/worker/.dev.vars — add your real key there first, then re-run this.",
    );
    process.exit(1);
  }
  SECRET = apiKey;

  log("=".repeat(78));
  log("POKETRACE LIVE SMOKE TEST — sanitized diagnostic output only");
  log(`Base URL: ${baseUrl}  (not secret, from .dev.vars.example)`);
  log(`Sample size: ${SAMPLE_SIZE} cards, search="${SEARCH_QUERY}"`);
  log("The API key itself is never printed below.");
  log("=".repeat(78));

  // --- Step 1: catalogue search (GET /v1/cards) ---------------------------
  log("\n--- STEP 1: GET /v1/cards (catalogue search) ---");
  const catalogueBody = (await getJson(baseUrl, "/v1/cards", {
    product_type: "single",
    game: "pokemon",
    search: SEARCH_QUERY,
    limit: String(SAMPLE_SIZE),
  })) as Record<string, unknown>;

  log(`Top-level response keys: ${Object.keys(catalogueBody).join(", ")}`);

  // The `pagination` object's shape matters for the resumable catalogue
  // sync (checkpoint/cursor persistence) — printing it now rather than
  // guessing at nextCursor/hasMore field names.
  if (catalogueBody.pagination && typeof catalogueBody.pagination === "object") {
    log(`Pagination object: ${JSON.stringify(catalogueBody.pagination)}`);
  } else {
    log("(no top-level `pagination` object on this response)");
  }

  const items = pickFirstArray(catalogueBody, ["cards", "items", "results", "data"]);
  if (!items || items.length === 0) {
    log("⚠️  No array of cards found under any expected key (cards/items/results/data).");
    log("Raw response (first 2000 chars):");
    log(JSON.stringify(catalogueBody, null, 2).slice(0, 2000));
    process.exit(1);
  }
  log(`Found ${items.length} card(s) in the sample.\n`);

  const allTierKeysSeen = new Set<string>();
  const cardIds: string[] = [];

  items.forEach((raw, i) => {
    const item = raw as Record<string, unknown>;
    log(`Card ${i + 1} — raw field names: ${Object.keys(item).join(", ")}`);
    const id = pickFirst(item, ["id", "cardId"]);
    const name = pickFirst(item, ["name"]);
    const setRef = pickFirst(item, ["set", "setCode", "setSlug", "set_code", "setName", "set_name"]);
    const cardNumber = pickFirst(item, ["cardNumber", "card_number", "number"]);
    const variant = pickFirst(item, ["variant"]);
    const market = pickFirst(item, ["market"]);
    const currency = pickFirst(item, ["currency"]);
    log(
      `  id=${JSON.stringify(id)} name=${JSON.stringify(name)} set=${JSON.stringify(setRef)} ` +
        `cardNumber=${JSON.stringify(cardNumber)} variant=${JSON.stringify(variant)} market=${JSON.stringify(market)} currency=${JSON.stringify(currency)}`,
    );
    // The list endpoint already carries a `prices` field per card — dump it
    // straight away, before we even get to Step 2.
    log(`  prices (from the LIST response directly):`);
    dumpPrices(item.prices, allTierKeysSeen);
    if (typeof id === "string") cardIds.push(id);
  });

  if (cardIds.length === 0) {
    log("\n⚠️  Could not find a usable card id on any sample item — cannot proceed to Step 2.");
    process.exit(1);
  }

  // --- Step 2: pricing detail (GET /v1/cards/{id}) -------------------------
  log("\n--- STEP 2: GET /v1/cards/{id} (pricing detail) for each sampled card ---");
  log("(PokeTrace wraps single-object responses as { data: {...} } — unwrapped below.)");

  for (const id of cardIds) {
    log(`\n--- Card id: ${id} ---`);
    const rawDetail = (await getJson(baseUrl, `/v1/cards/${encodeURIComponent(id)}`, {})) as Record<string, unknown>;
    log(`Top-level (outer) keys: ${Object.keys(rawDetail).join(", ")}`);
    const detail = unwrapEnvelope(rawDetail);
    if (detail !== rawDetail) {
      log(`Unwrapped one level of "data" envelope. Inner keys: ${Object.keys(detail).join(", ")}`);
    }

    if (!detail.prices) {
      log("  (no `prices` field on the detail response either)");
      continue;
    }
    dumpPrices(detail.prices, allTierKeysSeen);
  }

  // --- Summary --------------------------------------------------------------
  log("\n" + "=".repeat(78));
  log("SUMMARY — every distinct tier key seen across the sample:");
  if (allTierKeysSeen.size === 0) {
    log("  (none found — none of the sampled cards had a `prices` object with tier data)");
  } else {
    for (const key of [...allTierKeysSeen].sort()) {
      log(`  "${key}"  →  ${classifyTierKey(key)}`);
    }
  }
  log("\nIf any real key is marked NOT recognized above, that's the confirmed literal");
  log("to add to RAW_TIER_CANDIDATES / PSA_TIER_CANDIDATES in PokeTraceProvider.ts.");
  log("=".repeat(78));
}

main().catch((err) => {
  console.error(safe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
