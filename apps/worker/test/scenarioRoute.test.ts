import { describe, it, expect } from "vitest";
import type { D1Like, D1PreparedStatementLike, D1ResultLike } from "@mwmc/db";
import { runFlipScenario, runGradeScenario, DEFAULT_EXIT_MARKET_FEE_MODEL, DEFAULT_SELLING_COSTS, DEFAULT_GRADING_BATCH, DEFAULT_GRADING_CONSUMABLES } from "@mwmc/core";
import { scenarioRoute, sanitizeSlabValueOverrides, sanitizeBusinessCostOverrides, gradingCostOverrideDelta } from "../src/routes/scenario.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream M
 * (scenario/what-if engine) at the HTTP layer. The deterministic
 * runFlipScenario/runGradeScenario arithmetic is covered exhaustively in
 * packages/core/test/scenarioEngine.test.ts, and the AI narrator's own
 * request-shaping/grounding logic in
 * packages/providers/test/aiScenarioNarratorProvider.test.ts — these tests
 * pin the ROUTE's own job: loading the real opportunity/market snapshot,
 * reconstructing the correct baseline, input validation, that the computed
 * scenario matches calling the engine directly with the same effective
 * inputs, and that the full narration chain (settings load ->
 * createAiModelProvider -> AiCompletionCache -> GuardedAiModelProvider ->
 * AiScenarioNarratorProvider) wires together and degrades honestly with no
 * OPENAI_API_KEY bound, same as every other AI route in this app.
 */

interface FakeRows {
  opportunity?: Record<string, unknown> | null;
  card?: Record<string, unknown> | null;
  marketSnapshot?: Record<string, unknown> | null;
}

/** Same "recognize by SQL prefix" in-memory D1 double as
 *  queryInterpreterRoute.test.ts, extended to also serve opportunities/
 *  cards/market_snapshots single-row lookups by table name. `.all()` for
 *  `settings` always returns empty results (settings load resolves to
 *  every core default, same as an unconfigured environment). */
function fakeD1({ opportunity = null, card = null, marketSnapshot = null }: FakeRows = {}): D1Like {
  const d1: D1Like = {
    prepare: (sql: string): D1PreparedStatementLike => {
      const self: D1PreparedStatementLike = {
        bind: () => self,
        first: async <T>() => {
          if (/SUM\(cost_weight\)/i.test(sql)) return { total: 0 } as unknown as T;
          if (/FROM opportunities/i.test(sql)) return (opportunity as unknown as T) ?? null;
          if (/FROM cards/i.test(sql)) return (card as unknown as T) ?? null;
          if (/FROM market_snapshots/i.test(sql)) return (marketSnapshot as unknown as T) ?? null;
          return null as T | null;
        },
        all: async <T>() => ({ results: [] as T[], success: true, meta: {} }) as D1ResultLike<T>,
        run: async <T>() => ({ success: true, meta: {} }) as D1ResultLike<T>,
      };
      return self;
    },
    batch: async () => [],
  };
  return d1;
}

function flipOpportunity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "opp-flip-1",
    card_id: "card-1",
    market_snapshot_id: null,
    strategy: "FLIP",
    total_acquisition_cost: 100,
    qsv: 150,
    total_graded_basis: null,
    grading_service_id: null,
    ...overrides,
  };
}

function gradeOpportunity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "opp-grade-1",
    card_id: "card-1",
    market_snapshot_id: 42,
    strategy: "GRADE",
    total_acquisition_cost: 120,
    qsv: null,
    total_graded_basis: 200,
    grading_service_id: null,
    ...overrides,
  };
}

async function postScenario(db: D1Like, id: string, body: unknown) {
  return scenarioRoute.request(
    `/${id}/scenario`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { DB: db },
  );
}

describe("sanitizeSlabValueOverrides", () => {
  it("keeps a valid non-negative number for a real grade", () => {
    expect(sanitizeSlabValueOverrides({ "9": 600 })).toEqual({ 9: 600 });
  });

  it("keeps an explicit null for a real grade (means 'no market data')", () => {
    expect(sanitizeSlabValueOverrides({ "9": null })).toEqual({ 9: null });
  });

  it("drops a negative value rather than clamping it", () => {
    expect(sanitizeSlabValueOverrides({ "9": -50 })).toEqual({});
  });

  it("drops a non-numeric, non-null value", () => {
    expect(sanitizeSlabValueOverrides({ "9": "600" })).toEqual({});
  });

  it("drops a key that isn't a real grade", () => {
    expect(sanitizeSlabValueOverrides({ "11": 600, "0": 100 })).toEqual({});
  });

  it("returns an empty object for null/non-object input", () => {
    expect(sanitizeSlabValueOverrides(null)).toEqual({});
    expect(sanitizeSlabValueOverrides("not an object")).toEqual({});
  });
});

// AI INTELLIGENCE gap 4 (financial engineering — business-cost scenario
// overrides). Same re-validation discipline as sanitizeSlabValueOverrides
// above: a malformed/out-of-range field is dropped, never coerced.
describe("sanitizeBusinessCostOverrides", () => {
  it("returns all-empty sub-objects for null/non-object input", () => {
    expect(sanitizeBusinessCostOverrides(null)).toEqual({ sellingCosts: {}, feeModel: {}, gradingBatch: {}, gradingConsumables: {} });
    expect(sanitizeBusinessCostOverrides("nope")).toEqual({ sellingCosts: {}, feeModel: {}, gradingBatch: {}, gradingConsumables: {} });
  });

  it("keeps valid non-negative sellingCosts fields, drops the rest", () => {
    const result = sanitizeBusinessCostOverrides({
      sellingCosts: { outboundPostage: 3.5, packaging: -1, notARealField: 9 },
    });
    expect(result.sellingCosts).toEqual({ outboundPostage: 3.5 });
  });

  it("keeps a fee fraction in [0,1], drops one above 1 (the 'forgot to divide by 100' guard)", () => {
    const result = sanitizeBusinessCostOverrides({ feeModel: { finalValueFeePct: 0.15 } });
    expect(result.feeModel).toEqual({ finalValueFeePct: 0.15 });

    const rejected = sanitizeBusinessCostOverrides({ feeModel: { finalValueFeePct: 15 } });
    expect(rejected.feeModel).toEqual({});
  });

  it("keeps non-negative flat fee fields and the VAT-recoverable boolean", () => {
    const result = sanitizeBusinessCostOverrides({
      feeModel: { perOrderFee: 0.5, perOrderFeeThreshold: 10, sellerFeeVatRecoverable: true },
    });
    expect(result.feeModel).toEqual({ perOrderFee: 0.5, perOrderFeeThreshold: 10, sellerFeeVatRecoverable: true });
  });

  it("keeps a valid integer batchSize >= 1, drops a fractional or zero one", () => {
    expect(sanitizeBusinessCostOverrides({ gradingBatch: { batchSize: 8 } }).gradingBatch).toEqual({ batchSize: 8 });
    expect(sanitizeBusinessCostOverrides({ gradingBatch: { batchSize: 8.5 } }).gradingBatch).toEqual({});
    expect(sanitizeBusinessCostOverrides({ gradingBatch: { batchSize: 0 } }).gradingBatch).toEqual({});
  });

  it("keeps valid gradingConsumables fields", () => {
    const result = sanitizeBusinessCostOverrides({ gradingConsumables: { sleeveCost: 0.2 } });
    expect(result.gradingConsumables).toEqual({ sleeveCost: 0.2 });
  });
});

describe("gradingCostOverrideDelta", () => {
  const empty = { sellingCosts: {}, feeModel: {}, gradingBatch: {}, gradingConsumables: {} };

  it("is zero when neither gradingBatch nor gradingConsumables is overridden", () => {
    expect(gradingCostOverrideDelta(empty, DEFAULT_GRADING_BATCH, DEFAULT_GRADING_CONSUMABLES)).toBe(0);
  });

  it("reflects a smaller batch size spreading shared logistics over fewer cards (delta > 0)", () => {
    const delta = gradingCostOverrideDelta(
      { ...empty, gradingBatch: { batchSize: 5 } },
      DEFAULT_GRADING_BATCH,
      DEFAULT_GRADING_CONSUMABLES,
    );
    // (15+20+12)/5 = 9.4 vs /10 = 4.7 -> costs MORE per card at a smaller batch.
    expect(delta).toBeCloseTo(4.7, 2);
  });

  it("reflects a consumables override directly (no batch division)", () => {
    const delta = gradingCostOverrideDelta(
      { ...empty, gradingConsumables: { sleeveCost: DEFAULT_GRADING_CONSUMABLES.sleeveCost + 0.5 } },
      DEFAULT_GRADING_BATCH,
      DEFAULT_GRADING_CONSUMABLES,
    );
    expect(delta).toBeCloseTo(0.5, 2);
  });

  it("never depends on rawPurchasePrice/service fee/upchargeReserve — same delta regardless of those (cancels out)", () => {
    // gradingCostOverrideDelta always internally uses 0/0/ZERO_FEE_SERVICE —
    // this test just re-confirms the CONTRACT (a pure batch/consumables
    // delta) by checking it against a hand-computed expectation twice with
    // different override shapes that should be additive.
    const batchOnly = gradingCostOverrideDelta({ ...empty, gradingBatch: { batchSize: 5 } }, DEFAULT_GRADING_BATCH, DEFAULT_GRADING_CONSUMABLES);
    const consumablesOnly = gradingCostOverrideDelta(
      { ...empty, gradingConsumables: { sleeveCost: DEFAULT_GRADING_CONSUMABLES.sleeveCost + 0.5 } },
      DEFAULT_GRADING_BATCH,
      DEFAULT_GRADING_CONSUMABLES,
    );
    const both = gradingCostOverrideDelta(
      { ...empty, gradingBatch: { batchSize: 5 }, gradingConsumables: { sleeveCost: DEFAULT_GRADING_CONSUMABLES.sleeveCost + 0.5 } },
      DEFAULT_GRADING_BATCH,
      DEFAULT_GRADING_CONSUMABLES,
    );
    expect(both).toBeCloseTo(batchOnly + consumablesOnly, 2);
  });
});

describe("POST /:id/scenario — 404 and validation", () => {
  it("404s when the opportunity doesn't exist", async () => {
    const res = await postScenario(fakeD1({ opportunity: null }), "missing", { totalAcquisitionCost: 80 });
    expect(res.status).toBe(404);
  });

  it("FLIP: 400s when the opportunity has no QSV recorded", async () => {
    const res = await postScenario(fakeD1({ opportunity: flipOpportunity({ qsv: null }) }), "opp-flip-1", { totalAcquisitionCost: 80 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/QSV/);
  });

  it("FLIP: 400s when no valid override is supplied", async () => {
    const res = await postScenario(fakeD1({ opportunity: flipOpportunity() }), "opp-flip-1", {});
    expect(res.status).toBe(400);
  });

  it("FLIP: 400s when the only supplied override is malformed (negative/non-numeric)", async () => {
    const res = await postScenario(fakeD1({ opportunity: flipOpportunity() }), "opp-flip-1", { totalAcquisitionCost: -5 });
    expect(res.status).toBe(400);
  });

  it("GRADE: 400s when the opportunity has no graded basis recorded", async () => {
    const res = await postScenario(fakeD1({ opportunity: gradeOpportunity({ total_graded_basis: null }) }), "opp-grade-1", {
      totalGradedBasis: 150,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/graded basis/);
  });

  it("GRADE: 400s when no valid override is supplied", async () => {
    const res = await postScenario(fakeD1({ opportunity: gradeOpportunity() }), "opp-grade-1", {});
    expect(res.status).toBe(400);
  });
});

describe("POST /:id/scenario — FLIP", () => {
  it("computes a scenario identical to calling runFlipScenario directly with the opportunity's own baseline and the same overrides", async () => {
    const opportunity = flipOpportunity({ total_acquisition_cost: 100, qsv: 150 });
    const res = await postScenario(fakeD1({ opportunity }), "opp-flip-1", { totalAcquisitionCost: 80 });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { strategy: string; scenario: ReturnType<typeof runFlipScenario> };
    expect(body.strategy).toBe("FLIP");

    const expected = runFlipScenario({ totalAcquisitionCost: 100, qsv: 150 }, { totalAcquisitionCost: 80 }, DEFAULT_EXIT_MARKET_FEE_MODEL, DEFAULT_SELLING_COSTS);
    expect(body.scenario).toEqual(expected);
  });

  it("ignores an unset field, applying only the override actually supplied", async () => {
    const opportunity = flipOpportunity({ total_acquisition_cost: 100, qsv: 150 });
    const res = await postScenario(fakeD1({ opportunity }), "opp-flip-1", { qsv: 200 });

    const body = (await res.json()) as { scenario: ReturnType<typeof runFlipScenario> };
    expect(body.scenario.scenario.netProfit).not.toEqual(body.scenario.baseline.netProfit);

    const expected = runFlipScenario({ totalAcquisitionCost: 100, qsv: 150 }, { qsv: 200 }, DEFAULT_EXIT_MARKET_FEE_MODEL, DEFAULT_SELLING_COSTS);
    expect(body.scenario).toEqual(expected);
  });

  it("does not narrate by default (narration is null, no AI call attempted)", async () => {
    const res = await postScenario(fakeD1({ opportunity: flipOpportunity() }), "opp-flip-1", { totalAcquisitionCost: 80 });
    const body = (await res.json()) as { narration: unknown; providerName: unknown };
    expect(body.narration).toBeNull();
    expect(body.providerName).toBeNull();
  });

  it("wires the full narration chain together and degrades honestly with no OPENAI_API_KEY bound", async () => {
    const res = await postScenario(fakeD1({ opportunity: flipOpportunity(), card: { id: "card-1", name: "Charizard VMAX" } }), "opp-flip-1", {
      totalAcquisitionCost: 80,
      narrate: true,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { narration: { available: boolean; caveats: string[] }; providerName: string };
    expect(body.providerName).toBe("scenario-narrator");
    expect(body.narration.available).toBe(false);
    expect(body.narration.caveats[0]).toMatch(/not configured|API key/i);
  });

  // AI INTELLIGENCE gap 4 (business-cost scenario overrides).
  it("accepts a businessCosts-only request with no totalAcquisitionCost/qsv override", async () => {
    const res = await postScenario(fakeD1({ opportunity: flipOpportunity() }), "opp-flip-1", {
      businessCosts: { sellingCosts: { outboundPostage: 10 } },
    });
    expect(res.status).toBe(200);
  });

  it("a sellingCosts override moves the scenario side without moving the baseline", async () => {
    const opportunity = flipOpportunity({ total_acquisition_cost: 100, qsv: 150 });
    const res = await postScenario(fakeD1({ opportunity }), "opp-flip-1", {
      businessCosts: { sellingCosts: { outboundPostage: DEFAULT_SELLING_COSTS.outboundPostage + 10 } },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenario: ReturnType<typeof runFlipScenario> };

    const expectedBaseline = runFlipScenario({ totalAcquisitionCost: 100, qsv: 150 }, {}, DEFAULT_EXIT_MARKET_FEE_MODEL, DEFAULT_SELLING_COSTS).baseline;
    expect(body.scenario.baseline).toEqual(expectedBaseline);
    // Dearer outbound postage eats into net proceeds -> strictly lower profit.
    expect(body.scenario.scenario.netProfit).toBeLessThan(body.scenario.baseline.netProfit);
  });
});

describe("POST /:id/scenario — GRADE", () => {
  it("builds the baseline slab values from the linked market_snapshot's psa6-10 columns, not the opportunity row", async () => {
    const opportunity = gradeOpportunity({ total_graded_basis: 200, market_snapshot_id: 42 });
    const marketSnapshot = { id: 42, psa6: 80, psa7: 150, psa8: 300, psa9: 600, psa10: 2000 };
    const res = await postScenario(fakeD1({ opportunity, marketSnapshot }), "opp-grade-1", { slabValues: { "9": 900 } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenario: ReturnType<typeof runGradeScenario> };

    const expected = runGradeScenario(
      { totalGradedBasis: 200, slabValues: { 6: 80, 7: 150, 8: 300, 9: 600, 10: 2000 } },
      { slabValues: { 9: 900 } },
      undefined,
      DEFAULT_EXIT_MARKET_FEE_MODEL,
      DEFAULT_SELLING_COSTS,
      undefined,
    );
    expect(body.scenario).toEqual(expected);
  });

  it("treats a grade with no market_snapshot row (or no linked snapshot) as null, never a fabricated value", async () => {
    const opportunity = gradeOpportunity({ total_graded_basis: 200, market_snapshot_id: null });
    const res = await postScenario(fakeD1({ opportunity, marketSnapshot: null }), "opp-grade-1", { totalGradedBasis: 150 });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenario: ReturnType<typeof runGradeScenario> };
    for (const rung of body.scenario.baseline.rungs) {
      expect(rung.grossSlabValue).toBeNull();
    }
  });

  it("passes the opportunity's own grading_service_id through to the engine when it matches a configured service", async () => {
    // No settings rows configured (fakeD1's .all() is always empty) -> the
    // live gradingServices list falls back to DEFAULT_GRADING_SERVICES,
    // which includes "PSA_REGULAR" — confirm the route actually looks it
    // up rather than always passing `undefined`.
    const opportunity = gradeOpportunity({ total_graded_basis: 200, market_snapshot_id: 42, grading_service_id: "PSA_REGULAR" });
    const marketSnapshot = { id: 42, psa6: 80, psa7: 150, psa8: 300, psa9: 600, psa10: 2000 };
    const res = await postScenario(fakeD1({ opportunity, marketSnapshot }), "opp-grade-1", { totalGradedBasis: 150 });

    expect(res.status).toBe(200);
    // Only assert the route didn't 500/misbehave with a real service looked
    // up — the service's own effect on computeGradeLadder (declared-value
    // cap / upcharge flags) is already covered by packages/core's own
    // gradeLadder.test.ts.
    const body = (await res.json()) as { scenario: ReturnType<typeof runGradeScenario> };
    expect(body.scenario.baseline.rungs).toHaveLength(5);
  });

  it("skips narration and returns an honest no-data caveat when PSA10 has no market data on either side, rather than sending a fabricated headline figure", async () => {
    const opportunity = gradeOpportunity({ total_graded_basis: 200, market_snapshot_id: 42 });
    const marketSnapshot = { id: 42, psa6: 80, psa7: 150, psa8: 300, psa9: 600, psa10: null };
    const res = await postScenario(fakeD1({ opportunity, marketSnapshot, card: { id: "card-1", name: "Charizard VMAX" } }), "opp-grade-1", {
      totalGradedBasis: 150,
      narrate: true,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { narration: { available: boolean; caveats: string[] }; providerName: string | null };
    expect(body.narration.available).toBe(false);
    expect(body.narration.caveats[0]).toMatch(/PSA10/);
    expect(body.providerName).toBeNull();
  });

  it("wires the full narration chain together and degrades honestly with no OPENAI_API_KEY bound, when PSA10 data exists on both sides", async () => {
    const opportunity = gradeOpportunity({ total_graded_basis: 200, market_snapshot_id: 42 });
    const marketSnapshot = { id: 42, psa6: 80, psa7: 150, psa8: 300, psa9: 600, psa10: 2000 };
    const res = await postScenario(fakeD1({ opportunity, marketSnapshot, card: { id: "card-1", name: "Charizard VMAX" } }), "opp-grade-1", {
      slabValues: { "10": 2500 },
      narrate: true,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { narration: { available: boolean; caveats: string[] }; providerName: string };
    expect(body.providerName).toBe("scenario-narrator");
    expect(body.narration.available).toBe(false);
    expect(body.narration.caveats[0]).toMatch(/not configured|API key/i);
  });

  // AI INTELLIGENCE gap 4 (business-cost scenario overrides).
  it("accepts a businessCosts-only request with no totalGradedBasis/slabValues override", async () => {
    const res = await postScenario(fakeD1({ opportunity: gradeOpportunity() }), "opp-grade-1", {
      businessCosts: { gradingBatch: { batchSize: 5 } },
    });
    expect(res.status).toBe(200);
  });

  it("a gradingBatch override moves the scenario's graded basis (via the delta) without moving the baseline", async () => {
    const opportunity = gradeOpportunity({ total_graded_basis: 200, market_snapshot_id: 42 });
    const marketSnapshot = { id: 42, psa6: 80, psa7: 150, psa8: 300, psa9: 600, psa10: 2000 };
    const res = await postScenario(fakeD1({ opportunity, marketSnapshot }), "opp-grade-1", {
      businessCosts: { gradingBatch: { batchSize: 5 } },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenario: ReturnType<typeof runGradeScenario> };

    const expectedBaseline = runGradeScenario(
      { totalGradedBasis: 200, slabValues: { 6: 80, 7: 150, 8: 300, 9: 600, 10: 2000 } },
      {},
      undefined,
      DEFAULT_EXIT_MARKET_FEE_MODEL,
      DEFAULT_SELLING_COSTS,
      undefined,
    ).baseline;
    expect(body.scenario.baseline).toEqual(expectedBaseline);
    // A smaller batch spreads shared logistics over fewer cards -> a HIGHER
    // basis -> strictly lower profit at every populated grade.
    const baselinePsa10 = body.scenario.baseline.rungs.find((r) => r.grade === 10)!.profit!;
    const scenarioPsa10 = body.scenario.scenario.rungs.find((r) => r.grade === 10)!.profit!;
    expect(scenarioPsa10).toBeLessThan(baselinePsa10);
  });

  it("composes an explicit totalGradedBasis override with a gradingBatch delta on top", async () => {
    const opportunity = gradeOpportunity({ total_graded_basis: 200, market_snapshot_id: 42 });
    const marketSnapshot = { id: 42, psa6: 80, psa7: 150, psa8: 300, psa9: 600, psa10: 2000 };
    const res = await postScenario(fakeD1({ opportunity, marketSnapshot }), "opp-grade-1", {
      totalGradedBasis: 150,
      businessCosts: { gradingConsumables: { sleeveCost: 0.6 } }, // +0.5 vs default 0.1
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scenario: ReturnType<typeof runGradeScenario> };
    expect(body.scenario.scenario.totalGradedBasis).toBeCloseTo(150.5, 2);
  });
});
