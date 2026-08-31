import { Db, type SettingsRow } from "@mwmc/db";
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
import { DEFAULT_EXTERNAL_REF_MARKET_PREFERENCE } from "./externalCardRefsRepo.js";

export interface CatalogueSyncSettings {
  pageSize: number;
  maxPagesPerRun: number;
}

export interface EbayScanBudgetSettings {
  maxCardsSearchedPerRun: number;
  maxListingsPerCardSearch: number;
}

const DEFAULT_CATALOGUE_SYNC_SETTINGS: CatalogueSyncSettings = { pageSize: 20, maxPagesPerRun: 25 };
const DEFAULT_EBAY_SCAN_BUDGET: EbayScanBudgetSettings = { maxCardsSearchedPerRun: 25, maxListingsPerCardSearch: 20 };

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
  };
}

export async function updateSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.exec(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
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
