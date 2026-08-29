import { Db, type CardRow, type ScanRunRow } from "@mwmc/db";
import { resolveCardPrinting, buildOpportunities } from "@mwmc/core";
import type { RawCardIdentity, ListingCandidate, MarketSnapshotLike } from "@mwmc/core";
import { createMarketDataProvider, createEbayListingsProvider, MarketSnapshotCache, MARKET_FIXTURE_IDENTITIES } from "@mwmc/providers";
import { loadSettings } from "../repo/settingsRepo.js";
import { upsertCard } from "../repo/cardsRepo.js";
import { upsertListing } from "../repo/listingsRepo.js";
import { upsertOpportunity } from "../repo/opportunitiesRepo.js";
import { reconcileIdentityWithTitle } from "./titleParser.js";
import type { Env } from "../env.js";

/**
 * One full scan: resolve scan targets -> refresh market data (via the
 * D1-backed cache, so API cost is controlled) -> pull active eBay
 * listings -> run the pure opportunity engine -> persist results.
 *
 * This is the ONLY place that wires real providers + D1 persistence
 * around packages/core's pure buildOpportunities() — see ARCHITECTURE.md
 * section 6.
 */
export async function runScan(env: Env, trigger: "CRON" | "MANUAL"): Promise<ScanRunRow> {
  const db = new Db(env.DB);
  const scanRunId = crypto.randomUUID();
  await db.exec(`INSERT INTO scan_runs (id, trigger, status) VALUES (?, ?, 'RUNNING')`, scanRunId, trigger);

  const errors: string[] = [];
  let listingsFetched = 0;
  let snapshotsFetched = 0;
  let created = 0;
  let updated = 0;

  try {
    const settings = await loadSettings(db);

    const marketProvider = createMarketDataProvider(env.MARKET_PROVIDER, {
      poketraceApiKey: env.POKETRACE_API_KEY,
      poketraceBaseUrl: env.POKETRACE_API_BASE_URL,
    });
    const ebayProvider = createEbayListingsProvider(env.EBAY_PROVIDER, {
      clientId: env.EBAY_CLIENT_ID,
      clientSecret: env.EBAY_CLIENT_SECRET,
      marketplaceId: env.EBAY_MARKETPLACE_ID,
      oauthScope: env.EBAY_OAUTH_SCOPE,
    });
    const marketCache = new MarketSnapshotCache(db, marketProvider, {
      ttlHours: Number(env.DEFAULT_MARKET_REFRESH_HOURS) || 12,
      scanRunId,
    });

    const targets = await getScanTargets(db, env.MARKET_PROVIDER);
    const listingCandidates: ListingCandidate[] = [];
    const snapshotMap = new Map<string, MarketSnapshotLike>();

    for (const targetIdentity of targets) {
      const resolved = resolveCardPrinting(targetIdentity);
      if (!resolved.ok || !resolved.printing) {
        errors.push(`Scan target has incomplete identity: ${JSON.stringify(targetIdentity)}`);
        continue;
      }
      const printing = resolved.printing;
      await upsertCard(db, printing);

      try {
        const snapshot = await marketCache.getSnapshot(printing);
        if (snapshot) {
          snapshotsFetched++;
          snapshotMap.set(printing.printingHash, snapshot);
        }
      } catch (err) {
        errors.push(`Market snapshot failed for ${printing.name} (${printing.printingHash}): ${String(err)}`);
      }

      try {
        const keywords = `${printing.name} ${printing.setName} ${printing.cardNumber}`;
        const rawListings = await ebayProvider.searchActiveListings({ keywords, limit: 20 });
        listingsFetched += rawListings.length;

        for (const raw of rawListings) {
          const candidateIdentity: RawCardIdentity =
            Object.keys(raw.parsedIdentity).length > 0
              ? (raw.parsedIdentity as unknown as RawCardIdentity)
              : reconcileIdentityWithTitle(targetIdentity, raw.title);

          listingCandidates.push({
            listingId: raw.ebayItemId,
            title: raw.title,
            price: raw.price,
            shippingCost: raw.shippingCost,
            itemUrl: raw.itemUrl,
            sellerFeedbackScore: raw.sellerFeedbackScore,
            sellerFeedbackPct: raw.sellerFeedbackPct,
            parsedIdentity: candidateIdentity,
          });

          await upsertListing(db, raw, null, 0, null);
        }
      } catch (err) {
        errors.push(`eBay search failed for ${printing.name} (${printing.printingHash}): ${String(err)}`);
      }
    }

    const candidates = buildOpportunities(
      listingCandidates,
      snapshotMap,
      {
        filters: settings.filters,
        flipScoreWeights: settings.flipScoreWeights,
        gradeScoreWeights: settings.gradeScoreWeights,
      },
      settings.feeSchedule,
    );

    for (const candidate of candidates) {
      if (candidate.cardPrintingHash) {
        await db.exec(
          `UPDATE ebay_listings SET card_id = ?, identity_confidence = ? WHERE id = ?`,
          candidate.cardPrintingHash,
          candidate.confidence,
          candidate.listingId,
        );
      }
      const outcome = await upsertOpportunity(db, candidate, scanRunId);
      if (outcome === "created") created++;
      else updated++;
    }

    const apiCallsRow = await db.queryFirst<{ n: number }>(
      `SELECT COUNT(*) as n FROM api_usage WHERE scan_run_id = ?`,
      scanRunId,
    );

    await db.exec(
      `UPDATE scan_runs SET
         status = ?, finished_at = datetime('now'), listings_fetched = ?, market_snapshots_fetched = ?,
         opportunities_created = ?, opportunities_updated = ?, api_calls_made = ?, errors = ?
       WHERE id = ?`,
      errors.length > 0 ? "PARTIAL" : "SUCCESS",
      listingsFetched,
      snapshotsFetched,
      created,
      updated,
      apiCallsRow?.n ?? 0,
      errors.length ? JSON.stringify(errors) : null,
      scanRunId,
    );
  } catch (err) {
    await db.exec(
      `UPDATE scan_runs SET status = 'FAILED', finished_at = datetime('now'), errors = ? WHERE id = ?`,
      JSON.stringify([...errors, String(err)]),
      scanRunId,
    );
    throw err;
  }

  const finalRow = await db.queryFirst<ScanRunRow>(`SELECT * FROM scan_runs WHERE id = ?`, scanRunId);
  return finalRow!;
}

/**
 * What to search for this scan. Prefers cards already known to the system
 * (previously resolved via `cards`); falls back to the mock market
 * fixtures on a completely empty dev DB so a first scan against the mock
 * providers produces something to look at without manual seeding.
 *
 * Deliberately does NOT read `watchlist_cards` here — per spec, the seed
 * grading watchlist is data to be imported, never hardcoded into engine
 * business logic. A future import step (scripts/import-watchlist.ts)
 * resolves watchlist entries into `cards` rows, at which point they show
 * up here automatically.
 */
async function getScanTargets(db: Db, marketProviderName: string): Promise<RawCardIdentity[]> {
  const cardRows = await db.queryAll<CardRow>(`SELECT * FROM cards`);
  if (cardRows.length > 0) {
    return cardRows.map(rowToIdentity);
  }
  if (marketProviderName === "mock") {
    return MARKET_FIXTURE_IDENTITIES;
  }
  return [];
}

function rowToIdentity(row: CardRow): RawCardIdentity {
  return {
    game: "pokemon",
    name: row.name,
    setName: row.set_name,
    setCode: row.set_code,
    cardNumber: row.card_number,
    year: row.year,
    language: row.language as RawCardIdentity["language"],
    edition: row.edition as RawCardIdentity["edition"],
    variant: row.variant as RawCardIdentity["variant"],
    finish: row.finish as RawCardIdentity["finish"],
    rarity: row.rarity ?? undefined,
    stampType: row.stamp_type ?? undefined,
  };
}
