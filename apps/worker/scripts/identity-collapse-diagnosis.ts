#!/usr/bin/env node
/**
 * WHAT IS ACTUALLY COLLAPSING — a read-only diagnostic, not a fix.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MEASUREMENT, from the live database on 2026-09-19:
 *
 *   internal cards holding more than one provider card ...... 2,653
 *   provider cards swallowed by them ........................ 5,963
 *   worst single card ....................................... 12
 *
 * 5,963 distinct PokeTrace cards are sharing 2,653 rows. Each row has ONE
 * price ladder, and whichever provider card was profiled last owns it. That
 * is how a card ends up valued as something it is not.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY A DIAGNOSTIC RATHER THAN A FIX.
 *
 * This project's notes have described the collapse as jumbo and oversized
 * promos sharing a row with the standard card. The data does not support
 * that. The worst offenders are ordinary trainers and items, all with
 * variant "normal", the same name, the same set and the same number.
 *
 * Nothing stored locally says how they differ: external_card_refs.raw_payload
 * is null on every row — the column exists and was never populated.
 *
 * The hypothesis is language. The catalogue DTO states in its own comment
 * that the sync "ASSUMES language: 'EN' for every PokeTrace-catalogued
 * card", flagged there as "a documented assumption to verify with real
 * data". A Fates Collide N exists in English, German, French, Italian,
 * Spanish, Portuguese and more — which is about twelve. Every collapsed id
 * below carries PokeTrace's `eu_` prefix.
 *
 * That is a hypothesis, not a finding, and the fixes diverge completely:
 * language means adding it to the printing hash and re-syncing; a variant
 * collapse means mapping the provider's variant enum; duplicate provider
 * records mean dedup. Each costs a full catalogue re-sync, and the wrong one
 * leaves the prices just as wrong. So this asks PokeTrace directly.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * IT ALSO TESTS THE SOLD-LISTINGS ENDPOINT, at no extra cost.
 *
 * PokeTrace documents GET /cards/:id/listings — individual sold records with
 * grader and grade filters, title, price, sale date and the eBay item. If
 * that is reachable on the current plan it is a far better source of
 * evidence than watching auctions close for months, and it answers the
 * identity question outright: if two collapsed cards return sold titles in
 * different languages, the collapse IS language and there is nothing more to
 * establish.
 *
 * If it returns 402 or 403, that is the paid-plan answer, obtained for the
 * price of one call rather than a subscription.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * NO SUBPROCESS, DELIBERATELY. An earlier version shelled out to wrangler to
 * read these ids live. That failed on Windows twice — first ENOENT because
 * execFileSync does not apply PATHEXT to `npx`, then EINVAL because Node 24
 * refuses to spawn a .cmd without a shell (the batch-argument-injection
 * fix), and passing SQL through cmd.exe quoting to get round it would be
 * worse than either. The ids are read out of the database once and written
 * here as data; the script only talks to PokeTrace.
 *
 * Usage:
 *   cd apps/worker
 *   pnpm run identity:diagnose
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The three worst collapsed groups, read from the live database on
 * 2026-09-19. Each line is one internal card row and the PokeTrace cards
 * sharing it. Re-read them with:
 *
 *   SELECT c.name, c.set_name, c.card_number,
 *          COUNT(DISTINCT r.provider_card_id) AS n,
 *          GROUP_CONCAT(r.provider_card_id) AS ids
 *     FROM external_card_refs r JOIN cards c ON c.id = r.internal_card_id
 *    GROUP BY r.internal_card_id HAVING n > 1 ORDER BY n DESC LIMIT 3;
 */
const GROUPS: { card: string; providerCardIds: string[] }[] = [
  {
    card: "N — Fates Collide #105 (12 provider cards share this row)",
    providerCardIds: ["eu_289925", "eu_295213", "eu_295232", "eu_295256", "eu_295282", "eu_312214"],
  },
  {
    card: "Guzma — Burning Shadows #115 (10 provider cards share this row)",
    providerCardIds: ["eu_298778", "eu_312218", "eu_312240", "eu_312262", "eu_312287", "eu_368673"],
  },
  {
    card: "Float Stone — BREAKthrough #137 (10 provider cards share this row)",
    providerCardIds: ["eu_286383", "eu_295241", "eu_295266", "eu_312245", "eu_312272", "eu_312296"],
  },
];

function loadDevVars(): Record<string, string> {
  const path = resolve(__dirname, "..", ".dev.vars");
  if (!existsSync(path)) {
    console.error(`Could not find ${path}.`);
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

let SECRET = "";
function safe(text: string): string {
  if (SECRET && text.includes(SECRET)) {
    throw new Error("Refusing to print: output contained the API key. This is a bug — don't share the output.");
  }
  return text;
}
function log(text = "") {
  console.log(safe(text));
}

/**
 * Every field not identical across the group. Fields that agree are dropped:
 * with a dozen near-identical records the whole point is what survives once
 * the agreement is stripped out.
 *
 * `prices` is excluded because it always differs and is the SYMPTOM, not the
 * distinguishing identity. Its differing is what makes the collapse
 * expensive, not what explains it.
 */
function differingFields(records: Record<string, unknown>[]): Map<string, unknown[]> {
  const keys = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) keys.add(k);

  const differing = new Map<string, unknown[]>();
  for (const key of keys) {
    if (key === "prices") continue;
    const values = records.map((r) => r[key]);
    if (new Set(values.map((v) => JSON.stringify(v ?? null))).size > 1) differing.set(key, values);
  }
  return differing;
}

function short(value: unknown, max = 90): string {
  const text = JSON.stringify(value ?? null);
  return text.length > max ? text.slice(0, max) + "…" : text;
}

async function main() {
  const vars = loadDevVars();
  const apiKey = vars.POKETRACE_API_KEY ?? "";
  // The HOST only. Paths below are absolute and carry the /v1 prefix, exactly
  // as PokeTraceProvider.ts builds them — an earlier version of this script
  // dropped the prefix and got a clean 404 on every id, which reads exactly
  // like "these cards do not exist" and is nothing of the kind. Copy the path
  // from the code that demonstrably works rather than the docs.
  const baseUrl = (vars.POKETRACE_API_BASE_URL || "https://api.poketrace.com").replace(/\/$/, "");
  if (!apiKey) {
    console.error("POKETRACE_API_KEY is blank in apps/worker/.dev.vars.");
    process.exit(1);
  }
  SECRET = apiKey;

  const headers = { "X-API-Key": apiKey, Accept: "application/json" };

  log("=".repeat(80));
  log("IDENTITY COLLAPSE — what actually differs between cards sharing one row");
  log("Read-only. Nothing is written to the database or to PokeTrace.");
  log("The API key is never printed.");
  log("=".repeat(80));

  // ---- PART 1: what differs between the collapsed records -----------------
  for (const group of GROUPS) {
    log("\n" + "-".repeat(80));
    log(group.card);
    log("-".repeat(80));

    const records: Record<string, unknown>[] = [];
    for (const id of group.providerCardIds) {
      try {
        const res = await fetch(new URL(`/v1/cards/${encodeURIComponent(id)}`, baseUrl), { headers });
        if (!res.ok) {
          log(`  ! ${id}: ${res.status} ${res.statusText}`);
          continue;
        }
        const body = (await res.json()) as Record<string, unknown>;
        const card = (body.data && typeof body.data === "object" ? body.data : body) as Record<string, unknown>;
        records.push({ __id: id, ...card });
      } catch (err) {
        log(`  ! ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (records.length < 2) {
      log("  Not enough records came back to compare.");
      continue;
    }

    const differing = differingFields(records);
    if (differing.size === 0) {
      log("  NOTHING differs outside prices. That would mean PokeTrace itself holds");
      log("  duplicate records, and the fix is dedup rather than a richer identity.");
      continue;
    }

    log(`  Compared ${records.length} records. Fields that DIFFER (identical ones omitted):\n`);
    for (const [key, values] of differing) {
      log(`    ${key}`);
      values.forEach((v, i) => log(`      ${records[i]!.__id}  ->  ${short(v)}`));
      log("");
    }
  }

  // ---- PART 2: is the sold-listings endpoint reachable? -------------------
  log("\n" + "=".repeat(80));
  log("SOLD LISTINGS — is GET /cards/:id/listings available on this plan?");
  log("=".repeat(80));

  const probeIds = [GROUPS[0]!.providerCardIds[0]!, GROUPS[0]!.providerCardIds[1]!];
  for (const id of probeIds) {
    const url = new URL(`/v1/cards/${encodeURIComponent(id)}/listings?limit=5`, baseUrl);
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        log(`\n  ${id}: ${res.status} ${res.statusText}`);
        if (res.status === 401 || res.status === 402 || res.status === 403) {
          log("  -> Not on the current plan. That is the answer, for the price of one call.");
        } else if (res.status === 404) {
          log("  -> The base card fetch above worked, so the id is real: this endpoint");
          log("     does not exist on this account. Either a different path, or not offered.");
        }
        continue;
      }
      const body = (await res.json()) as Record<string, unknown>;
      const rows = (Array.isArray(body.data) ? body.data : Array.isArray(body.listings) ? body.listings : []) as Record<
        string,
        unknown
      >[];
      log(`\n  ${id}: ${rows.length} sold record(s) returned.`);
      // The TITLE is the payload here. A German or French title on one id and
      // an English one on another settles the language question outright.
      for (const row of rows.slice(0, 5)) {
        const title = row.title ?? row.name ?? "(no title field)";
        const price = row.price ?? row.soldPrice ?? null;
        const currency = row.currency ?? "";
        const date = row.soldAt ?? row.saleDate ?? row.date ?? "";
        const grade = row.grade ?? row.gradeLabel ?? "";
        log(`      ${String(date).slice(0, 10)}  ${String(grade).padEnd(8)}  ${String(price)} ${String(currency)}`);
        log(`      ${String(title)}`);
      }
      if (rows.length === 0) log("      (endpoint works, but no sold records for this card)");
    } catch (err) {
      log(`\n  ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log("\n" + "=".repeat(80));
  log("HOW TO READ PART 1. Whatever field is listed is what the printing hash");
  log("is missing. A language or market field means these are separate language");
  log("printings and the hash needs it. A variant or rarity field means the");
  log("provider's variant enum is not being mapped. Nothing differing means");
  log("PokeTrace holds duplicates and the answer is dedup. Each is a different");
  log("fix, and each costs a full catalogue re-sync.");
  log("");
  log("HOW TO READ PART 2. Sold titles in different languages for two ids that");
  log("share one row would confirm the language hypothesis on its own. A 402 or");
  log("403 tells us the endpoint needs the paid plan before anything is spent.");
  log("=".repeat(80));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
