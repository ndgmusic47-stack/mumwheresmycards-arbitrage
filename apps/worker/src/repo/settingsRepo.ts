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
import type { AiPricingTable } from "@mwmc/providers";
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

const DEFAULT_CATALOGUE_SYNC_SETTINGS: CatalogueSyncSettings = { pageSize: 20, maxPagesPerRun: 25 };
const DEFAULT_EBAY_SCAN_BUDGET: EbayScanBudgetSettings = {
  maxCardsSearchedPerRun: 25,
  maxListingsPerCardSearch: 20,
  maxEnrichmentCallsPerRun: 15,
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
  marketProfileSettings: MarketProfileSettings;
  catalogueSync: CatalogueSyncSettings;
  ebayScanBudget: EbayScanBudgetSettings;
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
    marketProfileSettings: { ...DEFAULT_MARKET_PROFILE_SETTINGS, ...parse(byKey.get("market_profile_settings")) },
    catalogueSync: { ...DEFAULT_CATALOGUE_SYNC_SETTINGS, ...parse(byKey.get("catalogue_sync")) },
    ebayScanBudget: { ...DEFAULT_EBAY_SCAN_BUDGET, ...parse(byKey.get("ebay_scan_budget")) },
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
