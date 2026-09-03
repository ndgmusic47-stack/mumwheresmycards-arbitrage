import { describe, it, expect } from "vitest";
import { Db, type SettingsRow, type SettingsHistoryRow } from "@mwmc/db";
import { updateSetting, listSettingHistory } from "../src/repo/settingsRepo.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE gap 4 (financial engineering) — "one
 * authoritative versioned financial settings path actually drives the
 * engine ... approved changes must update runtime economics ... while
 * preserving historical snapshots." settingsRepo.ts is that path
 * (loadSettings() reads it, the engine computes against it) — this file
 * pins that updateSetting() always archives the pre-update value+version
 * before overwriting, exactly like financialAssumptionsRepo.test.ts pins
 * the analogous contract for the (separate, descriptive-only) ledger.
 */
function settingsRow(overrides: Partial<SettingsRow> = {}): SettingsRow {
  return {
    key: "selling_costs",
    value: '{"outboundPostage":3.5}',
    description: null,
    version: 1,
    updated_at: "2026-09-02T00:00:00Z",
    ...overrides,
  };
}

function fakeDb(initialRows: SettingsRow[]): {
  db: Db;
  historyInserts: unknown[][];
  table: Map<string, SettingsRow>;
  history: SettingsHistoryRow[];
} {
  const table = new Map(initialRows.map((r) => [r.key, r]));
  const historyInserts: unknown[][] = [];
  const history: SettingsHistoryRow[] = [];
  let historyId = 1;

  const db = {
    exec: async (sql: string, ...params: unknown[]) => {
      if (sql.includes("INSERT INTO settings_history")) {
        historyInserts.push(params);
        const [key, value, version, , changed_by] = params as [string, string, number, string, string | null];
        history.push({ id: historyId++, key, value, version, changed_at: "2026-09-02T00:00:00Z", changed_by });
      } else if (sql.includes("INSERT INTO settings")) {
        const [key, value, version] = params as [string, string, number];
        table.set(key, { key, value, description: null, version, updated_at: "2026-09-02T00:00:00Z" });
      }
      return { success: true };
    },
    queryFirst: async (sql: string, ...params: unknown[]) => {
      if (sql.includes("FROM settings WHERE key")) {
        return table.get(params[0] as string) ?? null;
      }
      return null;
    },
    queryAll: async (sql: string, ...params: unknown[]) => {
      if (sql.includes("FROM settings_history WHERE key")) {
        return history
          .filter((h) => h.key === params[0])
          .sort((a, b) => b.version - a.version || b.id - a.id);
      }
      return [];
    },
  } as unknown as Db;

  return { db, historyInserts, table, history };
}

describe("settingsRepo.updateSetting — archives the pre-update state before overwriting", () => {
  it("archives the OLD value/version into settings_history, then bumps version on the live row", async () => {
    const { db, historyInserts, table } = fakeDb([settingsRow({ version: 1, value: '{"outboundPostage":3.5}' })]);

    await updateSetting(db, "selling_costs", { outboundPostage: 4.25 });

    expect(historyInserts).toHaveLength(1);
    const [archivedKey, archivedValue, archivedVersion] = historyInserts[0]!;
    expect(archivedKey).toBe("selling_costs");
    expect(archivedValue).toBe('{"outboundPostage":3.5}');
    expect(archivedVersion).toBe(1);

    const live = table.get("selling_costs")!;
    expect(live.version).toBe(2);
    expect(live.value).toBe('{"outboundPostage":4.25}');
  });

  it("does not archive anything for a brand-new key (nothing pre-existed to lose)", async () => {
    const { db, historyInserts, table } = fakeDb([]);

    await updateSetting(db, "new_key", { foo: "bar" });

    expect(historyInserts).toHaveLength(0);
    expect(table.get("new_key")!.version).toBe(1);
  });

  it("archives every prior version across repeated updates", async () => {
    const { db, historyInserts } = fakeDb([settingsRow({ version: 1, value: "1" })]);

    await updateSetting(db, "selling_costs", 2);
    await updateSetting(db, "selling_costs", 3);

    expect(historyInserts).toHaveLength(2);
    expect(historyInserts[0]![2]).toBe(1); // version 1 archived first
    expect(historyInserts[1]![2]).toBe(2); // then version 2
  });
});

describe("settingsRepo.listSettingHistory", () => {
  it("returns the archived rows for a key, most recent first, and never the live value", async () => {
    const { db } = fakeDb([settingsRow({ version: 1, value: "1" })]);

    await updateSetting(db, "selling_costs", 2);
    await updateSetting(db, "selling_costs", 3);

    const history = await listSettingHistory(db, "selling_costs");
    expect(history).toHaveLength(2);
    expect(history[0]!.version).toBe(2); // most recently superseded first
    expect(history[0]!.value).toBe("2");
    expect(history[1]!.version).toBe(1);
    expect(history[1]!.value).toBe("1");
  });

  it("returns an empty array for a key with no history", async () => {
    const { db } = fakeDb([]);
    expect(await listSettingHistory(db, "never_written")).toEqual([]);
  });
});
