import { describe, it, expect } from "vitest";
import type { Db, SettingsRow } from "@mwmc/db";
import { listEligibleUniverseCards } from "../src/repo/marketProfilesRepo.js";
import { loadSettings } from "../src/repo/settingsRepo.js";

/**
 * PARKING THE FLIP BUSINESS — 2026-09-19, on the operator's instruction:
 * "park the flip business it dont work we only grade here."
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS ACTUALLY FIXING, measured on the live database the day it
 * was written.
 *
 * The eBay search budget is the scarcest resource in the system. The
 * scanner runs 48 times a day and searches 60 cards per run — 2,880
 * searches against 5,000 allowed. The universe it drew from was every
 * FLIP-eligible card (4,917) merged with every GRADE-eligible card (1,830),
 * so roughly three searches in four went to a strategy nobody was trading.
 *
 * The visible symptom was a four-day rotation: 474 grade cards searched in
 * 24 hours, 814 of the 1,830 not looked at for over three days. The
 * operator reported it as "I'm not getting new cards in my feed" and he was
 * right — an underpriced card listed on Monday and sold on Tuesday was
 * simply never seen, because that card's turn came round on Thursday.
 *
 * Grade alone is 1,830 cards against 2,880 daily searches. It fits inside
 * one day with room over. So this is not a tuning change; it is the
 * difference between seeing eBay daily and seeing it twice a week.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE WHOLE SUITE PASSED WITHOUT THIS FILE. It did, and that meant
 * nothing: no existing test passed a scope to listEligibleUniverseCards or
 * read the strategy back out of settings, so every assertion in the repo
 * was blind to the change. These are the tests that would fail if it were
 * reverted.
 */

interface FakeRow {
  card_id: string;
  last_ebay_scanned_at: string | null;
  liquidity: string;
  confidence: number;
}

function flipRow(cardId: string): FakeRow & Record<string, unknown> {
  return {
    card_id: cardId,
    last_ebay_scanned_at: null,
    liquidity: "MEDIUM",
    confidence: 0.8,
    flip_market_score: 50,
    max_profitable_acquisition_price: 40,
    discovery_max_acquisition_price: 60,
  };
}

function gradeRow(cardId: string): FakeRow & Record<string, unknown> {
  return {
    card_id: cardId,
    last_ebay_scanned_at: null,
    liquidity: "MEDIUM",
    confidence: 0.8,
    grade_market_score: 70,
    reference_psa10_profit: 200,
    reference_psa9_profit: 90,
    reference_graded_basis: 120,
  };
}

/**
 * Records which tables were actually queried, because the point of the
 * change is that a parked strategy costs NO read at all — not that its rows
 * are fetched and then discarded. At 48 runs a day over several thousand
 * rows, "fetched then filtered" is a real cost on D1.
 */
function fakeDb(flip: unknown[], grade: unknown[]): { db: Db; queriedTables: string[] } {
  const queriedTables: string[] = [];
  const db = {
    queryAll: async (sql: string) => {
      if (sql.includes("flip_profiles")) {
        queriedTables.push("flip_profiles");
        return flip;
      }
      if (sql.includes("grade_profiles")) {
        queriedTables.push("grade_profiles");
        return grade;
      }
      // The auction-deadline lookup over ebay_listings.
      queriedTables.push("ebay_listings");
      return [];
    },
    queryFirst: async () => null,
    exec: async () => ({ success: true }),
  } as unknown as Db;
  return { db, queriedTables };
}

describe("the eBay search universe follows the strategy being traded", () => {
  it("GRADE searches for grade cards and does not read the flip table at all", async () => {
    const { db, queriedTables } = fakeDb([flipRow("flip-only")], [gradeRow("grade-card")]);

    const universe = await listEligibleUniverseCards(db, "GRADE");

    expect([...universe.keys()]).toEqual(["grade-card"]);
    expect(queriedTables).not.toContain("flip_profiles");
  });

  it("FLIP is the mirror image, so the scope is a real switch and not a one-way hack", async () => {
    const { db, queriedTables } = fakeDb([flipRow("flip-only")], [gradeRow("grade-card")]);

    const universe = await listEligibleUniverseCards(db, "FLIP");

    expect([...universe.keys()]).toEqual(["flip-only"]);
    expect(queriedTables).not.toContain("grade_profiles");
  });

  it("BOTH still merges them, so nothing changes for a caller that passes no scope", async () => {
    const { db } = fakeDb([flipRow("flip-only")], [gradeRow("grade-card")]);

    const explicit = await listEligibleUniverseCards(db, "BOTH");
    const defaulted = await listEligibleUniverseCards(fakeDb([flipRow("flip-only")], [gradeRow("grade-card")]).db);

    expect([...explicit.keys()].sort()).toEqual(["flip-only", "grade-card"]);
    expect([...defaulted.keys()].sort()).toEqual(["flip-only", "grade-card"]);
  });

  /**
   * The saving comes from cards that are ONLY flip candidates. A card
   * eligible for both is still searched under GRADE — it has to be, it is a
   * grading candidate — and parking flip must not lose it.
   */
  it("keeps a card that is eligible for both", async () => {
    const { db } = fakeDb([flipRow("both")], [gradeRow("both")]);

    const universe = await listEligibleUniverseCards(db, "GRADE");

    expect([...universe.keys()]).toEqual(["both"]);
    expect(universe.get("both")!.score).toBe(70); // the grade signal, not the flip one
  });
});

/**
 * The setting is the other half. Scoping the universe achieves nothing if
 * production still reports BOTH.
 */
function settingsDb(rows: SettingsRow[]): Db {
  return {
    queryAll: async (sql: string) => (sql.includes("FROM settings") ? rows : []),
    queryFirst: async () => null,
    exec: async () => ({ success: true }),
  } as unknown as Db;
}

function row(key: string, value: string): SettingsRow {
  return { key, value, description: null, version: 1, updated_at: "2026-09-19T00:00:00Z" };
}

describe("the traded strategy as production reads it", () => {
  it("is GRADE when nothing is stored", async () => {
    const settings = await loadSettings(settingsDb([]));

    expect(settings.qualification.strategy).toBe("GRADE");
  });

  it("can be changed back from the D1 console without a deploy", async () => {
    const bare = await loadSettings(settingsDb([row("qualification_strategy", "BOTH")]));
    const quoted = await loadSettings(settingsDb([row("qualification_strategy", '"BOTH"')]));
    const wrapped = await loadSettings(settingsDb([row("qualification_strategy", '{"strategy":"BOTH"}')]));

    expect(bare.qualification.strategy).toBe("BOTH");
    expect(quoted.qualification.strategy).toBe("BOTH");
    expect(wrapped.qualification.strategy).toBe("BOTH");
  });

  it("is case-insensitive, because this will be typed by hand", async () => {
    const settings = await loadSettings(settingsDb([row("qualification_strategy", "flip")]));

    expect(settings.qualification.strategy).toBe("FLIP");
  });

  /**
   * A typo must not silently restore flip spending. Falling back to GRADE
   * rather than BOTH means the worst case of an unreadable setting is that
   * the operator's stated strategy keeps running.
   */
  it("falls back to GRADE on anything unrecognised, never to BOTH", async () => {
    for (const bad of ["GRAD", "", "null", "{}", '{"strategy":42}', "[1,2,3]"]) {
      const settings = await loadSettings(settingsDb([row("qualification_strategy", bad)]));
      expect(settings.qualification.strategy).toBe("GRADE");
    }
  });
});
