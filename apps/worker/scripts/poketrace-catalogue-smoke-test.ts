#!/usr/bin/env node
/**
 * PHASE 1 (continued) — POKETRACE CATALOGUE LIVE SMOKE TEST (read-only)
 *
 * Two small, separate live checks against the real PokeTrace API, to close
 * the two remaining documented gaps from ARCHITECTURE.md section 13:
 *
 *  TASK 1 — GET /v1/cards pagination: what does the real `pagination`
 *  object actually look like, what's the real next-cursor field, what's
 *  the real has-more field? Fetches a deliberately tiny page 1, tries to
 *  find a next-page cursor in the response (printing exactly what it
 *  checked and what it found — never silently guessing), fetches page 2
 *  with it if found, and checks for duplicate provider ids across the two
 *  pages.
 *
 *  TASK 2 — GET /v1/sets: what are the real field names for a set's
 *  id/slug, name, and release year/date?
 *
 * Same safety rules as poketrace-smoke-test.ts: never prints, logs, or
 * otherwise exposes the API key (only used in a request header), with the
 * same redaction guard as defense in depth. Does NOT run a catalogue sync,
 * does NOT write to the database.
 *
 * Usage:
 *   cd apps/worker
 *   npx tsx scripts/poketrace-catalogue-smoke-test.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deliberately tiny — just enough to force a second page to exist.
const PAGE_LIMIT = 2;

// ---------------------------------------------------------------------------
// .dev.vars loading + redaction guard (same pattern as poketrace-smoke-test.ts)
// ---------------------------------------------------------------------------

function loadDevVars(): Record<string, string> {
  const path = resolve(__dirname, "..", ".dev.vars");
  if (!existsSync(path)) {
    console.error(`Could not find ${path} — copy .dev.vars.example to .dev.vars and fill in POKETRACE_API_KEY first.`);
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

async function getJson(baseUrl: string, path: string, params: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const response = await fetch(url.toString(), {
    headers: { "X-API-Key": SECRET as string, Accept: "application/json" },
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(safe(`${path} -> HTTP ${response.status} ${response.statusText}\nBody: ${bodyText}`));
  }
  try {
    return { status: response.status, body: JSON.parse(bodyText) };
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

function idsOf(items: unknown[]): string[] {
  return items
    .map((raw) => (raw as Record<string, unknown>).id)
    .filter((v): v is string => typeof v === "string");
}

/**
 * Looks for a next-page cursor value at a short list of plausible
 * locations, IN ORDER, and reports exactly which one (if any) it used —
 * this is transparency about a guess, not a silent guess. Checked both
 * nested under a `pagination` object (which is what the real /v1/cards
 * response has at the top level, per the PHASE 1 pricing smoke test) and
 * at the top level directly, in case that differs for this endpoint.
 */
function findCursorField(body: Record<string, unknown>): { path: string; value: string } | null {
  const candidateKeys = ["nextCursor", "next_cursor", "cursor", "next", "nextPage", "next_page", "continuationToken", "pageToken", "page_token"];
  const pagination = body.pagination;
  if (pagination && typeof pagination === "object") {
    const p = pagination as Record<string, unknown>;
    for (const key of candidateKeys) {
      if (typeof p[key] === "string" && p[key]) return { path: `pagination.${key}`, value: p[key] as string };
    }
  }
  for (const key of candidateKeys) {
    if (typeof body[key] === "string" && body[key]) return { path: key, value: body[key] as string };
  }
  return null;
}

function findHasMoreField(body: Record<string, unknown>): { path: string; value: boolean } | null {
  const candidateKeys = ["hasMore", "has_more", "more"];
  const pagination = body.pagination;
  if (pagination && typeof pagination === "object") {
    const p = pagination as Record<string, unknown>;
    for (const key of candidateKeys) {
      if (typeof p[key] === "boolean") return { path: `pagination.${key}`, value: p[key] };
    }
  }
  for (const key of candidateKeys) {
    if (typeof body[key] === "boolean") return { path: key, value: body[key] as boolean };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const vars = loadDevVars();
  const apiKey = vars.POKETRACE_API_KEY;
  const baseUrl = vars.POKETRACE_API_BASE_URL || "https://api.poketrace.com";
  if (!apiKey) {
    console.error("POKETRACE_API_KEY is blank in apps/worker/.dev.vars — add your real key there first.");
    process.exit(1);
  }
  SECRET = apiKey;

  log("=".repeat(78));
  log("TASK 1 — GET /v1/cards PAGINATION — sanitized diagnostic output only");
  log(`Base URL: ${baseUrl}  |  page limit: ${PAGE_LIMIT}  |  API key never printed below.`);
  log("=".repeat(78));

  // --- Page 1 ---------------------------------------------------------------
  log("\n--- Fetching page 1 ---");
  const page1 = (await getJson(baseUrl, "/v1/cards", {
    product_type: "single",
    game: "pokemon",
    limit: String(PAGE_LIMIT),
  })).body as Record<string, unknown>;

  log(`Top-level response keys: ${Object.keys(page1).join(", ")}`);
  log("FULL raw response (this is just card metadata + a pagination object — nothing sensitive):");
  log(JSON.stringify(page1, null, 2));

  const page1Items = pickFirstArray(page1, ["cards", "items", "results", "data"]) ?? [];
  const page1Ids = idsOf(page1Items);
  log(`\nPage 1 returned ${page1Items.length} card(s), ids: ${page1Ids.join(", ") || "(none)"}`);

  const cursorField = findCursorField(page1);
  const hasMoreField = findHasMoreField(page1);
  log(`\nChecked for a next-cursor field at: pagination.{${["nextCursor", "next_cursor", "cursor", "next", "nextPage", "next_page", "continuationToken", "pageToken", "page_token"].join(", ")}} and the same names at the top level.`);
  if (cursorField) {
    log(`✅ Found a cursor at "${cursorField.path}"`);
  } else {
    log(`⚠️  Did NOT find a cursor at any checked location. If page 1 already returned fewer than ${PAGE_LIMIT} cards, that may just mean there's no next page for this query — not necessarily a missing field.`);
  }
  if (hasMoreField) {
    log(`✅ Found a has-more flag at "${hasMoreField.path}" = ${hasMoreField.value}`);
  } else {
    log(`⚠️  Did NOT find a boolean has-more flag at any checked location.`);
  }

  // --- Page 2 (only if we found a real cursor) -------------------------------
  if (cursorField) {
    log(`\n--- Fetching page 2 using cursor="${cursorField.value}" (as the "cursor" query param, per the already-confirmed request shape) ---`);
    const page2 = (await getJson(baseUrl, "/v1/cards", {
      product_type: "single",
      game: "pokemon",
      limit: String(PAGE_LIMIT),
      cursor: cursorField.value,
    })).body as Record<string, unknown>;

    log(`Top-level response keys: ${Object.keys(page2).join(", ")}`);
    log("FULL raw response:");
    log(JSON.stringify(page2, null, 2));

    const page2Items = pickFirstArray(page2, ["cards", "items", "results", "data"]) ?? [];
    const page2Ids = idsOf(page2Items);
    log(`\nPage 2 returned ${page2Items.length} card(s), ids: ${page2Ids.join(", ") || "(none)"}`);

    const overlap = page2Ids.filter((id) => page1Ids.includes(id));
    if (overlap.length > 0) {
      log(`⚠️  DUPLICATE provider id(s) between page 1 and page 2: ${overlap.join(", ")} — pagination may not be advancing correctly.`);
    } else if (page2Ids.length > 0) {
      log(`✅ No duplicate provider ids between page 1 and page 2 — pagination appears to advance correctly.`);
    } else {
      log(`(page 2 was empty — nothing to compare)`);
    }
  } else {
    log("\nSkipping page 2 fetch — no cursor field was found to use (see warning above). Not guessing at one.");
  }

  // --- TASK 2: GET /v1/sets --------------------------------------------------
  log("\n" + "=".repeat(78));
  log("TASK 2 — GET /v1/sets — sanitized diagnostic output only");
  log("=".repeat(78));

  const setsResult = (await getJson(baseUrl, "/v1/sets", { game: "pokemon" })).body as Record<string, unknown>;
  log(`Top-level response keys: ${Object.keys(setsResult).join(", ")}`);

  const setsArray = pickFirstArray(setsResult, ["sets", "items", "results", "data"]);
  if (!setsArray) {
    log("⚠️  No array of sets found under any expected key (sets/items/results/data).");
    log("FULL raw response (first 3000 chars):");
    log(JSON.stringify(setsResult, null, 2).slice(0, 3000));
  } else {
    log(`Found ${setsArray.length} set(s). First 3, in full (small — just set names/dates, nothing sensitive):`);
    for (const raw of setsArray.slice(0, 3)) {
      const item = raw as Record<string, unknown>;
      log(`  raw field names: ${Object.keys(item).join(", ")}`);
      log(`  ${JSON.stringify(item)}`);
    }
  }

  log("\n" + "=".repeat(78));
  log("Done. Nothing was written to the database, and no catalogue sync ran.");
  log("=".repeat(78));
}

main().catch((err) => {
  console.error(safe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
