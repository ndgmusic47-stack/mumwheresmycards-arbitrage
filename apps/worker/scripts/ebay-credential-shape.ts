#!/usr/bin/env node
/**
 * EBAY CREDENTIAL SHAPE CHECK — prints NO secret values, ever.
 *
 * `invalid_client` from eBay's token endpoint means the App ID / Cert ID
 * pair was rejected, and eBay never says which half is wrong. Rather than
 * ask anyone to paste credentials somewhere they shouldn't, this reports
 * only the SHAPE of each value — length, which keyset family it belongs to,
 * how many hyphen-separated segments it has, and whether stray whitespace
 * or quote characters got pasted in with it.
 *
 * That is enough to identify every common cause:
 *   - Sandbox keys used against eBay's production API (the usual one)
 *   - Dev ID pasted where the Cert ID belongs
 *   - App ID and Cert ID swapped
 *   - Trailing space / wrapping quotes from a copy-paste
 *
 * What it CANNOT tell you: whether a correctly-shaped production keyset has
 * actually been activated on eBay's side. A brand-new developer account can
 * display production keys that still return invalid_client until eBay
 * finishes verifying the account — see the note printed at the end.
 *
 * Usage:
 *   cd apps/worker
 *   npx tsx scripts/ebay-credential-shape.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadDevVars(): Record<string, string> {
  const path = resolve(__dirname, "..", ".dev.vars");
  if (!existsSync(path)) {
    console.error(`Could not find ${path}`);
    process.exit(1);
  }
  const vars: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    // Deliberately NOT trimming the value — leading/trailing whitespace is
    // one of the things being diagnosed.
    vars[trimmed.slice(0, eq).trim()] = line.slice(line.indexOf("=") + 1);
  }
  return vars;
}

interface Shape {
  present: boolean;
  length: number;
  family: "PRODUCTION" | "SANDBOX" | "LOOKS_LIKE_A_UUID" | "UNRECOGNISED" | "EMPTY";
  segments: number;
  hasSurroundingQuotes: boolean;
  hasLeadingOrTrailingSpace: boolean;
  hasInternalSpace: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describe(raw: string | undefined): Shape {
  if (raw === undefined) {
    return {
      present: false,
      length: 0,
      family: "EMPTY",
      segments: 0,
      hasSurroundingQuotes: false,
      hasLeadingOrTrailingSpace: false,
      hasInternalSpace: false,
    };
  }

  const trimmed = raw.trim();
  const unquoted = trimmed.replace(/^["']|["']$/g, "");

  let family: Shape["family"] = "UNRECOGNISED";
  if (unquoted.length === 0) family = "EMPTY";
  else if (UUID_RE.test(unquoted)) family = "LOOKS_LIKE_A_UUID";
  else if (/SBX/i.test(unquoted)) family = "SANDBOX";
  else if (/PRD/i.test(unquoted)) family = "PRODUCTION";

  return {
    present: true,
    length: unquoted.length,
    family,
    segments: unquoted.split("-").length,
    hasSurroundingQuotes: trimmed !== unquoted,
    hasLeadingOrTrailingSpace: raw !== trimmed,
    hasInternalSpace: /\s/.test(unquoted),
  };
}

function report(label: string, shape: Shape, expectation: string): string[] {
  const problems: string[] = [];
  console.log(`\n${label}`);
  if (!shape.present || shape.family === "EMPTY") {
    console.log("  MISSING or empty");
    problems.push(`${label} is missing or empty.`);
    return problems;
  }
  console.log(`  length ............... ${shape.length} characters`);
  console.log(`  looks like ........... ${shape.family}`);
  console.log(`  hyphen segments ...... ${shape.segments}`);
  console.log(`  expected ............. ${expectation}`);

  if (shape.hasSurroundingQuotes) {
    console.log("  ⚠ value is wrapped in quotes — remove them");
    problems.push(`${label} has quotes around it. .dev.vars values are raw, unquoted.`);
  }
  if (shape.hasLeadingOrTrailingSpace) {
    console.log("  ⚠ leading/trailing whitespace — remove it");
    problems.push(`${label} has stray whitespace around it.`);
  }
  if (shape.hasInternalSpace) {
    console.log("  ⚠ contains a space in the middle — likely truncated or two values merged");
    problems.push(`${label} contains a space inside the value.`);
  }
  return problems;
}

const vars = loadDevVars();
const clientId = describe(vars.EBAY_CLIENT_ID);
const clientSecret = describe(vars.EBAY_CLIENT_SECRET);
const marketplace = describe(vars.EBAY_MARKETPLACE_ID);
const scope = describe(vars.EBAY_OAUTH_SCOPE);

console.log("=".repeat(78));
console.log("EBAY CREDENTIAL SHAPE CHECK — no secret values are printed");
console.log("=".repeat(78));

const problems: string[] = [];
problems.push(...report("EBAY_CLIENT_ID (eBay calls this App ID)", clientId, "contains PRD, ~5 segments"));
problems.push(...report("EBAY_CLIENT_SECRET (eBay calls this Cert ID)", clientSecret, "starts PRD-, ~5 segments"));
problems.push(...report("EBAY_MARKETPLACE_ID", marketplace, "the literal text EBAY_GB"));
problems.push(...report("EBAY_OAUTH_SCOPE", scope, "https://api.ebay.com/oauth/api_scope"));

console.log("\n" + "=".repeat(78));
console.log("DIAGNOSIS");
console.log("=".repeat(78));

// --- The specific, high-confidence failure modes --------------------------
if (clientId.family === "SANDBOX" || clientSecret.family === "SANDBOX") {
  problems.push(
    "SANDBOX KEYS: at least one value is from your Sandbox keyset, but this project calls eBay's PRODUCTION API (api.ebay.com). Copy the Production App ID and Cert ID instead — they are a separate block on the same Application Keys page.",
  );
}
if (clientSecret.family === "LOOKS_LIKE_A_UUID") {
  problems.push(
    "WRONG VALUE IN SECRET: EBAY_CLIENT_SECRET is a UUID, which is the shape of eBay's Dev ID — not the Cert ID. The Dev ID is not used by this project at all.",
  );
}
if (clientId.family === "LOOKS_LIKE_A_UUID") {
  problems.push(
    "WRONG VALUE IN ID: EBAY_CLIENT_ID is a UUID, which is the shape of eBay's Dev ID — not the App ID.",
  );
}
if (clientId.family === "PRODUCTION" && clientSecret.family === "UNRECOGNISED") {
  problems.push(
    "SECRET DOESN'T LOOK LIKE A CERT ID: the App ID looks right but the secret doesn't contain PRD. Check you copied the Cert ID from the SAME application row.",
  );
}
if (marketplace.family !== "UNRECOGNISED" || (vars.EBAY_MARKETPLACE_ID ?? "").trim() !== "EBAY_GB") {
  if ((vars.EBAY_MARKETPLACE_ID ?? "").trim() !== "EBAY_GB") {
    problems.push("EBAY_MARKETPLACE_ID should be exactly EBAY_GB.");
  }
}

if (problems.length === 0) {
  console.log("\nNo shape problems found. Both values look like a matched PRODUCTION keyset.");
  console.log("\nIf eBay still returns invalid_client with correctly-shaped production keys,");
  console.log("the remaining cause is almost always on eBay's side rather than in this file:");
  console.log("  • The developer account has not finished eBay's verification, so the");
  console.log("    production keyset is displayed but not yet active.");
  console.log("  • The keyset was regenerated in the portal — the old Cert ID stops working");
  console.log("    immediately and the new one must be copied across.");
  console.log("  • The application has not been granted the Buy APIs (Browse) it needs.");
  console.log("\nCheck the application's status on eBay's Application Keys page before");
  console.log("changing anything else here.");
} else {
  for (const [i, p] of problems.entries()) console.log(`\n${i + 1}. ${p}`);
}
console.log("");
