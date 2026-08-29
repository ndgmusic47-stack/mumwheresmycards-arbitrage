import { Db, type ScanRunRow, type CardRow } from "@mwmc/db";
import { buildOpportunities, rankForEbaySearch } from "@mwmc/core";
import type { RawCardIdentity, ListingCandidate } from "@mwmc/core";
import {
  createMarketDataProvider,
  createEbayListingsProvider,
  createCatalogueProvider,
  MarketSnapshotCache,
} from "@mwmc/providers";
import { loadSettings } from "../repo/settingsRepo.js";
import { markCardEbayScanned } from "../repo/cardsRepo.js";
import { upsertListing } from "../repo/listingsRepo.js";
import { upsertOpportunity } from "../repo/opportunitiesRepo.js";
import { listEligibleUniverseCards } from "../repo/marketProfilesRepo.js";
import { runCatalogueSyncJob } from "../catalogue/runCatalogueSyncJob.js";
import { runMarketProfiling } from "./marketProfiling.js";
import { reconcileIdentityWithTitle } from "./titleParser.js";
import type { Env } from "../env.js";

/** Per-run cap on how many cards get a (re)computed market profile — keeps
 *  a single scan bounded on a large catalogue; the next run picks up
 *  whichever cards are still stale (see selectCardsNeedingProfileRefresh). */
const MAX_CARDS_PROFILED_PER_RUN = 200;

/**
 * One full scan, following the realignment pipeline (ARCHITECTURE.md):
 *
 *   CATALOGUE SYNC (bootstraps/refreshes `cards` + `external_card_refs`
 *   automatically — see apps/worker/src/catalogue/)
 *     -> MARKET PROFILING (CARD MARKET layer: computes the Dynamic Flip
 *        Universe / Dynamic Grade Universe across catalogued cards, from
 *        market data alone, BEFORE any eBay search)
 *     -> PRIORITIZED EBAY SEARCH (LIVE SUPPLY layer: only searches eBay
 *        for the highest-priority universe members, bounded by an API
 *        budget — never blindly across the whole catalogue)
 *     -> OPPORTUNITY ENGINE (OPPORTUNITY layer: packages/core's pure
 *        buildOpportunities(), unchanged, turns a real listing + card into
 *        a real forecasted trade)
 *
 * This is the ONLY place that wires real providers + D1 persistence
 * around packages/core's pure functions.
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
      fxRates: settings.fxRates,
    });
    const catalogueProvider = createCatalogueProvider(env.MARKET_PROVIDER, {
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

    // --- 1. CATALOGUE SYNC — bootstrap/refresh `cards` automatically. -----
    // Non-fatal: a sync hiccup shouldn't block scoring whatever cards are
    // already known, so failures are logged and the scan continues.
    try {
      const syncResult = await runCatalogueSyncJob(db, catalogueProvider, settings.catalogueSync);
      if (syncResult.status === "FAILED") {
        errors.push(`Catalogue sync failed: ${syncResult.errors ?? "unknown error"}`);
      }
    } catch (err) {
      errors.push(`Catalogue sync threw: ${String(err)}`);
    }

    // --- 2. MARKET PROFILING (CARD MARKET layer) — compute Dynamic Flip/
    // Grade Universe membership across catalogued cards, from market data
    // alone, bounded to a per-run budget so this scales to a large
    // catalogue without re-profiling everything on every tick. Extracted
    // into marketProfiling.ts so the same step can run standalone (no
    // eBay) via POST /catalogue/sync-and-profile. ------------------------
    const profilingResult = await runMarketProfiling(
      db,
      marketProvider,
      marketCache,
      settings,
      MAX_CARDS_PROFILED_PER_RUN,
      Number(env.DEFAULT_MARKET_REFRESH_HOURS) || 12,
    );
    const snapshotByCardId = profilingResult.snapshotByCardId;
    snapshotsFetched += profilingResult.snapshotsFetched;
    errors.push(...profilingResult.errors);

    // --- 3. PRIORITIZED EBAY SEARCH (LIVE SUPPLY layer) — only search
    // eBay for the highest-priority Dynamic Flip/Grade Universe members,
    // never blindly across the whole catalogue. --------------------------
    const universe = await listEligibleUniverseCards(db);
    const prioritized = rankForEbaySearch(Array.from(universe.values()), settings.ebayScanBudget.maxCardsSearchedPerRun);

    const cardRowById = new Map<string, CardRow>(profilingResult.profiledCardRows.map((c) => [c.id, c]));
    const listingCandidates: ListingCandidate[] = [];

    for (const prioritizedCard of prioritized) {
      let cardRow = cardRowById.get(prioritizedCard.cardId);
      if (!cardRow) {
        cardRow = (await db.queryFirst<CardRow>(`SELECT * FROM cards WHERE id = ?`, prioritizedCard.cardId)) ?? undefined;
      }
      if (!cardRow) continue;

      const targetIdentity = rowToIdentity(cardRow);

      try {
        const keywords = `${cardRow.name} ${cardRow.set_name} ${cardRow.card_number}`;
        const rawListings = await ebayProvider.searchActiveListings({
          keywords,
          limit: settings.ebayScanBudget.maxListingsPerCardSearch,
        });
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

        await markCardEbayScanned(db, cardRow.id);
      } catch (err) {
        errors.push(`eBay search failed for ${cardRow.name} (${cardRow.id}): ${String(err)}`);
      }
    }

    // --- 4. OPPORTUNITY ENGINE (OPPORTUNITY layer) — unchanged pure
    // function, fed by real listings + the market snapshots gathered
    // during profiling above. -------------------------------------------
    const candidates = buildOpportunities(
      listingCandidates,
      snapshotByCardId,
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

function rowToIdentity(row: CardRow): RawCardIdentity {
  return {
    game: "pokemon",
    name: row.name,
    setName: row.set_name,
    setCode: row.set_code,
    cardNumber: row.card_number,
    // row.year may be null (unresolved release year — see CardPrinting.year
    // doc comment); RawCardIdentity.year is `number | undefined`, and year
    // is not a required identity field either way, so null collapses to
    // undefined here rather than needing special handling downstream.
    year: row.year ?? undefined,
    language: row.language as RawCardIdentity["language"],
    edition: row.edition as RawCardIdentity["edition"],
    variant: row.variant as RawCardIdentity["variant"],
    finish: row.finish as RawCardIdentity["finish"],
    rarity: row.rarity ?? undefined,
    stampType: row.stamp_type ?? undefined,
  };
}
