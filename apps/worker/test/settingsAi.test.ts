import { describe, it, expect } from "vitest";
import { Db, type D1Like, type D1PreparedStatementLike, type D1ResultLike, type SettingsRow } from "@mwmc/db";
import { loadSettings } from "../src/repo/settingsRepo.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream G — the
 * `ai` block loadSettings() resolves (dailySpendCapUsd, pricingUsdPerMTok).
 * settingsRepo.ts previously had zero direct test coverage (every other
 * field is only exercised indirectly through other routes' empty-D1
 * fallback path) — this file covers the new logic directly, including the
 * per-tier merge behaviour other settings fields don't need (they're flat).
 */
function fakeSettingsD1(rows: SettingsRow[]): D1Like {
  const stmt: D1PreparedStatementLike = {
    bind: () => stmt,
    first: async () => null,
    all: async () => ({ results: rows, success: true, meta: {} }) as D1ResultLike<unknown>,
    run: async () => ({ success: true, meta: {} }) as D1ResultLike<unknown>,
  };
  return { prepare: () => stmt, batch: async () => [] };
}

function settingsRow(key: string, value: unknown): SettingsRow {
  return { key, value: JSON.stringify(value) } as SettingsRow;
}

describe("loadSettings — ai block (Workstream G)", () => {
  it("defaults to a $5 daily cap and the GPT-5.6-tier pricing table when nothing is stored", async () => {
    const db = new Db(fakeSettingsD1([]));
    const settings = await loadSettings(db);

    expect(settings.ai.dailySpendCapUsd).toBe(5);
    expect(settings.ai.pricingUsdPerMTok.FAST).toEqual({ input: 0.2, output: 1.2 });
    expect(settings.ai.pricingUsdPerMTok.DEEP).toEqual({ input: 2.0, output: 12.0 });
    expect(settings.ai.pricingUsdPerMTok.AUDIT).toEqual({ input: 4.0, output: 20.0 });
  });

  it("honours an explicit stored dailySpendCapUsd override", async () => {
    const db = new Db(fakeSettingsD1([settingsRow("ai_settings", { dailySpendCapUsd: 25 })]));
    const settings = await loadSettings(db);

    expect(settings.ai.dailySpendCapUsd).toBe(25);
  });

  it("allows dailySpendCapUsd to be explicitly disabled (null)", async () => {
    const db = new Db(fakeSettingsD1([settingsRow("ai_settings", { dailySpendCapUsd: null })]));
    const settings = await loadSettings(db);

    expect(settings.ai.dailySpendCapUsd).toBeNull();
  });

  it("merges a partial pricingUsdPerMTok override per-tier, never dropping the untouched tiers' defaults", async () => {
    const db = new Db(
      fakeSettingsD1([settingsRow("ai_settings", { pricingUsdPerMTok: { FAST: { input: 0.5, output: 3 } } })]),
    );
    const settings = await loadSettings(db);

    expect(settings.ai.pricingUsdPerMTok.FAST).toEqual({ input: 0.5, output: 3 });
    // DEEP/AUDIT untouched — still the defaults, not lost by the override.
    expect(settings.ai.pricingUsdPerMTok.DEEP).toEqual({ input: 2.0, output: 12.0 });
    expect(settings.ai.pricingUsdPerMTok.AUDIT).toEqual({ input: 4.0, output: 20.0 });
  });

  // AI INTELLIGENCE gap 3 (selective AI review in the candidate pipeline).
  it("defaults maxCandidateReviewCallsPerRun to 25 when nothing is stored", async () => {
    const db = new Db(fakeSettingsD1([]));
    const settings = await loadSettings(db);

    expect(settings.ai.maxCandidateReviewCallsPerRun).toBe(25);
  });

  it("honours an explicit stored maxCandidateReviewCallsPerRun override, without losing the rest of the ai_settings blob", async () => {
    const db = new Db(
      fakeSettingsD1([settingsRow("ai_settings", { dailySpendCapUsd: 10, maxCandidateReviewCallsPerRun: 50 })]),
    );
    const settings = await loadSettings(db);

    expect(settings.ai.maxCandidateReviewCallsPerRun).toBe(50);
    expect(settings.ai.dailySpendCapUsd).toBe(10);
  });
});
