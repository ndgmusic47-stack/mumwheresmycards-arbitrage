import { Db, type SettingsRow } from "@mwmc/db";
import {
  DEFAULT_FEE_SCHEDULE,
  DEFAULT_FLIP_SCORE_WEIGHTS,
  DEFAULT_GRADE_SCORE_WEIGHTS,
  type FeeSchedule,
} from "@mwmc/core";
import type { FilterSet } from "@mwmc/core";
import type { FlipScoreWeights, GradeScoreWeights } from "@mwmc/core";

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

export interface ResolvedSettings {
  filters: FilterSet;
  flipScoreWeights: FlipScoreWeights;
  gradeScoreWeights: GradeScoreWeights;
  feeSchedule: FeeSchedule;
}

/**
 * Loads all engine-tunable settings from the `settings` table (seeded by
 * migration 0005), falling back to packages/core defaults for any missing
 * or malformed key so a fresh/partially-configured DB never breaks a scan.
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
