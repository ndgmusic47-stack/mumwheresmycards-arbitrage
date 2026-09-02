import { Db, type ScanRunRow, type CardRow } from "@mwmc/db";
import { buildOpportunities, rankForEbaySearch, groupCardsBySearchKeyword } from "@mwmc/core";
import type { RawCardIdentity, ListingCandidate } from "@mwmc/core";
import {
  createMarketDataProvider,
  createEbayListingsProvider,
  createCatalogueProvider,
  MarketSnapshotCache,
} from "@mwmc/providers";
import { loadSettings, usdPerGbpFrom } from "../repo/settingsRepo.js";
import { markCardEbayScanned } from "../repo/cardsRepo.js";
import { upsertListing, expireEndedAuctionListings } from "../repo/listingsRepo.js";
import { upsertOpportunity } from "../repo/opportunitiesRepo.js";
import { listEligibleUniverseCards } from "../repo/marketProfilesRepo.js";
import { runCatalogueSyncJob } from "../catalogue/runCatalogueSyncJob.js";
import { runMarketProfiling, hydrateStoredSnapshots } from "./marketProfiling.js";
import { reconcileIdentityWithTitle } from "./titleParser.js";
import type { Env } from "../env.js";

/** Per-run cap on how many cards get a (re)computed market profile — keeps
 *  a single scan bounded on a large catalogue; the next run picks up
 *  whichever cards are still stale (see selectCardsNeedingProfileRefresh). */
const MAX_CARDS_PROFILED_PER_RUN = 200;

/**
 * STABILISATION item 11: headroom applied on top of the market-profile
 * layer's derived acquisition ceiling before it's used as an eBay search
 * price filter. The ceiling itself is an exact economic bound (see
 * marketProfilesRepo.ts's deriveGradeMaxAcquisitionPrice and
 * flipProfile.ts), but it's computed from the LAST profiling run's
 * settings/snapshot — if settings changed or the snapshot has since moved
 * favourably and this card hasn't been re-profiled yet (profiling is
 * budget-capped per run, see MAX_CARDS_PROFILED_PER_RUN), the true current
 * ceiling could be slightly higher than what's stored. This margin exists
 * purely to absorb that staleness window, not because the ceiling itself is
 * a soft/heuristic number — it is deliberately small.
 */
const MAX_ACQUISITION_PRICE_SAFETY_MARGIN = 1.25;

/** Rounds up to the nearest penny — used only for the price-filter ceiling
 *  above, where rounding DOWN could clip a listing at exactly the boundary. */
function round2Up(value: number): number {
  return Math.ceil(value * 100) / 100;
}

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
export interface ScanRunResult {
  scanRun: ScanRunRow;
  /** STABILISATION item 3 (coverage transparency) — not persisted to
   *  scan_runs (no schema change needed for a surgical fix), just returned
   *  live from this specific run so the dashboard can show "profiled X /
   *  searched Y this run" straight from the trigger response. */
  cardsProfiledThisRun: number;
  cardsSearchedThisRun: number;
  /** STABILISATION item 11 (efficiency) — the actual number of outbound
   *  eBay HTTP calls this run made, as distinct from cardsSearchedThisRun
   *  (how many universe members were covered). Cards that share an
   *  identical search keyword (e.g. two printings of the same card
   *  differing only in edition) are grouped into ONE call — see
   *  groupCardsBySearchKeyword. This will be <= cardsSearchedThisRun, and
   *  the gap between them is the direct, visible measure of the dedup win. */
  ebayApiCallsThisRun: number;
  /** STABILISATION item 7 (dedup) — how many raw listing entries this run's
   *  card searches surfaced more than once (same real eBay item, found via
   *  two different card searches). buildOpportunities() already collapses
   *  these deterministically either way; this is purely for visibility. */
  duplicateListingsThisRun: number;
  /** STABILISATION item 8 (freshness) — AUCTION listings transitioned to
   *  'ENDED' this run because their end_time had passed. */
  endedAuctionListingsExpiredThisRun: number;
}

export async function runScan(env: Env, trigger: "CRON" | "MANUAL"): Promise<ScanRunResult> {
  const db = new Db(env.DB);
  const scanRunId = crypto.randomUUID();
  await db.exec(`INSERT INTO scan_runs (id, trigger, status) VALUES (?, ?, 'RUNNING')`, scanRunId, trigger);

  const errors: string[] = [];
  let listingsFetched = 0;
  let snapshotsFetched = 0;
  let created = 0;
  let updated = 0;
  let cardsProfiledThisRun = 0;
  let cardsSearchedThisRun = 0;
  let ebayApiCallsThisRun = 0;
  let duplicateListingsThisRun = 0;
  let endedAuctionListingsExpiredThisRun = 0;

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
    cardsProfiledThisRun = profilingResult.cardsProfiled;
    errors.push(...profilingResult.errors);

    // --- 3. PRIORITIZED EBAY SEARCH (LIVE SUPPLY layer) — only search
    // eBay for the highest-priority Dynamic Flip/Grade Universe members,
    // never blindly across the whole catalogue. --------------------------
    const universe = await listEligibleUniverseCards(db);
    const prioritized = rankForEbaySearch(Array.from(universe.values()), settings.ebayScanBudget.maxCardsSearchedPerRun);
    cardsSearchedThisRun = prioritized.length;

    const cardRowById = new Map<string, CardRow>(profilingResult.profiledCardRows.map((c) => [c.id, c]));
    const listingCandidates: ListingCandidate[] = [];

    // Resolve every prioritised card's row + search keyword up front, so
    // grouping (below) can see the whole set before any eBay call is made.
    interface SearchTarget {
      cardId: string;
      cardRow: CardRow;
      targetIdentity: RawCardIdentity;
      keywords: string;
      maxAcquisitionPrice: number | null;
    }
    const targets: SearchTarget[] = [];
    for (const prioritizedCard of prioritized) {
      let cardRow = cardRowById.get(prioritizedCard.cardId);
      if (!cardRow) {
        cardRow = (await db.queryFirst<CardRow>(`SELECT * FROM cards WHERE id = ?`, prioritizedCard.cardId)) ?? undefined;
      }
      if (!cardRow) continue;

      targets.push({
        cardId: prioritizedCard.cardId,
        cardRow,
        targetIdentity: rowToIdentity(cardRow),
        keywords: `${cardRow.name} ${cardRow.set_name} ${cardRow.card_number}`,
        maxAcquisitionPrice: prioritizedCard.maxAcquisitionPrice,
      });
    }
    const targetsByCardId = new Map(targets.map((t) => [t.cardId, t]));

    // STABILISATION item 11 ("avoid duplicate eBay calls"): different
    // eligible printings of the same card (edition/finish/variant/language
    // vary, name+set+number don't) routinely share an identical search
    // string — group them so each distinct keyword is only searched once,
    // then reconcile that one call's results against every card in the
    // group. See searchGrouping.ts's doc comment for why this is safe: it's
    // the same per-target identity reconciliation that would have happened
    // across separate calls anyway, and buildOpportunities() already
    // collapses same-listing duplicates deterministically (item 7).
    const groups = groupCardsBySearchKeyword(targets.map((t) => ({ cardId: t.cardId, keywords: t.keywords })));

    for (const group of groups) {
      const groupTargets = group.cardIds.map((id) => targetsByCardId.get(id)!);

      // A shared query's price ceiling must be permissive enough for
      // WHICHEVER card in the group turns out to be the real match — using
      // the lowest of the group's ceilings could hide a listing that's a
      // genuine opportunity for a higher-ceiling group member. Any member
      // with no derivable ceiling (null) means the whole group searches
      // unfiltered, rather than risk silently excluding real inventory.
      const ceilings = groupTargets.map((t) => t.maxAcquisitionPrice);
      const maxPrice = ceilings.every((c): c is number => c !== null)
        ? round2Up(Math.max(...ceilings) * MAX_ACQUISITION_PRICE_SAFETY_MARGIN)
        : undefined;

      try {
        const rawListings = await ebayProvider.searchActiveListings({
          keywords: group.keywords,
          limit: settings.ebayScanBudget.maxListingsPerCardSearch,
          maxPrice,
          sort: "NEWLY_LISTED",
        });
        ebayApiCallsThisRun++;
        listingsFetched += rawListings.length;

        for (const raw of rawListings) {
          // upsertListing is keyed by ebayItemId and idempotent, but it's
          // still one D1 write per call — only make it once per raw
          // listing, not once per card in the group.
          await upsertListing(db, raw, null, 0, null);

          for (const target of groupTargets) {
            const candidateIdentity: RawCardIdentity =
              Object.keys(raw.parsedIdentity).length > 0
                ? (raw.parsedIdentity as unknown as RawCardIdentity)
                : reconcileIdentityWithTitle(target.targetIdentity, raw.title);

            listingCandidates.push({
              listingId: raw.ebayItemId,
              title: raw.title,
              price: raw.price,
              shippingCost: raw.shippingCost,
              itemUrl: raw.itemUrl,
              sellerFeedbackScore: raw.sellerFeedbackScore,
              sellerFeedbackPct: raw.sellerFeedbackPct,
              parsedIdentity: candidateIdentity,
              // STABILISATION item 6 (classification): both already exist on
              // the raw eBay listing and are already persisted by
              // upsertListing() above — previously dropped here before ever
              // reaching the engine, so the AUCTION-price caveat (see
              // engine.ts) and item condition never made it past this point.
              listingType: raw.listingType,
              itemCondition: raw.itemCondition,
            });
          }
        }

        for (const target of groupTargets) {
          await markCardEbayScanned(db, target.cardRow.id);
        }
      } catch (err) {
        for (const target of groupTargets) {
          errors.push(`eBay search failed for ${target.cardRow.name} (${target.cardRow.id}): ${String(err)}`);
        }
      }
    }

    // STABILISATION item 8 (freshness/lifecycle) — the one listing-status
    // transition we can make without guessing: an AUCTION past its known
    // end_time is provably no longer purchasable at its last-seen price.
    // See listingsRepo.ts's expireEndedAuctionListings() doc comment for
    // why this deliberately does NOT extend to FIXED/BEST_OFFER staleness.
    try {
      endedAuctionListingsExpiredThisRun = await expireEndedAuctionListings(db);
    } catch (err) {
      errors.push(`Expiring ended auction listings failed: ${String(err)}`);
    }

    // --- 3.5. SNAPSHOT HYDRATION (STABILISATION item 4) — snapshotByCardId
    // above only covers cards actually (re)profiled THIS run (budget-capped
    // in step 2), but the eBay-search step just searched cards from the
    // FULL eligible universe. A card searched this run that wasn't also
    // profiled this run would otherwise show NO_MARKET_DATA even when a
    // perfectly valid snapshot already sits in D1 from an earlier run.
    // Preference order: current-run snapshot (already in the map, never
    // overwritten here) -> latest stored D1 snapshot -> NO_MARKET_DATA only
    // if neither exists. See marketProfiling.ts's hydrateStoredSnapshots
    // doc comment for the full root cause. --------------------------------
    const cardIdsMissingSnapshot = prioritized.map((p) => p.cardId).filter((id) => !snapshotByCardId.has(id));
    if (cardIdsMissingSnapshot.length > 0) {
      const hydrated = await hydrateStoredSnapshots(db, cardIdsMissingSnapshot);
      for (const [cardId, snapshot] of hydrated) {
        snapshotByCardId.set(cardId, snapshot);
      }
    }

    // STABILISATION item 7 (dedup) — purely for scan-summary transparency:
    // buildOpportunities() itself now collapses same-listing duplicates
    // deterministically (see its own doc comment), this just counts how
    // many raw listing entries this run's card searches surfaced more than
    // once, so a scan-result panel can show it rather than it being
    // invisible either way.
    const uniqueListingIds = new Set(listingCandidates.map((l) => l.listingId));
    duplicateListingsThisRun = listingCandidates.length - uniqueListingIds.size;

    // --- 4. OPPORTUNITY ENGINE (OPPORTUNITY layer) — unchanged pure
    // function, fed by real listings + the market snapshots gathered
    // during profiling above. -------------------------------------------
    const candidates = buildOpportunities(listingCandidates, snapshotByCardId, {
      qualification: settings.qualification,
      qsvSettings: settings.qsvSettings,
      feeModel: settings.feeModel,
      sellingCosts: settings.sellingCosts,
      gradingServices: settings.gradingServices,
      gradingBatch: settings.gradingBatch,
      gradingConsumables: settings.gradingConsumables,
      classificationSettings: settings.classificationSettings,
      flipScoreWeights: settings.flipScoreWeights,
      gradeScoreWeights: settings.gradeScoreWeights,
      usdPerGbp: usdPerGbpFrom(settings.fxRates),
    });

    let identityUncertainCount = 0;
    let uncataloguedCount = 0;
    let noMarketDataCount = 0;
    let computationErrorCount = 0;
    for (const candidate of candidates) {
      // One bad candidate must never abort the whole scan — a single
      // unpersistable listing used to take the entire run down with it.
      try {
        const outcome = await upsertOpportunity(db, candidate, scanRunId);

        if (outcome === "created") created++;
        else if (outcome === "updated") updated++;
        else if (outcome === "skipped_uncatalogued_card") uncataloguedCount++;
        else if (outcome === "skipped_no_market_data") noMarketDataCount++;
        else if (outcome === "skipped_computation_error") computationErrorCount++;
        else identityUncertainCount++;

        // Only link the listing to a card we actually persisted an
        // opportunity for — ebay_listings.card_id is a foreign key too, so
        // writing an uncatalogued printing here fails exactly the same way.
        if (outcome === "created" || outcome === "updated") {
          await db.exec(
            `UPDATE ebay_listings SET card_id = ?, identity_confidence = ? WHERE id = ?`,
            candidate.cardPrintingHash,
            candidate.identityConfidence,
            candidate.listingId,
          );
        }
      } catch (err) {
        errors.push(`Failed to persist opportunity for listing ${candidate.listingId}: ${String(err)}`);
      }
    }
    if (identityUncertainCount > 0) {
      errors.push(
        `${identityUncertainCount} listing(s) could not be confidently matched to a catalogued card and were not saved as opportunities — see reasoning per candidate for why (missing required identity field(s), or resolved with too-low confidence).`,
      );
    }
    if (uncataloguedCount > 0) {
      errors.push(
        `${uncataloguedCount} listing(s) resolved to a card printing that is not in the catalogue, so no opportunity was saved for them. This is expected — an eBay search for one card returns others — but a persistently high count suggests the catalogue is too narrow for what is being searched.`,
      );
    }
    if (noMarketDataCount > 0) {
      errors.push(
        `${noMarketDataCount} listing(s) resolved to a catalogued card that has no market snapshot yet, so nothing could be priced and no opportunity was saved for them. Run "Sync catalogue (no eBay)" on the Market page to backfill pricing for more of the catalogue, then re-scan.`,
      );
    }
    if (computationErrorCount > 0) {
      errors.push(
        `${computationErrorCount} listing(s) had pricing eBay itself returned that the economics engine rejected as invalid (e.g. a £0 price, or a currency with no configured FX rate) — no opportunity was saved for them, but the rest of the scan completed normally. See each candidate's reasoning for the specific listing and cause.`,
      );
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
  return {
    scanRun: finalRow!,
    cardsProfiledThisRun,
    cardsSearchedThisRun,
    ebayApiCallsThisRun,
    duplicateListingsThisRun,
    endedAuctionListingsExpiredThisRun,
  };
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
