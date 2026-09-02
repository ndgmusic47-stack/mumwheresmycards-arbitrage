import { describe, it, expect } from "vitest";
import { Db, type FlipProfileRow, type GradeProfileRow, type CardRow } from "@mwmc/db";
import { listEligibleUniverseCards } from "../src/repo/marketProfilesRepo.js";

/**
 * REGRESSION GUARD for STABILISATION item 11 ("use max acquisition price to
 * avoid returning obviously overpriced inventory where safe").
 *
 * listEligibleUniverseCards() is the one place that turns flip_profiles /
 * grade_profiles rows into the PrioritizableCard shape scanRunner.ts feeds
 * into the eBay search step, so it's also the one place that can safely
 * derive a per-card acquisition-price ceiling: flip_profiles already stores
 * one directly (max_profitable_acquisition_price); grade_profiles doesn't,
 * so it's derived from raw_market_value + the best available reference
 * profit across grades 7-10 (see deriveGradeMaxAcquisitionPrice's own doc
 * comment in marketProfilesRepo.ts for why that's a safe, not heuristic,
 * ceiling). These tests pin down that derivation and the flip/grade merge
 * rule directly against a fake Db, without needing real D1.
 */
function flipRow(overrides: Partial<FlipProfileRow & Pick<CardRow, "last_ebay_scanned_at">> = {}) {
  return {
    card_id: "card-1",
    market_snapshot_id: 1,
    raw_market_value: 100,
    conservative_qsv: 90,
    qsv_basis: "sold_median",
    is_high_confidence_qsv: 1,
    raw_sample_size: 10,
    liquidity: "HIGH",
    confidence: 0.8,
    max_profitable_acquisition_price: 42,
    eligible: 1,
    flip_market_score: 70,
    ineligible_reason: null,
    computed_at: "2026-09-02T00:00:00Z",
    last_ebay_scanned_at: null,
    ...overrides,
  };
}

function gradeRow(overrides: Partial<GradeProfileRow & Pick<CardRow, "last_ebay_scanned_at">> = {}) {
  return {
    card_id: "card-1",
    market_snapshot_id: 1,
    raw_market_value: 100,
    psa7: 150,
    psa8: 250,
    psa9: 500,
    psa10: 1800,
    raw_sample_size: 10,
    reference_graded_basis: 140,
    reference_psa7_profit: -50,
    reference_psa8_profit: 20,
    reference_psa9_profit: 200,
    reference_psa10_profit: 900,
    break_even_grade: 8,
    psa10_upside_multiple: 4,
    psa10_gross_multiple: 4,
    economic_class: "BALANCED",
    economic_class_rationale: "because",
    required_psa10_rate_vs_psa9: 0.1,
    reference_service_id: "PSA_REGULAR",
    estimated_capital_lock_days: 100,
    liquidity: "HIGH",
    confidence: 0.8,
    eligible: 1,
    grade_market_score: 65,
    ineligible_reason: null,
    computed_at: "2026-09-02T00:00:00Z",
    last_ebay_scanned_at: null,
    ...overrides,
  };
}

function fakeDb(flipRows: unknown[], gradeRows: unknown[]): Db {
  let call = 0;
  return {
    exec: async () => ({ success: true }),
    queryFirst: async () => null,
    queryAll: async () => {
      call++;
      return call === 1 ? flipRows : gradeRows;
    },
  } as unknown as Db;
}

describe("listEligibleUniverseCards — maxAcquisitionPrice (STABILISATION item 11)", () => {
  it("a flip-only eligible card gets flip_profiles' own ceiling directly", async () => {
    const db = fakeDb([flipRow({ card_id: "flip-only", max_profitable_acquisition_price: 55.5 })], []);
    const universe = await listEligibleUniverseCards(db);
    expect(universe.get("flip-only")!.maxAcquisitionPrice).toBe(55.5);
  });

  it("a grade-only eligible card gets a ceiling derived from raw_market_value + the BEST grade's reference profit, not just PSA10", async () => {
    // PSA8's reference profit (300) beats PSA10's (50) here — an asymmetric
    // structure where a lower grade is actually the most profitable rung.
    // Using PSA10 alone would derive too LOW a ceiling and risk filtering
    // out a listing that's genuinely still profitable at PSA8.
    const db = fakeDb(
      [],
      [
        gradeRow({
          card_id: "grade-only",
          raw_market_value: 100,
          reference_psa7_profit: -20,
          reference_psa8_profit: 300,
          reference_psa9_profit: 150,
          reference_psa10_profit: 50,
        }),
      ],
    );
    const universe = await listEligibleUniverseCards(db);
    expect(universe.get("grade-only")!.maxAcquisitionPrice).toBe(400); // 100 + 300
  });

  it("a card eligible under BOTH strategies takes the HIGHER of the two ceilings, never the lower", async () => {
    const db = fakeDb(
      [flipRow({ card_id: "both", max_profitable_acquisition_price: 40 })],
      [gradeRow({ card_id: "both", raw_market_value: 100, reference_psa10_profit: 500 })], // ceiling 600
    );
    const universe = await listEligibleUniverseCards(db);
    expect(universe.get("both")!.maxAcquisitionPrice).toBe(600);

    // And the reverse: flip ceiling higher than grade ceiling.
    const db2 = fakeDb(
      [flipRow({ card_id: "both2", max_profitable_acquisition_price: 900 })],
      [gradeRow({ card_id: "both2", raw_market_value: 100, reference_psa10_profit: 10 })], // ceiling 110
    );
    const universe2 = await listEligibleUniverseCards(db2);
    expect(universe2.get("both2")!.maxAcquisitionPrice).toBe(900);
  });

  it("returns null (no ceiling, so the eBay search stays unfiltered) when grade profit data doesn't exist yet", async () => {
    const db = fakeDb(
      [],
      [
        gradeRow({
          card_id: "no-profit-data",
          reference_psa7_profit: null,
          reference_psa8_profit: null,
          reference_psa9_profit: null,
          reference_psa10_profit: null,
        }),
      ],
    );
    const universe = await listEligibleUniverseCards(db);
    expect(universe.get("no-profit-data")!.maxAcquisitionPrice).toBeNull();
  });

  it("a null ceiling on one side of a both-eligible card still yields the other side's real ceiling, not null", async () => {
    const db = fakeDb(
      [flipRow({ card_id: "partial", max_profitable_acquisition_price: 75 })],
      [
        gradeRow({
          card_id: "partial",
          reference_psa7_profit: null,
          reference_psa8_profit: null,
          reference_psa9_profit: null,
          reference_psa10_profit: null,
        }),
      ],
    );
    const universe = await listEligibleUniverseCards(db);
    expect(universe.get("partial")!.maxAcquisitionPrice).toBe(75);
  });
});
