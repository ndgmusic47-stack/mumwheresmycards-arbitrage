import { Db, type SettingsRow } from "@mwmc/db";
import {
  DEFAULT_FEE_SCHEDULE,
  DEFAULT_FLIP_SCORE_WEIGHTS,
  DEFAULT_GRADE_SCORE_WEIGHTS,
  DEFAULT_FX_RATES,
  DEFAULT_MARKET_PROFILE_SETTINGS,
  type FeeSchedule,
  type FxRates,
  type MarketProfileSettings,
} from "@mwmc/core";
import type { FilterSet } from "@mwmc/core";
import type { FlipScoreWeights, GradeScoreWeights } from "@mwmc/core";
import { DEFAULT_EXTERNAL_REF_MARKET_PREFERENCE } from "./externalCardRefsRepo.js";

const DEFAULT_FILTERS: FilterSet = {
  global: {
    strategy: "BOTH",
    minNetProfit: 50,
    minReturnOnCapital: 0.35,
    minProfitMargin: 0.15,
    maxAcquisitionPrice: 500,
    minLiquidity: "MEDIUM",
    minConfidence: 0.6,
  },
  flip: { minQsv: 20, maxDaysToSale: 30 },
  grade: {
    minPsa10Value: 80,
    minPsa10UpsideMultiple: 2.0,
    minAcceptableBreakEvenGrade: 8,
    safeZoneOnly: false,
    maxGradedBasis: 300,
  },
};

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

export interface ResolvedSettings {
  filters: FilterSet;
  flipScoreWeights: FlipScoreWeights;
  gradeScoreWeights: GradeScoreWeights;
  feeSchedule: FeeSchedule;
  fxRates: FxRates;
  marketProfileSettings: MarketProfileSettings;
  catalogueSync: CatalogueSyncSettings;
  ebayScanBudget: EbayScanBudgetSettings;
  /** Preference order (most-preferred first) for which market's provider
   *  ref to use when a card has more than one from the same provider — see
   *  externalCardRefsRepo.ts findExternalRefForCard. The default is a
   *  documented PLACEHOLDER, not a confirmed business rule — editable in
   *  Settings once the live-ingestion diagnostic shows real market
   *  coverage/overlap. */
  externalRefMarketPreference: string[];
}

/**
 * Loads all engine-tunable settings from the `settings` table (seeded by
 * migrations 0005 and 0009), falling back to packages/core defaults for
 * any missing or malformed key so a fresh/partially-configured DB never
 * breaks a scan.
 */
export async function loadSettings(db: Db): Promise<ResolvedSettings> {
  const rows = await db.queryAll<SettingsRow>(`SELECT * FROM settings`);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));

  return {
    filters: {
      global: { ...DEFAULT_FILTERS.global, ...parse(byKey.get("global_filters")) },
      flip: { ...DEFAULT_FILTERS.flip, ...parse(byKey.get("flip_filters")) },
      grade: { ...DEFAULT_FILTERS.grade, ...parse(byKey.get("grade_filters")) },
    },
    flipScoreWeights: { ...DEFAULT_FLIP_SCORE_WEIGHTS, ...parse(byKey.get("flip_score_weights")) },
    gradeScoreWeights: { ...DEFAULT_GRADE_SCORE_WEIGHTS, ...parse(byKey.get("grade_score_weights")) },
    feeSchedule: { ...DEFAULT_FEE_SCHEDULE, ...parse(byKey.get("fee_schedule")) },
    fxRates: { ...DEFAULT_FX_RATES, ...(parse(byKey.get("fx_rates")) as Record<string, number>) } as FxRates,
    marketProfileSettings: { ...DEFAULT_MARKET_PROFILE_SETTINGS, ...parse(byKey.get("market_profile_settings")) },
    catalogueSync: { ...DEFAULT_CATALOGUE_SYNC_SETTINGS, ...parse(byKey.get("catalogue_sync")) },
    ebayScanBudget: { ...DEFAULT_EBAY_SCAN_BUDGET, ...parse(byKey.get("ebay_scan_budget")) },
    externalRefMarketPreference: parseArray(byKey.get("external_ref_market_preference")) ?? [...DEFAULT_EXTERNAL_REF_MARKET_PREFERENCE],
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

function parse(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function parseArray(json: string | undefined): string[] | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? (value as string[]) : null;
  } catch {
    return null;
  }
}
