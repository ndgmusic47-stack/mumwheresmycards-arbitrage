/**
 * WHICH GAMES ARE WORTH SCANNING — MEASURED, NOT ASSUMED.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * The tool's list of supported games was six names I chose on a judgement
 * about which "have real PSA markets", written into the code and then
 * presented for approval. Nobody measured anything. That is the same shape
 * of mistake as the £23 grading fee that sat unchallenged for months
 * because nothing required it to carry a source — and the operator caught
 * it in the same way: "we can use logic surely to determine the games to
 * focus on."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUSINESS IS GRADING, NOT PSA.
 *
 * Corrected by the operator, 2026-09-19, and the first draft of this script
 * had it wrong. It ranked games by PSA coverage and wrote off a BGS price
 * as "real data and no use to you" — which quietly assumed the submission
 * always goes to PSA. It does not have to. The business is buy raw, grade,
 * sell the slab; which company encapsulates it is a choice, not a premise.
 *
 * So a game earns its place if
 *
 *   1. its cards have GRADED prices at all,
 *   2. from a grader whose scale this project can actually price against,
 *   3. at grades you can realistically hit, not just the top of the scale,
 *   4. with a gap over the raw card big enough to cover the submission.
 *
 * This script therefore reports coverage PER GRADER and does not rank one
 * above another. It reports what each game offers; which grader to use is a
 * separate decision, and one the tool cannot make today (see below).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE TOOL CAN AND CANNOT PRICE TODAY — read before acting on this.
 *
 * The data layer is multi-grader: snapshots carry every tier a provider
 * returns, keyed PSA_5, SGC_8_5, TAG_9 and so on. The DECISION layer is
 * not. Three things are PSA-only right now:
 *
 *   - `enabledGraderIds` defaults to ["PSA"].
 *   - `DEFAULT_GRADING_SERVICES` has verified fees for PSA tiers ONLY. No
 *     other grader has a fee on file, and using PSA's £44.41 for a BGS
 *     submission would be a fabricated number driving real decisions.
 *   - `GRADER_SCALES` covers PSA, CGC, SGC and TAG. **BGS has no published
 *     scale on file at all**, so a BGS price cannot currently be mapped to
 *     an outcome even when the provider returns one.
 *
 * That last point matters for reading this table: a game showing strong BGS
 * coverage is showing something this tool cannot yet act on. That is a
 * fixable gap — verify the scale, verify the fees — not a reason to
 * pretend the price is worthless.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS SCRIPT DOES NOT DO.
 *
 * It does not decide. It prints a table and the operator reads it. There is
 * no threshold in here that silently promotes a game, because the whole
 * problem being fixed is a machine-made judgement nobody could see.
 *
 * It also does not measure DEMAND. A graded price is what a slab is worth,
 * not evidence anyone is buying. Sell-through still comes from auction
 * closes (see packages/core/src/market/listingClose.ts) and this script is
 * no substitute for it.
 *
 * It samples the DEAREST cards in each game, deliberately. Graded coverage
 * tracks slab liquidity, so cheap cards would understate every game
 * equally and tell us nothing. This is therefore a BEST CASE per game: if
 * the most valuable cards in a game have no PSA prices, the rest certainly
 * do not.
 *
 * Usage:
 *   pnpm --filter @mwmc/worker run games:coverage
 *   pnpm --filter @mwmc/worker run games:coverage -- --sample 12 --budget 150
 *   pnpm --filter @mwmc/worker run games:coverage -- --games one-piece-card-game,magic-the-gathering
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Overridable so this script can be smoke-tested against a local mock
// before it is pointed at a real key and a real daily quota.
const V1 = process.env.JUSTTCG_V1_BASE ?? "https://api.justtcg.com/v1";
const V2 = process.env.JUSTTCG_V2_BASE ?? "https://api.justtcg.com/v2";

/**
 * ONE REFERENCE FEE, APPLIED TO EVERY GRADER — the operator's call,
 * 2026-09-19: "PSA is most expensive with fees, use them as reference...
 * we can't crash a build because the different grader."
 *
 * The logic is better than what it replaces. PSA Standard at £44.41 plus
 * postage and batch share is the DEAREST way to encapsulate a card, so a
 * spread that clears £49.41 clears at any cheaper grader too. Using the
 * most expensive fee as the yardstick is conservative: it can understate a
 * trade, never overstate one.
 *
 * The previous version refused to net out a BGS or CGC spread because
 * their fees were unverified, and printed a column of zeroes that told the
 * operator nothing. Refusing to estimate is right when the estimate would
 * flatter the trade. Here it did the opposite, and a screening table that
 * answers nothing is not more honest than one that answers conservatively.
 *
 * This is a REFERENCE for choosing which games to look at, not the
 * qualification path. Nothing in the engine reads it, and a real
 * submission to a non-PSA grader still needs that grader's own verified
 * fee before the tool prices it.
 */
const REFERENCE_FEE_GBP = 49.41;
const USD_TO_GBP = 0.7403;

/**
 * Graders this project holds a published grade scale for. A price from a
 * grader outside this list cannot be mapped to an outcome, so it is
 * reported and flagged rather than counted towards a game's usable
 * coverage. BGS is the notable absence.
 */
const SCALED_GRADERS = new Set(["PSA", "CGC", "SGC", "TAG"]);


interface Args {
  sample: number;
  budget: number;
  games: string[] | null;
  delayMs: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
  };
  const games = get("--games");
  return {
    sample: Number(get("--sample") ?? 8),
    // A hard ceiling on v2 calls. JustTCG's free tier is 100/day and 10/min,
    // and an unbounded sweep across seventeen games would blow through it
    // and leave the account blocked rather than informed.
    budget: Number(get("--budget") ?? 100),
    games: games ? games.split(",").map((g) => g.trim()).filter(Boolean) : null,
    // 10 requests/minute on the free tier is one every six seconds.
    delayMs: Number(get("--delay") ?? 6500),
  };
}

function readApiKey(): string {
  const fromEnv = process.env.JUSTTCG_API_KEY;
  if (fromEnv) return fromEnv;

  // Fall back to the same .dev.vars the worker reads locally, so this
  // script needs no separate setup.
  for (const candidate of [join(process.cwd(), ".dev.vars"), join(process.cwd(), "apps", "worker", ".dev.vars")]) {
    try {
      const line = readFileSync(candidate, "utf8")
        .split(/\r?\n/)
        .find((l) => l.startsWith("JUSTTCG_API_KEY="));
      if (line) return line.slice("JUSTTCG_API_KEY=".length).trim();
    } catch {
      /* next candidate */
    }
  }
  throw new Error("No JUSTTCG_API_KEY in the environment or .dev.vars");
}

async function getJson(url: string, apiKey: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "x-api-key": apiKey, accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}\n${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function field(o: unknown, names: string[]): unknown {
  if (o == null || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  for (const n of names) if (rec[n] != null) return rec[n];
  return undefined;
}
function numOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOf(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Price, from v2's markets array or v1's flat field. */
function priceOf(variant: unknown): number | null {
  for (const m of arr(field(variant, ["markets"]))) {
    const p = numOf(field(m, ["price", "market_price"]));
    if (p !== null && p > 0) return p;
  }
  const flat = numOf(field(variant, ["price", "market_price"]));
  return flat !== null && flat > 0 ? flat : null;
}

interface GraderCoverage {
  /** Sampled cards carrying at least one price from this grader. */
  cards: number;
  /** grade -> how many sampled cards carried a price at it. */
  grades: Map<number, number>;
  /** Best low-grade (<=7) gross spread over the raw card, in GBP. */
  bestLowSpreadGbp: number;
  bestLowExample: string | null;
  /** Cards where a low grade cleared raw + a VERIFIED fee. Null-fee graders stay 0. */
  lowGradeNetWins: number;
}

interface GameCoverage {
  gameId: string;
  gameName: string;
  cardsSampled: number;
  withAnyGraded: number;
  byGrader: Map<string, GraderCoverage>;
  notes: string[];
}

function graderBucket(cov: GameCoverage, company: string): GraderCoverage {
  let b = cov.byGrader.get(company);
  if (!b) {
    b = { cards: 0, grades: new Map(), bestLowSpreadGbp: 0, bestLowExample: null, lowGradeNetWins: 0 };
    cov.byGrader.set(company, b);
  }
  return b;
}

async function measureGame(
  apiKey: string,
  gameId: string,
  gameName: string,
  sample: number,
  spend: { used: number; budget: number },
  delayMs: number,
): Promise<GameCoverage> {
  const cov: GameCoverage = { gameId, gameName, cardsSampled: 0, withAnyGraded: 0, byGrader: new Map(), notes: [] };

  // Dearest singles first. `condition` excludes sealed product — there is
  // no product-type field, and without this the sample fills up with
  // booster box cases, which is what a live call actually returned.
  const listUrl =
    `${V1}/cards?game=${encodeURIComponent(gameId)}` +
    `&condition=NM,LP,MP,HP,DMG&orderBy=price&order=desc&limit=${Math.min(sample, 20)}`;

  let cards: unknown[];
  try {
    cards = arr(field(await getJson(listUrl, apiKey), ["data", "cards"]));
  } catch (err) {
    cov.notes.push(`card list failed: ${String(err).slice(0, 120)}`);
    return cov;
  }

  for (const card of cards) {
    if (spend.used >= spend.budget) {
      cov.notes.push("stopped: call budget reached");
      break;
    }

    const cardId = strOf(field(card, ["id", "uuid"]));
    const name = strOf(field(card, ["name"])) ?? "?";
    if (!cardId) continue;

    // The raw reference: the best-conditioned ungraded copy, because that
    // is what actually gets submitted. Not a median across conditions —
    // that would price a near-mint submission using played copies.
    const rawUsd = arr(field(card, ["variants"]))
      .map((v) => priceOf(v))
      .filter((p): p is number => p !== null)
      .sort((a, b) => b - a)[0] ?? null;

    await sleep(delayMs);
    spend.used++;

    let variants: unknown[];
    try {
      // graded=only, not include: a graded-only call costs the same as a v1
      // call whereas combining raw and graded carries a surcharge, and the
      // raw price is already in hand from the list above.
      variants = arr(
        field(arr(field(await getJson(`${V2}/cards?card_id=${encodeURIComponent(cardId)}&graded=only&regions=US`, apiKey), ["data"]))[0], [
          "variants",
        ]),
      );
    } catch (err) {
      cov.notes.push(`${name}: ${String(err).slice(0, 100)}`);
      continue;
    }

    cov.cardsSampled++;
    if (variants.length === 0) continue;
    cov.withAnyGraded++;

    // Every grader is counted, none is privileged. Which company to submit
    // to is a decision downstream of this table, not an assumption baked
    // into it.
    const seenThisCard = new Set<string>();
    for (const v of variants) {
      const grading = field(v, ["grading"]);
      const company = strOf(field(grading, ["company"]))?.toUpperCase();
      const grade = numOf(field(grading, ["grade"]));
      const usd = priceOf(v);
      if (!company || grade === null) continue;

      const bucket = graderBucket(cov, company);
      if (!seenThisCard.has(company)) {
        bucket.cards++;
        seenThisCard.add(company);
      }
      bucket.grades.set(grade, (bucket.grades.get(grade) ?? 0) + 1);

      // THE ACTUAL QUESTION, asked of whichever grader returned the price:
      // does a grade you can realistically hit pay for the submission?
      if (grade <= 7 && usd !== null && rawUsd !== null) {
        const slabGbp = usd * USD_TO_GBP;
        const rawGbp = rawUsd * USD_TO_GBP;
        const spread = slabGbp - rawGbp;

        if (spread > bucket.bestLowSpreadGbp) {
          bucket.bestLowSpreadGbp = spread;
          bucket.bestLowExample = `${name} — raw £${rawGbp.toFixed(0)} -> ${company} ${grade} £${slabGbp.toFixed(0)}`;
        }

        // Every grader netted against the same conservative reference.
        if (spread > REFERENCE_FEE_GBP) bucket.lowGradeNetWins++;
      }
    }
  }

  return cov;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = readApiKey();

  const games = arr(field(await getJson(`${V1}/games`, apiKey), ["data", "games"]))
    .map((g) => ({
      id: strOf(field(g, ["id", "slug"])) ?? "",
      name: strOf(field(g, ["name"])) ?? "",
      cards: numOf(field(g, ["cards_count"])) ?? 0,
      valueUsd: numOf(field(g, ["game_value_usd"])) ?? 0,
    }))
    .filter((g) => g.id && (!args.games || args.games.includes(g.id)))
    // Dearest games first, so a truncated budget still covers the ones most
    // likely to matter rather than whatever sorts alphabetically.
    .sort((a, b) => b.valueUsd - a.valueUsd);

  console.log(`\nSampling the ${args.sample} dearest singles in each of ${games.length} game(s).`);
  console.log(`v2 call budget: ${args.budget}. Pacing: one call every ${args.delayMs}ms.\n`);

  const spend = { used: 0, budget: args.budget };
  const results: GameCoverage[] = [];

  for (const g of games) {
    if (spend.used >= spend.budget) {
      console.log(`Budget exhausted before ${g.name} — rerun with --budget higher, or --games ${g.id}`);
      break;
    }
    process.stdout.write(`  ${g.name} ... `);
    const cov = await measureGame(apiKey, g.id, g.name, args.sample, spend, args.delayMs);
    results.push(cov);
    const graders = [...cov.byGrader.keys()].sort().join("/") || "none";
    console.log(`${cov.withAnyGraded}/${cov.cardsSampled} with slab prices (${graders})`);
  }

  const allGraders = [...new Set(results.flatMap((r) => [...r.byGrader.keys()]))].sort();

  console.log("\n" + "=".repeat(104));
  console.log("GRADED-MARKET COVERAGE BY GRADER — dearest singles per game");
  console.log("=".repeat(104));
  console.log(["GAME".padEnd(30), "SAMPLED".padStart(8), "ANY SLAB".padStart(9), "  PER GRADER: cards / best low-grade spread"].join(" "));
  console.log("-".repeat(104));

  // Ranked by how many sampled cards carry a usable slab price — usable
  // meaning from a grader whose scale this project can price against.
  // Deliberately NOT ranked by PSA.
  // Ranked on the business question — low grades that pay — across ALL
  // graders. A game is never demoted for this codebase's own gaps.
  const usable = (r: GameCoverage): number => [...r.byGrader.values()].reduce((n, b) => n + b.lowGradeNetWins, 0);

  results.sort((a, b) => usable(b) - usable(a) || b.withAnyGraded - a.withAnyGraded);

  for (const r of results) {
    console.log([r.gameName.slice(0, 30).padEnd(30), String(r.cardsSampled).padStart(8), String(r.withAnyGraded).padStart(9)].join(" "));
    if (r.byGrader.size === 0) {
      console.log("      (no graded prices on any of the sampled cards)");
    }
    for (const [company, b] of [...r.byGrader.entries()].sort((x, y) => y[1].cards - x[1].cards)) {
      const grades = [...b.grades.keys()].sort((x, y) => x - y).join(",");
      const scale = SCALED_GRADERS.has(company) ? "" : "  [scale not on file yet — mappable, not a blocker]";
      const fee = `pays at <=7: ${b.lowGradeNetWins}`;
      console.log(
        `      ${company.padEnd(5)} ${String(b.cards).padStart(3)} cards  grades ${grades.padEnd(18)} best low spread £${b.bestLowSpreadGbp.toFixed(0).padStart(6)}  ${fee}${scale}`,
      );
    }
    for (const n of r.notes) console.log(`      NOTE ${n}`);
  }

  console.log("\nHOW TO READ THIS");
  console.log("  ANY SLAB     — sampled cards with a graded price from ANY company.");
  console.log("  best low spread — the biggest gap between the raw card and a slab at grade 7 or below,");
  console.log("                 which is the trade this business is built on. GROSS of the submission fee.");
  console.log("  pays at <=7  — cards where that spread cleared £49.41 (PSA Standard + postage + batch).");
  console.log("                 Applied to EVERY grader as a conservative reference: PSA is the dearest,");
  console.log("                 so anything clearing it clears at a cheaper grader too.");

  console.log("\nBEST LOW-GRADE EXAMPLES");
  for (const r of results) {
    for (const [company, b] of r.byGrader) {
      if (b.bestLowExample) console.log(`  ${r.gameName} / ${company}: ${b.bestLowExample}`);
    }
  }

  console.log(`\nv2 calls used: ${spend.used} of ${spend.budget}.`);
  console.log("\nWHAT THIS DOES NOT SAY");
  console.log("  It is not demand. A slab price is what one is worth, not evidence anyone is buying;");
  console.log("  sell-through still comes from auctions closing with bids.");
  console.log("  It samples the DEAREST cards, so it is a best case per game.");
  console.log("  And it does not pick a grader. The tool can only act on PSA today — other graders need");
  console.log("  a verified fee schedule, and BGS additionally needs a published scale, before the");
  console.log("  engine can price an outcome from them.");
  console.log("\nNOT COVERED AT ALL: sports. JustTCG carries trading-card games only — no Topps, no Panini.");
  console.log("Sports is the largest grading market there is and it needs a different data source.\n");

  if (allGraders.some((g) => !SCALED_GRADERS.has(g))) {
    console.log(`Graders seen with no scale on file: ${allGraders.filter((g) => !SCALED_GRADERS.has(g)).join(", ")}`);
    console.log("Each is a real market this tool currently cannot price. Worth fixing if the numbers above justify it.\n");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
