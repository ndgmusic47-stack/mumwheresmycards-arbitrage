#!/usr/bin/env node
/**
 * PHASE 2 — EBAY LIVE SMOKE TEST (read-only diagnostic, not a product feature)
 *
 * PREPARED NOW, NOT TO BE RUN YET — the eBay Developer account this
 * project will use is still pending approval as of when this was written.
 * Do not run this until real EBAY_CLIENT_ID / EBAY_CLIENT_SECRET are in
 * apps/worker/.dev.vars. Running it before then will just fail an OAuth
 * request cleanly (no crash, no partial state) — it's safe to try, but
 * there's nothing to see until real credentials exist.
 *
 * What it does once you do have credentials: gets a client-credentials
 * OAuth token (same flow as EbayBrowseProvider.ts), runs ONE small
 * EBAY_GB search, and prints a SANITIZED view of a few sample listings —
 * item id, title, price, shipping, condition, seller, seller feedback,
 * buying option, image, URL — plus the raw field names eBay actually
 * returned, so we can confirm EbayBrowseProvider.ts's field mapping
 * against a real response the same way PokeTraceProvider.ts's was
 * confirmed. Does NOT run a broad scan and does NOT print the client
 * secret or access token anywhere, ever.
 *
 * Usage (once ready):
 *   cd apps/worker
 *   npx tsx scripts/ebay-smoke-test.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Deliberately tiny — one search, a handful of results. Not a scan.
const SEARCH_QUERY = "Charizard PSA 10";
const SAMPLE_SIZE = 3;

// ---------------------------------------------------------------------------
// .dev.vars loading + redaction guard (same pattern as the PokeTrace smoke
// tests). Two secrets to guard here: the client secret AND the OAuth access
// token we get back from eBay — neither is ever printed.
// ---------------------------------------------------------------------------

function loadDevVars(): Record<string, string> {
  const path = resolve(__dirname, "..", ".dev.vars");
  if (!existsSync(path)) {
    console.error(`Could not find ${path} — copy .dev.vars.example to .dev.vars and fill in EBAY_CLIENT_ID/EBAY_CLIENT_SECRET first.`);
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
      throw new Error("Refusing to print: output contained a secret (client secret or access token). This is a bug — don't share the output.");
    }
  }
  return text;
}

function log(text: string = "") {
  console.log(safe(text));
}

// ---------------------------------------------------------------------------
// Field shape mirrored from EbayBrowseProvider.ts, so this script can report
// whether the real response matches what that adapter currently assumes.
// ---------------------------------------------------------------------------

interface EbayItemSummary {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  shippingOptions?: { shippingCost?: { value: string } }[];
  buyingOptions?: string[];
  condition?: string;
  seller?: { username?: string; feedbackScore?: number; feedbackPercentage?: string };
  itemWebUrl: string;
  image?: { imageUrl: string };
  itemLocation?: { country?: string };
}

async function main() {
  const vars = loadDevVars();
  const clientId = vars.EBAY_CLIENT_ID;
  const clientSecret = vars.EBAY_CLIENT_SECRET;
  const marketplaceId = vars.EBAY_MARKETPLACE_ID || "EBAY_GB";
  const oauthScope = vars.EBAY_OAUTH_SCOPE || "https://api.ebay.com/oauth/api_scope";

  if (!clientId || !clientSecret) {
    console.error(
      "EBAY_CLIENT_ID and/or EBAY_CLIENT_SECRET are blank in apps/worker/.dev.vars.\n" +
        "This is expected until your eBay Developer account is approved — add real credentials there when you have them, then re-run this.",
    );
    process.exit(1);
  }
  secrets.push(clientSecret);

  log("=".repeat(78));
  log("EBAY LIVE SMOKE TEST — sanitized diagnostic output only");
  log(`Marketplace: ${marketplaceId}  |  search: "${SEARCH_QUERY}"  |  sample size: ${SAMPLE_SIZE}`);
  log("Neither the client secret nor the OAuth access token is ever printed below.");
  log("=".repeat(78));

  // --- Step 1: OAuth client-credentials token --------------------------------
  log("\n--- STEP 1: POST /identity/v1/oauth2/token ---");
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenResponse = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: oauthScope }).toString(),
  });

  const tokenBodyText = await tokenResponse.text();
  if (!tokenResponse.ok) {
    throw new Error(safe(`OAuth token request failed: ${tokenResponse.status} ${tokenResponse.statusText}\nBody: ${tokenBodyText}`));
  }
  const tokenBody = JSON.parse(tokenBodyText) as { access_token: string; expires_in: number; token_type?: string };
  secrets.push(tokenBody.access_token);
  log(`✅ Got an access token (expires in ${tokenBody.expires_in}s, type=${tokenBody.token_type ?? "?"}). Token value itself is never printed.`);

  // --- Step 2: ONE small search -----------------------------------------------
  log("\n--- STEP 2: GET /buy/browse/v1/item_summary/search ---");
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", SEARCH_QUERY);
  url.searchParams.set("limit", String(SAMPLE_SIZE));

  const searchResponse = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
      Accept: "application/json",
    },
  });

  const searchBodyText = await searchResponse.text();
  if (!searchResponse.ok) {
    throw new Error(safe(`Browse search failed: ${searchResponse.status} ${searchResponse.statusText}\nBody: ${searchBodyText}`));
  }
  const searchBody = JSON.parse(searchBodyText) as { itemSummaries?: EbayItemSummary[]; total?: number };
  log(`Top-level response keys: ${Object.keys(searchBody).join(", ")}`);
  log(`Reported total matches: ${searchBody.total ?? "(not present)"}`);

  const items = searchBody.itemSummaries ?? [];
  if (items.length === 0) {
    log("⚠️  No items returned for this search — try a different SEARCH_QUERY at the top of this file.");
    return;
  }

  log(`\nFound ${items.length} sample listing(s):\n`);
  for (const item of items) {
    log(`--- raw field names: ${Object.keys(item as unknown as Record<string, unknown>).join(", ")} ---`);
    const shippingCost = item.shippingOptions?.[0]?.shippingCost?.value;
    log(
      `  itemId=${JSON.stringify(item.itemId)}\n` +
        `  title=${JSON.stringify(item.title)}\n` +
        `  price=${item.price?.value} ${item.price?.currency}\n` +
        `  shipping=${shippingCost ?? "(none listed)"}\n` +
        `  condition=${JSON.stringify(item.condition)}\n` +
        `  seller=${JSON.stringify(item.seller?.username)}  feedbackScore=${item.seller?.feedbackScore}  feedbackPct=${item.seller?.feedbackPercentage}\n` +
        `  buyingOptions=${JSON.stringify(item.buyingOptions)}\n` +
        `  image=${item.image?.imageUrl}\n` +
        `  url=${item.itemWebUrl}`,
    );
  }

  log("\n" + "=".repeat(78));
  log("Compare the raw field names above against EbayBrowseProvider.ts's EbayItemSummary");
  log("interface (itemId/title/price/shippingOptions/buyingOptions/condition/seller/");
  log("itemWebUrl/image/itemLocation) — anything missing or differently named there is");
  log("the confirmed fix needed, same approach as the PokeTrace smoke tests.");
  log("=".repeat(78));
}

main().catch((err) => {
  console.error(safe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
  process.exit(1);
});
