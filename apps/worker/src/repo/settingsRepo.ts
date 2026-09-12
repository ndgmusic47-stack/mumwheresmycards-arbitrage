import { Db, type SettingsRow, type SettingsHistoryRow } from "@mwmc/db";
import {
  DEFAULT_EXIT_MARKET_FEE_MODEL,
  DEFAULT_SELLING_COSTS,
  DEFAULT_QSV_SETTINGS,
  DEFAULT_GRADERS,
  DEFAULT_GRADING_SERVICES,
  DEFAULT_GRADING_BATCH,
  DEFAULT_GRADING_CONSUMABLES,
  DEFAULT_UPCHARGE_SETTINGS,
  DEFAULT_CLASSIFICATION_SETTINGS,
  DEFAULT_FLIP_QUALIFICATION,
  DEFAULT_GRADE_QUALIFICATION,
  DEFAULT_FLIP_SCORE_WEIGHTS,
  DEFAULT_GRADE_SCORE_WEIGHTS,
  DEFAULT_FX_RATES,
  DEFAULT_MARKET_PROFILE_SETTINGS,
  type ExitMarketFeeModel,
  type SellingCostSettings,
  type QsvSettings,
  type Grader,
  type GradingService,
  type GradingBatchSettings,
  type GradingConsumables,
  type UpchargeSettings,
  type ClassificationSettings,
  type FlipQualificationRules,
  type GradeQualificationRules,
  type QualificationRuleSet,
  type FlipScoreWeights,
  type GradeScoreWeights,
  type FxRates,
  type MarketProfileSettings,
} from "@mwmc/core";
import type { AiPricingTable, FxRatesMeta } from "@mwmc/providers";
import { DEFAULT_EXTERNAL_REF_MARKET_PREFERENCE } from "./externalCardRefsRepo.js";

export interface CatalogueSyncSettings {
  pageSize: number;
  maxPagesPerRun: number;
}

export interface EbayScanBudgetSettings {
  maxCardsSearchedPerRun: number;
  maxListingsPerCardSearch: number;
  /**
   * SOURCING WORKFLOW item 9 (two-stage enrichment): hard cap on stage-two
   * "Get Item" calls per scan run, independent of maxCardsSearchedPerRun —
   * this budgets a DIFFERENT, more expensive API call fired only for
   * candidates the engine already judged promising (see scanRunner.ts's
   * ENRICHMENT_ELIGIBLE_STATES), not one per search result. Added as a new
   * field on the existing settings object (spread over DEFAULT_EBAY_SCAN_
   * BUDGET below) rather than a new settings row/migration — an older
   * stored `ebay_scan_budget` JSON blob without this key still merges
   * cleanly with the default.
   */
  maxEnrichmentCallsPerRun: number;
}

/**
 * AI INTELLIGENCE spec Phase 2, Workstream G (caching + cost control).
 * Same "everything is a SETTINGS row" discipline as every other commercial
 * assumption in this file — nothing about AI spend is hardcoded either.
 */
export interface AiSettings {
  /** Hard daily spend ceiling in USD, across every tier combined — see
   *  AiCompletionCache.ts. `null` disables the cap entirely (not
   *  recommended once a real key is added). */
  dailySpendCapUsd: number | null;
  /** USD per 1,000,000 tokens, by tier. THESE ARE UNVERIFIED ESTIMATES —
   *  researched against public GPT-5.6 pricing pages during this spec's
   *  planning, NOT confirmed against a real invoice (no key has made a
   *  real call yet). Same "Assumptions that still need live validation"
   *  discipline as every other unverified figure in this codebase — the
   *  user should revisit these once real usage/billing data exists, which
   *  is exactly why they're a Settings row and not a hardcoded constant. */
  pricingUsdPerMTok: AiPricingTable;
  /**
   * AI INTELLIGENCE gap 3 (selective AI review in the candidate pipeline):
   * hard cap on AiCandidateRouterProvider calls per scan run, independent
   * of dailySpendCapUsd (a $ ceiling) and of ebayScanBudget.
   * maxEnrichmentCallsPerRun (a DIFFERENT, eBay-side API call) — this
   * budgets how many QUALIFIED_STATES candidates get an AI routing
   * opinion in a single run, same "never let one feature's calls crowd out
   * every other budget" reasoning as the eBay enrichment cap. Only ever
   * spent on candidates never AI-reviewed before (ai_review_status IS
   * NULL) — see scanRunner.ts's "SELECTIVE AI CANDIDATE REVIEW" step.
   */
  maxCandidateReviewCallsPerRun: number;
}

const DEFAULT_AI_PRICING_USD_PER_MTOK: AiPricingTable = {
  FAST: { input: 0.2, output: 1.2 },
  DEEP: { input: 2.0, output: 12.0 },
  AUDIT: { input: 4.0, output: 20.0 },
};

const DEFAULT_AI_SETTINGS: AiSettings = {
  // Deliberately conservative until the user has watched at least one real
  // billing cycle — easy to raise in Settings, hard to un-spend.
  dailySpendCapUsd: 5,
  pricingUsdPerMTok: DEFAULT_AI_PRICING_USD_PER_MTOK,
  // FAST tier is the cheapest, but a large scan can surface many newly-
  // qualified candidates at once — bounded here rather than left uncapped.
  maxCandidateReviewCallsPerRun: 25,
};

/**
 * Market-provider (PokeTrace) call budget — added 2026-09-08 alongside the
 * profiling-loop fix (see marketProfilesRepo.ts's markCardCheckedWithoutData).
 * That fix stops the SAME empty cards being re-requested forever; this
 * setting stops a bad day (provider outage, a misconfigured TTL, a future
 * regression) from burning the whole plan quota regardless. Checked ONCE at
 * the start of each run's profiling step against `api_usage` (real
 * non-cache-hit calls since UTC midnight), and the run's card budget is
 * shrunk to whatever's left — so the cap is enforced conservatively (every
 * card counted as if it WILL cost a call) without a D1 query per card.
 *
 * `maxProviderCallsPerDay`'s default is deliberately UNDER the ~8,000/day
 * the stuck loop was observed making when it exhausted the allowance — the
 * real plan quota isn't recorded anywhere in this repo, so the user should
 * set this from their PokeTrace plan page (Settings, key
 * `market_provider_budget`) rather than trust the default. Raising it
 * shortens the ~62k-card backlog's drain time; lowering it protects quota.
 */
export interface MarketProviderBudgetSettings {
  maxProviderCallsPerDay: number;
  /** Per-run cap on cards (re)profiled — previously the hardcoded
   *  MAX_CARDS_PROFILED_PER_RUN in scanRunner.ts (200), now tunable. */
  maxCardsProfiledPerRun: number;
  /**
   * Refresh interval for a card whose profile came back INELIGIBLE (or that
   * the provider had no data for). Fixed 2026-09-08 — this is what makes the
   * whole thing arithmetically possible.
   *
   * `selectCardsNeedingProfileRefresh` treats a card as due once its profile
   * is older than the standard refresh window (DEFAULT_MARKET_REFRESH_HOURS,
   * 12h). Applied to EVERY card that meant, at a real catalogue size of
   * ~76,000, needing ~152,000 provider calls a day to stand still — against a
   * ceiling of maxCardsProfiledPerRun x 48 runs = 9,600. The backlog was not
   * merely large, it was undrainable by construction, and the dashboard
   * correctly reported it never moving.
   *
   * The resolution is that those two groups don't deserve the same cadence.
   * Roughly a thousand cards are in the eligible flip/grade universe and
   * actually drive live opportunities — those genuinely need the 12h window.
   * The other ~75,000 have been priced and found uninteresting; a card that
   * isn't close to the bar does not become eligible in twelve hours, so
   * re-asking twice a day buys nothing and costs the entire quota. Two weeks
   * is long enough to collapse the daily requirement to something that fits
   * inside a real plan, and short enough that a genuine market move is picked
   * up in a fortnight rather than never.
   */
  ineligibleRefreshHours: number;
}

const DEFAULT_MARKET_PROVIDER_BUDGET: MarketProviderBudgetSettings = {
  // PokeTrace Pro plan = 10,000 calls/day (confirmed from the user's own API
  // usage page, 2026-09-08), so this leaves ~1,000 of headroom for catalogue
  // sync and for any drift between this counter's UTC-midnight day boundary
  // and PokeTrace's own reset. Raise it only alongside the plan.
  maxProviderCallsPerDay: 9000,
  maxCardsProfiledPerRun: 200,
  ineligibleRefreshHours: 24 * 14,
};

const DEFAULT_CATALOGUE_SYNC_SETTINGS: CatalogueSyncSettings = { pageSize: 20, maxPagesPerRun: 25 };
/**
 * Raised 2026-09-09 against eBay's PUBLISHED default limits, not a guess:
 * the Buy Browse API allows **5,000 calls/day** for "all methods except
 * getItems", and a SEPARATE 5,000/day for `getItems`. Those are two
 * independent buckets, which is why the two budgets below can be set
 * independently.
 *
 * The scan runs every 30 minutes = 48 runs/day, and spends at most one
 * search call per card searched (fewer when printings share a keyword — see
 * groupCardsBySearchKeyword). So daily search calls = maxCardsSearchedPerRun
 * x 48:
 *   - old 25/run = 1,200/day (24% of the limit)
 *   - new 60/run = 2,880/day (58%), leaving real headroom for manual
 *     "Scan now" clicks on top of the cron.
 *
 * Why it needed raising: once the market-profiling loop was fixed
 * (2026-09-08) the eligible flip/grade universe grew from ~717 to ~4,484
 * cards in a day, of which 2,453 had NEVER been searched on eBay. A card
 * that is never searched cannot produce an opportunity however good its
 * economics are, and the universe was growing faster than 1,200/day could
 * cover it — so coverage was falling further behind every day.
 *
 * Enrichment (the stage-two `getItem` condition check) moves 15 -> 40/run =
 * 1,920/day against its own separate 5,000 (38%). This one matters
 * disproportionately for the grading side specifically: it is the only call
 * that returns eBay's condition descriptors, and condition is the binding
 * constraint on every grading decision.
 *
 * DO NOT raise these much further without also watching run wall-time: each
 * search is a sequential outbound call, and every listing it returns costs
 * D1 writes that count against the Worker's per-invocation subrequest cap
 * (wrangler.toml `[limits]`, raised alongside this change for that reason).
 */
const DEFAULT_EBAY_SCAN_BUDGET: EbayScanBudgetSettings = {
  maxCardsSearchedPerRun: 60,
  maxListingsPerCardSearch: 20,
  maxEnrichmentCallsPerRun: 40,
};

/**
 * Every commercial assumption the engine uses, resolved from the `settings`
 * table. Nothing in the calculation path may hardcode a fee, a grading
 * price, a turnaround, a batch size or a profit threshold — if it isn't
 * here, it isn't tunable, and that's a bug.
 */
export interface ResolvedSettings {
  /** eBay UK business seller fee model (V1 exit market). */
  feeModel: ExitMarketFeeModel;
  sellingCosts: SellingCostSettings;
  qsvSettings: QsvSettings;
  graders: Grader[];
  gradingServices: GradingService[];
  gradingBatch: GradingBatchSettings;
  gradingConsumables: GradingConsumables;
  upchargeSettings: UpchargeSettings;
  classificationSettings: ClassificationSettings;
  qualification: QualificationRuleSet;
  flipScoreWeights: FlipScoreWeights;
  gradeScoreWeights: GradeScoreWeights;
  fxRates: FxRates;
  /** Provenance for fxRates — when it was last refreshed and whether the
   *  last attempt actually reached the FX provider. Null before the first
   *  refresh has ever run. See scan/fxRefresh.ts. */
  fxRatesMeta: FxRatesMeta | null;
  /**
   * What currency conversion actually costs the operator, above mid-market,
   * as a fraction (0.03 = 3%). See FxSnapshot.conversionSpreadPct.
   *
   * null means NOT CONFIGURED and is deliberately different from 0. Zero
   * asserts "I convert at mid-market"; null admits the cost is unaccounted
   * for, and any deal converting foreign money says so on its face.
   */
  fxConversionSpreadPct: number | null;
  marketProfileSettings: MarketProfileSettings;
  catalogueSync: CatalogueSyncSettings;
  ebayScanBudget: EbayScanBudgetSettings;
  marketProviderBudget: MarketProviderBudgetSettings;
  externalRefMarketPreference: string[];
  ai: AiSettings;
}

export async function loadSettings(db: Db): Promise<ResolvedSettings> {
  const rows = await db.queryAll<SettingsRow>(`SELECT * FROM settings`);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  const graders = parseList<Grader>(byKey.get("graders")) ?? DEFAULT_GRADERS;
  const gradingServices = parseList<GradingService>(byKey.get("grading_services")) ?? DEFAULT_GRADING_SERVICES;

  const flipQualification: FlipQualificationRules = {
    ...DEFAULT_FLIP_QUALIFICATION,
    ...parse(byKey.get("flip_qualification")),
  };

  // `null` in stored JSON means "rule not applied" — normalise the two
  // fields where that has to become +/-Infinity for the comparison to be a
  // no-op, rather than accidentally becoming a hard zero threshold.
  const storedGradeQualification = parse(byKey.get("grade_qualification"));
  const gradeQualification: GradeQualificationRules = {
    ...DEFAULT_GRADE_QUALIFICATION,
    ...storedGradeQualification,
    minPsa9Profit:
      storedGradeQualification.minPsa9Profit === null || storedGradeQualification.minPsa9Profit === undefined
        ? -Infinity
        : Number(storedGradeQualification.minPsa9Profit),
    maxBreakEvenGrade:
      storedGradeQualification.maxBreakEvenGrade === undefined
        ? DEFAULT_GRADE_QUALIFICATION.maxBreakEvenGrade
        : (storedGradeQualification.maxBreakEvenGrade as GradeQualificationRules["maxBreakEvenGrade"]),
  };

  return {
    feeModel: { ...DEFAULT_EXIT_MARKET_FEE_MODEL, ...parse(byKey.get("exit_market_fees")) },
    sellingCosts: { ...DEFAULT_SELLING_COSTS, ...parse(byKey.get("selling_costs")) },
    qsvSettings: { ...DEFAULT_QSV_SETTINGS, ...parse(byKey.get("qsv_settings")) },
    graders,
    // Only services belonging to an ENABLED grader are ever offered to the
    // engine — a disabled grader can't sneak back in via a service row.
    gradingServices: gradingServices.map((service) => ({
      ...service,
      enabled: service.enabled && (graders.find((g) => g.id === service.graderId)?.enabled ?? false),
    })),
    gradingBatch: { ...DEFAULT_GRADING_BATCH, ...parse(byKey.get("grading_batch")) },
    gradingConsumables: { ...DEFAULT_GRADING_CONSUMABLES, ...parse(byKey.get("grading_consumables")) },
    upchargeSettings: { ...DEFAULT_UPCHARGE_SETTINGS, ...parse(byKey.get("upcharge_settings")) },
    classificationSettings: { ...DEFAULT_CLASSIFICATION_SETTINGS, ...parse(byKey.get("grade_classification")) },
    qualification: {
      strategy: "BOTH",
      flip: flipQualification,
      grade: gradeQualification,
    },
    flipScoreWeights: { ...DEFAULT_FLIP_SCORE_WEIGHTS, ...parse(byKey.get("flip_score_weights")) },
    gradeScoreWeights: { ...DEFAULT_GRADE_SCORE_WEIGHTS, ...parse(byKey.get("grade_score_weights")) },
    fxRates: { ...DEFAULT_FX_RATES, ...(parse(byKey.get("fx_rates")) as Record<string, number>) } as FxRates,
    fxRatesMeta: byKey.get("fx_rates_meta") ? (parse(byKey.get("fx_rates_meta")) as unknown as FxRatesMeta) : null,
    fxConversionSpreadPct: (() => {
      const stored = parse(byKey.get("fx_conversion_spread")) as { spreadPct?: unknown };
      const value = stored?.spreadPct;
      // Absent, malformed or negative all mean "not configured" rather than
      // zero — a bad stored value must never silently become a claim that
      // conversion is free.
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
      return value;
    })(),
    marketProfileSettings: { ...DEFAULT_MARKET_PROFILE_SETTINGS, ...parse(byKey.get("market_profile_settings")) },
    catalogueSync: { ...DEFAULT_CATALOGUE_SYNC_SETTINGS, ...parse(byKey.get("catalogue_sync")) },
    ebayScanBudget: { ...DEFAULT_EBAY_SCAN_BUDGET, ...parse(byKey.get("ebay_scan_budget")) },
    marketProviderBudget: { ...DEFAULT_MARKET_PROVIDER_BUDGET, ...parse(byKey.get("market_provider_budget")) },
    externalRefMarketPreference:
      parseArray(byKey.get("external_ref_market_preference")) ?? [...DEFAULT_EXTERNAL_REF_MARKET_PREFERENCE],
    ai: (() => {
      const stored = parse(byKey.get("ai_settings"));
      return {
        dailySpendCapUsd:
          stored.dailySpendCapUsd === undefined ? DEFAULT_AI_SETTINGS.dailySpendCapUsd : stored.dailySpendCapUsd,
        // Merged per-tier so overriding e.g. just FAST doesn't lose the
        // DEEP/AUDIT defaults — same reasoning as ebayScanBudget's own
        // "an older stored blob without a new key still merges cleanly".
        pricingUsdPerMTok: { ...DEFAULT_AI_SETTINGS.pricingUsdPerMTok, ...(stored.pricingUsdPerMTok ?? {}) },
        maxCandidateReviewCallsPerRun:
          stored.maxCandidateReviewCallsPerRun === undefined
            ? DEFAULT_AI_SETTINGS.maxCandidateReviewCallsPerRun
            : stored.maxCandidateReviewCallsPerRun,
      };
    })(),
  };
}

/**
 * AI INTELLIGENCE gap 4 (financial engineering): the settings table is the
 * ONE path that actually drives loadSettings()/the engine, so THIS is the
 * write path that must be versioned/historized for "approved changes update
 * runtime economics ... while preserving historical snapshots" to be true
 * end-to-end (see migration 0022_settings_versioning.sql's doc comment for
 * why this table, not the pre-existing but disconnected financial_
 * assumptions ledger, was made authoritative).
 *
 * Archive-then-update, mirroring upsertFinancialAssumption's exact idiom:
 * read the existing row first, archive ITS current value+version into
 * settings_history (only if a row already existed — a key's first-ever
 * write has nothing to archive), then upsert the live row with version =
 * (existing?.version ?? 0) + 1. Two sequential db.exec() calls, not a
 * db.batch() — same risk tolerance already accepted by
 * upsertFinancialAssumption for this exact archive-then-update shape.
 *
 * "Approved" here means "reached this function" — there is no separate
 * draft/approval workflow in this codebase (the PUT /:key route this
 * backs takes effect immediately, same as before this gap). If the
 * intended meaning of "approved changes" was a formal review step ahead of
 * this write, that is a bigger, separate feature this change does not add.
 */
export async function updateSetting(db: Db, key: string, value: unknown, changedBy?: string | null): Promise<void> {
  const existing = await db.queryFirst<SettingsRow>(`SELECT * FROM settings WHERE key = ?`, key);

  if (existing) {
    await db.exec(
      `INSERT INTO settings_history (key, value, version, changed_at, changed_by)
       VALUES (?, ?, ?, datetime('now'), ?)`,
      existing.key,
      existing.value,
      existing.version,
      changedBy ?? null,
    );
  }

  const nextVersion = (existing?.version ?? 0) + 1;

  await db.exec(
    `INSERT INTO settings (key, value, version, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = excluded.version, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    nextVersion,
  );
}

/**
 * Read-only history for one settings key, most recent supersession first —
 * every value+version that key held before being overwritten. Does not
 * include the CURRENT live value (that's `settings` itself, via
 * loadSettings() or a direct SELECT) — this is purely the archive.
 */
export async function listSettingHistory(db: Db, key: string): Promise<SettingsHistoryRow[]> {
  return db.queryAll<SettingsHistoryRow>(
    `SELECT * FROM settings_history WHERE key = ? ORDER BY version DESC, id DESC`,
    key,
  );
}

/**
 * GBP -> USD, derived from the configured FX table. Used only to compare a
 * GBP slab value against a grading service's USD declared-value cap.
 * Returns null when the table has no USD rate, so the upcharge check
 * abstains rather than guessing.
 */
export function usdPerGbpFrom(fxRates: FxRates): number | null {
  const usdToGbp = (fxRates as unknown as Record<string, number>)["USD"];
  if (!usdToGbp || usdToGbp <= 0) return null;
  return 1 / usdToGbp;
}

function parse(json: string | undefined): Record<string, any> {
  if (!json) return {};
  try {
    const value = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function parseList<T>(json: string | undefined): T[] | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? (value as T[]) : null;
  } catch {
    return null;
  }
}

function parseArray(json: string | undefined): string[] | null {
  return parseList<string>(json);
}
