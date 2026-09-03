import { Db, type FinancialAssumptionRow, type FinancialAssumptionHistoryRow } from "@mwmc/db";

/**
 * AI INTELLIGENCE spec item 11 (financial-assumptions ledger). See
 * migration 0017's doc comment for the full rationale and the
 * classification taxonomy (VERIFIED / USER_SUPPLIED / DERIVED / UNKNOWN).
 *
 * IMPORTANT — this ledger is DESCRIPTIVE, not a second source of truth:
 * the engine (packages/core) and `settings` still hold the real values it
 * actually calculates with. Writing here does NOT change engine behaviour.
 * Its job is auditability — one place that says what every financial
 * number is, how much to trust it, and when it last changed — not a
 * runtime config layer to replace `settings`.
 */

export type FinancialAssumptionClassification = "VERIFIED" | "USER_SUPPLIED" | "DERIVED" | "UNKNOWN";

export interface FinancialAssumptionView {
  id: string;
  category: string;
  label: string;
  value: unknown;
  classification: FinancialAssumptionClassification;
  sourceNote: string | null;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export async function listFinancialAssumptions(db: Db): Promise<FinancialAssumptionView[]> {
  const rows = await db.queryAll<FinancialAssumptionRow>(
    `SELECT * FROM financial_assumptions ORDER BY category ASC, id ASC`,
  );
  return rows.map(toView);
}

export async function getFinancialAssumption(db: Db, id: string): Promise<FinancialAssumptionView | null> {
  const row = await db.queryFirst<FinancialAssumptionRow>(`SELECT * FROM financial_assumptions WHERE id = ?`, id);
  return row ? toView(row) : null;
}

export async function getFinancialAssumptionHistory(db: Db, id: string): Promise<FinancialAssumptionHistoryRow[]> {
  return db.queryAll<FinancialAssumptionHistoryRow>(
    `SELECT * FROM financial_assumptions_history WHERE assumption_id = ? ORDER BY version DESC`,
    id,
  );
}

/** Every distinct classification value actually in use — for a dashboard
 *  summary/audit view ("N VERIFIED, M USER_SUPPLIED, ..."), computed here
 *  rather than in SQL so the counting logic has one place to be correct. */
export function summariseByClassification(
  assumptions: FinancialAssumptionView[],
): Record<FinancialAssumptionClassification, number> {
  const summary: Record<FinancialAssumptionClassification, number> = {
    VERIFIED: 0,
    USER_SUPPLIED: 0,
    DERIVED: 0,
    UNKNOWN: 0,
  };
  for (const a of assumptions) {
    summary[a.classification]++;
  }
  return summary;
}

/**
 * Updates a single assumption's value/classification/source note. ALWAYS
 * archives the pre-update row into financial_assumptions_history first
 * (even for what looks like a trivial edit) and bumps `version` — this is
 * what makes "when did this change, and from what" answerable later
 * without relying on anyone remembering to write it down.
 */
export async function upsertFinancialAssumption(
  db: Db,
  params: {
    id: string;
    category: string;
    label: string;
    value: unknown;
    classification: FinancialAssumptionClassification;
    sourceNote?: string | null;
    updatedBy?: string | null;
  },
): Promise<FinancialAssumptionView> {
  const existing = await db.queryFirst<FinancialAssumptionRow>(
    `SELECT * FROM financial_assumptions WHERE id = ?`,
    params.id,
  );

  if (existing) {
    await db.exec(
      `INSERT INTO financial_assumptions_history (assumption_id, version, value_json, classification, source_note, changed_at, changed_by)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)`,
      existing.id,
      existing.version,
      existing.value_json,
      existing.classification,
      existing.source_note,
      params.updatedBy ?? null,
    );
  }

  const nextVersion = (existing?.version ?? 0) + 1;
  const valueJson = JSON.stringify(params.value);

  await db.exec(
    `INSERT INTO financial_assumptions (id, category, label, value_json, classification, source_note, version, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(id) DO UPDATE SET
       category = excluded.category,
       label = excluded.label,
       value_json = excluded.value_json,
       classification = excluded.classification,
       source_note = excluded.source_note,
       version = excluded.version,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    params.id,
    params.category,
    params.label,
    valueJson,
    params.classification,
    params.sourceNote ?? null,
    nextVersion,
    params.updatedBy ?? null,
  );

  const row = await db.queryFirst<FinancialAssumptionRow>(`SELECT * FROM financial_assumptions WHERE id = ?`, params.id);
  return row ? toView(row) : toView({
    id: params.id,
    category: params.category,
    label: params.label,
    value_json: valueJson,
    classification: params.classification,
    source_note: params.sourceNote ?? null,
    version: nextVersion,
    updated_at: new Date().toISOString(),
    updated_by: params.updatedBy ?? null,
  });
}

function toView(row: FinancialAssumptionRow): FinancialAssumptionView {
  let value: unknown = null;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    value = row.value_json; // corrupt/legacy row — surface the raw string rather than throwing
  }
  return {
    id: row.id,
    category: row.category,
    label: row.label,
    value,
    classification: row.classification,
    sourceNote: row.source_note,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}
