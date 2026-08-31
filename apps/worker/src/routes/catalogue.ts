import { Hono } from "hono";
import { Db, type CatalogueSyncRunRow, type CatalogueSyncCheckpointRow } from "@mwmc/db";
import { createCatalogueProvider, createMarketDataProvider, MarketSnapshotCache } from "@mwmc/providers";
import type { Env } from "../env.js";
import { loadSettings } from "../repo/settingsRepo.js";
import { runCatalogueSyncJob } from "../catalogue/runCatalogueSyncJob.js";
import { runMarketProfiling } from "../scan/marketProfiling.js";

export const catalogueRoute = new Hono<{ Bindings: Env }>();

/** Sync status/history — lets the dashboard show sync progress (pages
 *  fetched, cards inserted/updated/skipped, last completed full pass). */
catalogueRoute.get("/status", async (c) => {
  const db = new Db(c.env.DB);
  const checkpoint = await db.queryFirst<CatalogueSyncCheckpointRow>(
    `SELECT * FROM catalogue_sync_checkpoint WHERE provider = ?`,
    c.env.MARKET_PROVIDER,
  );
  const runs = await db.queryAll<CatalogueSyncRunRow>(
    `SELECT * FROM catalogue_sync_runs WHERE provider = ? ORDER BY started_at DESC LIMIT 20`,
    c.env.MARKET_PROVIDER,
  );
  return c.json({ checkpoint, runs });
});

/** Manual sync trigger — runs the same bounded, resumable sync step scans
 *  run automatically, for ops use (e.g. to bootstrap a fresh DB immediately
 *  rather than waiting for the next scheduled scan). */
catalogueRoute.post("/sync", async (c) => {
  const db = new Db(c.env.DB);
  const settings = await loadSettings(db);
  const provider = createCatalogueProvider(c.env.MARKET_PROVIDER, {
    poketraceApiKey: c.env.POKETRACE_API_KEY,
    poketraceBaseUrl: c.env.POKETRACE_API_BASE_URL,
  });
  const run = await runCatalogueSyncJob(db, provider, settings.catalogueSync);
  return c.json({ syncRun: run });
});

/**
 * Controlled, eBay-free validation run: catalogue sync (step 1 of
 * scanRunner.ts) followed by market profiling (step 2) ONLY — never reaches
 * step 3 (eBay search), since that's a separate quota/budget decision this
 * endpoint has no business making on its own. Exists specifically to let a
 * bounded slice of REAL PokeTrace data (a couple hundred cards, not the
 * whole catalogue) get pulled into a LOCAL D1 database and inspected, to
 * validate:
 *  - the year-optional catalogue model (packages/core CardPrinting.year) —
 *    see `cardsWithNullYear` below,
 *  - whether/how often the same internal card actually picks up more than
 *    one external_card_refs row from the same provider, and which markets
 *    are involved — see `multiMarketCards` below. This is the real
 *    evidence findExternalRefForCard's placeholder market preference
 *    (externalCardRefsRepo.ts) needs before it can become a confirmed
 *    rule rather than a documented guess.
 *
 * Body (all optional, all override settings for THIS call only — nothing
 * persisted): { maxPagesPerRun, pageSize, maxCardsProfiled }. Defaults are
 * deliberately small (pageSize 20 x maxPagesPerRun 8 = up to 160 cards)
 * rather than reusing the full-catalogue settings default, so a first run
 * against real credentials can't accidentally walk the entire catalogue.
 */
catalogueRoute.post("/sync-and-profile", async (c) => {
  const db = new Db(c.env.DB);
  const settings = await loadSettings(db);
  const body = await c.req.json().catch(() => ({}));
  const maxPagesPerRun = Number(body.maxPagesPerRun) || 8;
  const pageSize = Number(body.pageSize) || 20;
  const maxCardsProfiled = Number(body.maxCardsProfiled) || 200;

  const catalogueProvider = createCatalogueProvider(c.env.MARKET_PROVIDER, {
    poketraceApiKey: c.env.POKETRACE_API_KEY,
    poketraceBaseUrl: c.env.POKETRACE_API_BASE_URL,
  });
  const marketProvider = createMarketDataProvider(c.env.MARKET_PROVIDER, {
    poketraceApiKey: c.env.POKETRACE_API_KEY,
    poketraceBaseUrl: c.env.POKETRACE_API_BASE_URL,
    fxRates: settings.fxRates,
  });
  const marketCache = new MarketSnapshotCache(db, marketProvider, {
    ttlHours: Number(c.env.DEFAULT_MARKET_REFRESH_HOURS) || 12,
    scanRunId: null,
  });

  const syncRun = await runCatalogueSyncJob(db, catalogueProvider, { maxPagesPerRun, pageSize });

  const profiling = await runMarketProfiling(
    db,
    marketProvider,
    marketCache,
    settings,
    maxCardsProfiled,
    Number(c.env.DEFAULT_MARKET_REFRESH_HOURS) || 12,
  );

  const [
    cardsIndexed,
    cardsWithNullYear,
    cardsWithRawValue,
    cardsWithAnyPsaGrade,
    multiMarketCards,
    qsvCoverage,
    classCounts,
    eligibility,
  ] = await Promise.all([
    db.queryFirst<{ n: number }>(`SELECT COUNT(*) as n FROM cards`),
    db.queryFirst<{ n: number }>(`SELECT COUNT(*) as n FROM cards WHERE year IS NULL`),
    db.queryFirst<{ n: number }>(`SELECT COUNT(*) as n FROM flip_profiles WHERE raw_market_value IS NOT NULL`),
    db.queryFirst<{ n: number }>(
      `SELECT COUNT(*) as n FROM grade_profiles WHERE psa7 IS NOT NULL OR psa8 IS NOT NULL OR psa9 IS NOT NULL OR psa10 IS NOT NULL`,
    ),
    db.queryAll<{ internal_card_id: string; ref_count: number; markets: string }>(
      `SELECT internal_card_id, COUNT(*) as ref_count, GROUP_CONCAT(market) as markets
       FROM external_card_refs
       WHERE provider = ?
       GROUP BY internal_card_id
       HAVING COUNT(*) > 1
       ORDER BY ref_count DESC
       LIMIT 25`,
      marketProvider.name,
    ),
    // THE make-or-break question for the raw-flip business: does this
    // provider actually return SOLD MEDIANS for real cards? QSV is defined
    // as the lower of the 7d/30d sold medians less a haircut, and a flip
    // priced off anything else cannot qualify by design. If both medians
    // come back overwhelmingly null on real data, the flip side produces
    // zero opportunities no matter how good the listings are — and the QSV
    // definition needs revisiting against what the provider can actually
    // supply, rather than being quietly loosened to let averages back in.
    db.queryFirst<{
      snapshots: number;
      with_7d: number;
      with_30d: number;
      with_both: number;
      with_neither: number;
      high_confidence: number;
    }>(
      `SELECT
         COUNT(*) as snapshots,
         SUM(CASE WHEN raw_median_7d IS NOT NULL THEN 1 ELSE 0 END) as with_7d,
         SUM(CASE WHEN raw_median_30d IS NOT NULL THEN 1 ELSE 0 END) as with_30d,
         SUM(CASE WHEN raw_median_7d IS NOT NULL AND raw_median_30d IS NOT NULL THEN 1 ELSE 0 END) as with_both,
         SUM(CASE WHEN raw_median_7d IS NULL AND raw_median_30d IS NULL THEN 1 ELSE 0 END) as with_neither,
         SUM(CASE WHEN is_high_confidence_qsv = 1 THEN 1 ELSE 0 END) as high_confidence
       FROM market_snapshots`,
    ),
    // How the catalogue breaks down by grading economic structure.
    db.queryAll<{ economic_class: string | null; n: number }>(
      `SELECT economic_class, COUNT(*) as n FROM grade_profiles GROUP BY economic_class ORDER BY n DESC`,
    ),
    db.queryFirst<{ flip_eligible: number; grade_eligible: number }>(
      `SELECT
         (SELECT COUNT(*) FROM flip_profiles WHERE eligible = 1) as flip_eligible,
         (SELECT COUNT(*) FROM grade_profiles WHERE eligible = 1) as grade_eligible`,
    ),
  ]);

  return c.json({
    ranAgainst: c.env.MARKET_PROVIDER,
    catalogueSync: syncRun,
    marketProfiling: {
      cardsConsidered: profiling.cardsConsidered,
      cardsProfiled: profiling.cardsProfiled,
      cardsMissingExternalRef: profiling.cardsMissingExternalRef,
      cardsMissingSnapshot: profiling.cardsMissingSnapshot,
      snapshotsFetched: profiling.snapshotsFetched,
      errors: profiling.errors,
    },
    catalogueTotals: {
      cardsIndexed: cardsIndexed?.n ?? 0,
      cardsWithNullYear: cardsWithNullYear?.n ?? 0,
      cardsWithRawValue: cardsWithRawValue?.n ?? 0,
      cardsWithAnyPsaGrade: cardsWithAnyPsaGrade?.n ?? 0,
    },
    // THE key evidence for the market-preference decision (see doc comment
    // above): every internal card with more than one external_card_refs row
    // from this provider, and which markets those rows actually are.
    multiMarketCards: {
      count: multiMarketCards.length,
      preferenceCurrentlyUsed: settings.externalRefMarketPreference,
      samples: multiMarketCards,
    },
    // Does the provider actually supply the sold medians QSV depends on?
    qsvCoverage: {
      snapshots: qsvCoverage?.snapshots ?? 0,
      withSevenDayMedian: qsvCoverage?.with_7d ?? 0,
      withThirtyDayMedian: qsvCoverage?.with_30d ?? 0,
      withBothMedians: qsvCoverage?.with_both ?? 0,
      withNeitherMedian: qsvCoverage?.with_neither ?? 0,
      highConfidenceQsv: qsvCoverage?.high_confidence ?? 0,
      note: "QSV = min(7d sold median, 30d sold median) x (1 - haircut). A flip priced from a fallback reference instead of a sold median can never qualify. If withNeitherMedian dominates, the raw-flip business cannot run on this provider's data as currently modelled.",
    },
    // Which grading structures the real catalogue actually contains.
    gradeEconomicClasses: classCounts,
    universeEligibility: {
      flipEligible: eligibility?.flip_eligible ?? 0,
      gradeEligible: eligibility?.grade_eligible ?? 0,
    },
  });
});
