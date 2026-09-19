#!/usr/bin/env node
/**
 * WHICH CARD GAMES ARE WORTH GRADING FOR — measured, not assumed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. The tool is Pokémon-only because PokeTrace is
 * Pokémon-only, not because anyone measured Pokémon against the
 * alternatives. Before committing to a catalogue provider for any other
 * game, the question worth answering is where the UK volume actually is —
 * both the raw cards you could buy and the graded slabs you would be
 * selling into.
 *
 * This asks eBay UK directly. One search per probe, `limit=1`, and it reads
 * only the `total` eBay reports. Roughly 45 calls against a 5,000/day
 * allowance, and it stores nothing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THE NUMBERS ARE, AND WHAT THEY ARE NOT.
 *
 * These are KEYWORD MATCH COUNTS, not category counts. "pokemon card"
 * catches sealed product, bundles, playmats and fakes alongside singles,
 * and "PSA" catches listings that merely mention PSA in a description.
 * They are usable for RELATIVE sizing between games, which is the decision
 * in front of us. They are not an inventory count and must not be quoted
 * as one.
 *
 * The three probes per game:
 *   raw_all    — every listing matching the game's card keyword
 *   raw_buyable — the same, restricted to £20-£1,000, which is the band the
 *                 business actually buys in. This is the supply number.
 *   psa_slabs  — listings matching the game name plus PSA. This is the
 *                depth of the market you would be SELLING into, and it is
 *                the one that decides whether grading that game is a
 *                business at all. A game with plenty of raw supply and no
 *                slab market is a trap.
 *
 * The ratio of slabs to raw is the single most telling figure: it says how
 * normal it is to grade that game at all.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Usage:
 *   cd apps/worker
 *   npx tsx scripts/ebay-game-volume.ts
 *
 * Credentials come from apps/worker/.dev.vars, the same file the other
 * smoke tests use. Nothing is typed in and neither the client secret nor
 * the OAuth token is ever printed.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The buying band. Below £20 the £28 grading fee eats the trade; above
 *  £1,000 is outside the stated risk appetite. */
const BUY_MIN = 20;
const BUY_MAX = 1000;

interface Probe {
  /** How it appears in the report. */
  label: string;
  /** Keyword for raw singles of this game. */
  raw: string;
  /** Keyword for graded slabs of this game. */
  psa: string;
}

/**
 * Ten card games plus the sports categories. The sports rows are keyed on
 * the MANUFACTURER (Panini, Topps) rather than the sport, because that is
 * how sellers actually title them and a sport name alone returns shirts,
 * tickets and memorabilia.
 */
const PROBES: Probe[] = [
  { label: "Pokemon", raw: "pokemon card", psa: "pokemon PSA" },
  { label: "Magic: The Gathering", raw: "magic the gathering card", psa: "magic the gathering PSA" },
  { label: "Yu-Gi-Oh", raw: "yugioh card", psa: "yugioh PSA" },
  { label: "One Piece", raw: "one piece card game", psa: "one piece card PSA" },
  { label: "Disney Lorcana", raw: "lorcana card", psa: "lorcana PSA" },
  { label: "Digimon", raw: "digimon card", psa: "digimon card PSA" },
  { label: "Dragon Ball Super", raw: "dragon ball super card game", psa: "dragon ball super card PSA" },
  { label: "Star Wars Unlimited", raw: "star wars unlimited card", psa: "star wars unlimited PSA" },
  { label: "Flesh and Blood", raw: "flesh and blood card", psa: "flesh and blood card PSA" },
  { label: "Riftbound (LoL)", raw: "riftbound card", psa: "riftbound PSA" },
  { label: "Union Arena", raw: "union arena card", psa: "union arena card PSA" },
  { label: "Sports — Panini", raw: "panini card", psa: "panini PSA" },
  { label: "Sports — Topps", raw: "topps card", psa: "topps PSA" },
  { label: "Sports — Futera", raw: "futera card", psa: "futera PSA" },
];

// ---------------------------------------------------------------------------
// .dev.vars loading + redaction guard — same pattern as ebay-smoke-test.ts.
// ---------------------------------------------------------------------------
function loadDevVars(): Record<string, string> {
  const path = resolve(__dirname, "..", ".dev.vars");
  if (!existsSync(path)) {
    console.error(`Could not find ${path} — this script reads the same eBay credentials the scanner uses.`);
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

const secrets: string[] = [];

function safe(text: string): string {
  for (const s of secrets) {
    if (s && s.length > 0 && text.includes(s)) {
      throw new Error("Refusing to print: output contained a secret. This is a bug — don't share the output.");
    }
  }
  return text;
}

function log(text = "") {
  console.log(safe(text));
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

async function main() {
  const vars = loadDevVars();
  const clientId = vars.EBAY_CLIENT_ID;
  const clientSecret = vars.EBAY_CLIENT_SECRET;
  const marketplaceId = vars.EBAY_MARKETPLACE_ID || "EBAY_GB";
  const oauthScope = vars.EBAY_OAUTH_SCOPE || "https://api.ebay.com/oauth/api_scope";

  if (!clientId || !clientSecret) {
    console.error("EBAY_CLIENT_ID and/or EBAY_CLIENT_SECRET are blank in apps/worker/.dev.vars.");
    process.exit(1);
  }
  secrets.push(clientSecret);

  log("=".repeat(86));
  log("EBAY UK LISTING VOLUME BY GAME — keyword match counts, for relative sizing only");
  log(`Marketplace: ${marketplaceId}  |  buy band: £${BUY_MIN}-£${BUY_MAX}  |  ${PROBES.length * 3} searches`);
  log("=".repeat(86));

  // --- OAuth -----------------------------------------------------------------
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenResponse = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: oauthScope }).toString(),
  });
  const tokenText = await tokenResponse.text();
  if (!tokenResponse.ok) {
    throw new Error(safe(`OAuth token request failed: ${tokenResponse.status} ${tokenResponse.statusText}\n${tokenText}`));
  }
  const token = (JSON.parse(tokenText) as { access_token: string }).access_token;
  secrets.push(token);

  /**
   * One probe. Returns eBay's reported total, or null when the call failed —
   * never 0, because a failed call and an empty market are different facts
   * and collapsing them would quietly rank a game as dead.
   */
  async function total(keywords: string, priceBand: boolean): Promise<number | null> {
    const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
    url.searchParams.set("q", keywords);
    url.searchParams.set("limit", "1");
    const filters = ["buyingOptions:{FIXED_PRICE|AUCTION|BEST_OFFER}"];
    if (priceBand) filters.push(`price:[${BUY_MIN}..${BUY_MAX}]`, "priceCurrency:GBP");
    url.searchParams.set("filter", filters.join(","));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      log(`  ! "${keywords}" failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const body = (await res.json()) as { total?: number };
    return typeof body.total === "number" ? body.total : null;
  }

  const fmt = (n: number | null) => (n === null ? "  error" : n.toLocaleString("en-GB"));

  interface Row extends Probe {
    rawAll: number | null;
    rawBuyable: number | null;
    psaSlabs: number | null;
  }
  const rows: Row[] = [];

  for (const probe of PROBES) {
    const rawAll = await total(probe.raw, false);
    const rawBuyable = await total(probe.raw, true);
    const psaSlabs = await total(probe.psa, false);
    rows.push({ ...probe, rawAll, rawBuyable, psaSlabs });
    log(`  checked ${probe.label}`);
  }

  // Ranked by the slab market, because that is what decides whether grading
  // the game is a business — not by how many cards are lying around.
  rows.sort((a, b) => (b.psaSlabs ?? -1) - (a.psaSlabs ?? -1));

  log("");
  log("=".repeat(86));
  log(
    pad("GAME", 24) +
      padLeft("RAW (all)", 12) +
      padLeft(`RAW £${BUY_MIN}-${BUY_MAX}`, 16) +
      padLeft("PSA SLABS", 12) +
      padLeft("SLAB:RAW", 12),
  );
  log("-".repeat(86));
  for (const row of rows) {
    const ratio =
      row.psaSlabs !== null && row.rawAll !== null && row.rawAll > 0
        ? `${((row.psaSlabs / row.rawAll) * 100).toFixed(1)}%`
        : "—";
    log(
      pad(row.label, 24) +
        padLeft(fmt(row.rawAll), 12) +
        padLeft(fmt(row.rawBuyable), 16) +
        padLeft(fmt(row.psaSlabs), 12) +
        padLeft(ratio, 12),
    );
  }
  log("=".repeat(86));
  log("");
  log("READ IT LIKE THIS:");
  log(`  RAW £${BUY_MIN}-${BUY_MAX}  what there is to BUY in the band the business operates in.`);
  log("  PSA SLABS      how deep the market you would be SELLING into is.");
  log("  SLAB:RAW       how normal it is to grade this game at all. A game with");
  log("                 plenty of raw supply and a thin slab column is a trap:");
  log("                 you can buy all day and have nobody to sell to.");
  log("");
  log("These are keyword matches, not category counts — good for comparing games");
  log("against each other, not for quoting as inventory.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
