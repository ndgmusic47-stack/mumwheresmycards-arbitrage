import { describe, it, expect } from "vitest";
import { Db, type FinancialAssumptionRow } from "@mwmc/db";
import {
  getFinancialAssumption,
  listFinancialAssumptions,
  summariseByClassification,
  upsertFinancialAssumption,
  type FinancialAssumptionView,
} from "../src/repo/financialAssumptionsRepo.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec item 11 (financial-assumptions
 * ledger). Pins the two contracts that matter most: reading back a
 * classified assumption correctly, and that an update ALWAYS archives the
 * pre-update state (see the repo file's doc comment for why this is
 * non-negotiable — it's the entire point of a versioned ledger).
 */
function row(overrides: Partial<FinancialAssumptionRow> = {}): FinancialAssumptionRow {
  return {
    id: "fee.finalValueFeePct",
    category: "EBAY_FEES",
    label: "eBay UK final value fee",
    value_json: "0.109",
    classification: "VERIFIED",
    source_note: "eBay published schedule",
    version: 1,
    updated_at: "2026-09-02T00:00:00Z",
    updated_by: "migration_0017_seed",
    ...overrides,
  };
}

function fakeDb(initialRows: FinancialAssumptionRow[]): {
  db: Db;
  historyInserts: unknown[][];
  table: Map<string, FinancialAssumptionRow>;
} {
  const table = new Map(initialRows.map((r) => [r.id, r]));
  const historyInserts: unknown[][] = [];

  const db = {
    exec: async (sql: string, ...params: unknown[]) => {
      if (sql.includes("INSERT INTO financial_assumptions_history")) {
        historyInserts.push(params);
      } else if (sql.includes("INSERT INTO financial_assumptions")) {
        const [id, category, label, value_json, classification, source_note, version, , updated_by] = params as [
          string,
          string,
          string,
          string,
          FinancialAssumptionRow["classification"],
          string | null,
          number,
          string,
          string | null,
        ];
        table.set(id, {
          id,
          category,
          label,
          value_json,
          classification,
          source_note,
          version,
          updated_at: "2026-09-02T00:00:00Z",
          updated_by,
        });
      }
      return { success: true };
    },
    queryFirst: async (sql: string, ...params: unknown[]) => {
      if (sql.includes("FROM financial_assumptions WHERE id")) {
        return table.get(params[0] as string) ?? null;
      }
      return null;
    },
    queryAll: async (sql: string) => {
      if (sql.includes("FROM financial_assumptions ORDER BY")) {
        return [...table.values()].sort((a, b) => a.id.localeCompare(b.id));
      }
      return [];
    },
  } as unknown as Db;

  return { db, historyInserts, table };
}

describe("financialAssumptionsRepo — reading", () => {
  it("parses value_json back into a real value, not a string", async () => {
    const { db } = fakeDb([row()]);
    const assumption = await getFinancialAssumption(db, "fee.finalValueFeePct");
    expect(assumption!.value).toBe(0.109);
    expect(typeof assumption!.value).toBe("number");
  });

  it("parses a structured (object) value correctly", async () => {
    const { db } = fakeDb([
      row({ id: "daysToSale.raw", value_json: '{"LOW":60,"MEDIUM":30,"HIGH":14,"VERY_HIGH":7}' }),
    ]);
    const assumption = await getFinancialAssumption(db, "daysToSale.raw");
    expect(assumption!.value).toEqual({ LOW: 60, MEDIUM: 30, HIGH: 14, VERY_HIGH: 7 });
  });

  it("returns null for an unknown id rather than throwing", async () => {
    const { db } = fakeDb([]);
    expect(await getFinancialAssumption(db, "does.not.exist")).toBeNull();
  });

  it("summarises assumptions by classification", async () => {
    const { db } = fakeDb([
      row({ id: "a", classification: "VERIFIED" }),
      row({ id: "b", classification: "USER_SUPPLIED" }),
      row({ id: "c", classification: "USER_SUPPLIED" }),
      row({ id: "d", classification: "DERIVED" }),
      row({ id: "e", classification: "UNKNOWN" }),
    ]);
    const assumptions = await listFinancialAssumptions(db);
    const summary = summariseByClassification(assumptions);

    expect(summary).toEqual({ VERIFIED: 1, USER_SUPPLIED: 2, DERIVED: 1, UNKNOWN: 1 });
  });
});

describe("financialAssumptionsRepo — writing always archives the pre-update state", () => {
  it("archives the OLD value/classification into history before overwriting, and bumps version", async () => {
    const { db, historyInserts, table } = fakeDb([row({ version: 1, classification: "DERIVED", value_json: "0.05" })]);

    const updated = await upsertFinancialAssumption(db, {
      id: "fee.finalValueFeePct",
      category: "EBAY_FEES",
      label: "eBay UK final value fee",
      value: 0.109,
      classification: "VERIFIED",
      sourceNote: "Re-verified against live eBay schedule",
      updatedBy: "operator",
    });

    expect(updated.version).toBe(2);
    expect(updated.classification).toBe("VERIFIED");
    expect(updated.value).toBe(0.109);

    // The PRE-update row (version 1, DERIVED, 0.05) was archived, not lost.
    expect(historyInserts).toHaveLength(1);
    const [assumptionId, archivedVersion, archivedValueJson, archivedClassification] = historyInserts[0]!;
    expect(assumptionId).toBe("fee.finalValueFeePct");
    expect(archivedVersion).toBe(1);
    expect(archivedValueJson).toBe("0.05");
    expect(archivedClassification).toBe("DERIVED");

    expect(table.get("fee.finalValueFeePct")!.version).toBe(2);
  });

  it("does not archive anything for a brand-new assumption (nothing pre-existed to lose)", async () => {
    const { db, historyInserts } = fakeDb([]);
    const created = await upsertFinancialAssumption(db, {
      id: "new.assumption",
      category: "TEST",
      label: "A brand new assumption",
      value: 42,
      classification: "UNKNOWN",
    });

    expect(created.version).toBe(1);
    expect(historyInserts).toHaveLength(0);
  });

  it("archives every prior version across repeated updates, oldest first is reconstructable", async () => {
    const { db, historyInserts } = fakeDb([row({ version: 1, value_json: "1" })]);

    await upsertFinancialAssumption(db, {
      id: "fee.finalValueFeePct",
      category: "EBAY_FEES",
      label: "x",
      value: 2,
      classification: "VERIFIED",
    });
    await upsertFinancialAssumption(db, {
      id: "fee.finalValueFeePct",
      category: "EBAY_FEES",
      label: "x",
      value: 3,
      classification: "VERIFIED",
    });

    expect(historyInserts).toHaveLength(2);
    expect(historyInserts[0]![1]).toBe(1); // version 1 archived first
    expect(historyInserts[1]![1]).toBe(2); // then version 2
  });
});

describe("financialAssumptionsRepo — view shape", () => {
  it("never leaks the raw D1 row shape (snake_case) through the view", async () => {
    const { db } = fakeDb([row()]);
    const assumption = (await getFinancialAssumption(db, "fee.finalValueFeePct")) as FinancialAssumptionView;
    expect(assumption).not.toHaveProperty("value_json");
    expect(assumption).not.toHaveProperty("source_note");
    expect(assumption.sourceNote).toBe("eBay published schedule");
  });
});
