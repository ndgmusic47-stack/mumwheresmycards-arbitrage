import { describe, it, expect } from "vitest";
import type { D1Like, D1PreparedStatementLike, D1ResultLike } from "@mwmc/db";
import { reconciliationRoute } from "../src/routes/reconciliation.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec Phase 2, Workstream N at the
 * HTTP layer. The deterministic reconciliation arithmetic itself
 * (buildForecastTargets, and computeRealisedEconomics/
 * compareForecastVsRealised/summarizeForecastVariance from @mwmc/core) is
 * covered exhaustively elsewhere — these tests pin the ROUTE's own job:
 * assembling multiple sold trades (with and without a usable forecast, FLIP
 * and GRADE) into records + summary statistics, the `audit` opt-in gate
 * (off by default, an honest no-data caveat when nothing has a forecast
 * yet, and the full real chain wiring together and degrading honestly with
 * no OPENAI_API_KEY bound when it does).
 */

interface Fixtures {
  transactions?: Record<string, unknown>[];
  inventoryById?: Record<string, Record<string, unknown>>;
  cardsById?: Record<string, Record<string, unknown>>;
  submissionsByInventoryId?: Record<string, Record<string, unknown>>;
  resultsBySubmissionId?: Record<string, Record<string, unknown>>;
}

function fakeD1(fixtures: Fixtures = {}): D1Like {
  const { transactions = [], inventoryById = {}, cardsById = {}, submissionsByInventoryId = {}, resultsBySubmissionId = {} } = fixtures;

  return {
    prepare: (sql: string): D1PreparedStatementLike => {
      let boundArgs: unknown[] = [];
      const self: D1PreparedStatementLike = {
        bind: (...args: unknown[]) => {
          boundArgs = args;
          return self;
        },
        first: async <T>() => {
          if (/SUM\(cost_weight\)/i.test(sql)) return { total: 0 } as unknown as T;
          if (/FROM inventory WHERE id/i.test(sql)) return (inventoryById[boundArgs[0] as string] ?? null) as T | null;
          if (/FROM cards WHERE id/i.test(sql)) return (cardsById[boundArgs[0] as string] ?? null) as T | null;
          if (/FROM grading_submissions WHERE inventory_id/i.test(sql)) return (submissionsByInventoryId[boundArgs[0] as string] ?? null) as T | null;
          if (/FROM grading_results WHERE submission_id/i.test(sql)) return (resultsBySubmissionId[boundArgs[0] as string] ?? null) as T | null;
          return null as T | null;
        },
        all: async <T>() => {
          if (/FROM transactions/i.test(sql)) return { results: transactions as T[], success: true, meta: {} } as D1ResultLike<T>;
          return { results: [] as T[], success: true, meta: {} } as D1ResultLike<T>;
        },
        run: async <T>() => ({ success: true, meta: {} }) as D1ResultLike<T>,
      };
      return self;
    },
    batch: async () => [],
  };
}

function flipTransaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "txn-1",
    inventory_id: "inv-flip-1",
    sale_price: 150,
    marketplace_fees: 15,
    payment_processing_fees: 0,
    outbound_postage: 2,
    insurance: 0,
    packaging: 1,
    sold_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function flipInventory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "inv-flip-1",
    card_id: "card-1",
    strategy: "FLIP",
    actual_purchase_price: 90,
    actual_seller_postage: 2,
    actual_import_tax: 0,
    actual_other_acquisition_fees: 0,
    purchased_at: "2026-07-01T00:00:00Z",
    forecast_snapshot: JSON.stringify({
      strategy: "FLIP",
      expected_net_profit: 50,
      return_on_capital: 0.5,
      estimated_capital_lock_days: 20,
    }),
    ...overrides,
  };
}

describe("GET /reconciliation", () => {
  it("returns an empty summary with sampleSize 0 when there are no transactions at all", async () => {
    const res = await reconciliationRoute.request("/", {}, { DB: fakeD1() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { records: unknown[]; summary: { overall: { sampleSize: number } } };
    expect(body.records).toEqual([]);
    expect(body.summary.overall.sampleSize).toBe(0);
  });

  it("reconciles a FLIP trade against its frozen forecast and includes it in the overall/FLIP summaries", async () => {
    const db = fakeD1({
      transactions: [flipTransaction()],
      inventoryById: { "inv-flip-1": flipInventory() },
      cardsById: { "card-1": { id: "card-1", name: "Charizard VMAX" } },
    });

    const res = await reconciliationRoute.request("/", {}, { DB: db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: { cardName: string; strategy: string; hasForecast: boolean; forecastNetProfit: number | null; profitVariance: number | null }[];
      summary: { overall: { sampleSize: number }; flip: { sampleSize: number }; grade: { sampleSize: number } };
    };

    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.cardName).toBe("Charizard VMAX");
    expect(body.records[0]!.strategy).toBe("FLIP");
    expect(body.records[0]!.hasForecast).toBe(true);
    expect(body.records[0]!.forecastNetProfit).toBe(50);
    expect(body.records[0]!.profitVariance).not.toBeNull();

    expect(body.summary.overall.sampleSize).toBe(1);
    expect(body.summary.flip.sampleSize).toBe(1);
    expect(body.summary.grade.sampleSize).toBe(0);
  });

  it("reconciles a GRADE trade against the forecast for the SPECIFIC grade actually achieved", async () => {
    const db = fakeD1({
      transactions: [flipTransaction({ id: "txn-2", inventory_id: "inv-grade-1", sale_price: 900 })],
      inventoryById: {
        "inv-grade-1": {
          id: "inv-grade-1",
          card_id: "card-2",
          strategy: "GRADE",
          actual_purchase_price: 100,
          actual_seller_postage: 3,
          actual_import_tax: 0,
          actual_other_acquisition_fees: 0,
          purchased_at: "2026-06-01T00:00:00Z",
          forecast_snapshot: JSON.stringify({
            strategy: "GRADE",
            total_graded_basis: 150,
            psa9_profit: 200,
            psa10_profit: 600,
            estimated_capital_lock_days: 45,
          }),
        },
      },
      cardsById: { "card-2": { id: "card-2", name: "Pikachu Illustrator" } },
      submissionsByInventoryId: {
        "inv-grade-1": {
          id: "sub-1",
          inventory_id: "inv-grade-1",
          submitted_at: "2026-06-10T00:00:00Z",
          actual_grading_fee: 25,
          actual_postage_out: 5,
          actual_insurance: 2,
          actual_packaging: 1,
        },
      },
      resultsBySubmissionId: {
        "sub-1": { id: "res-1", submission_id: "sub-1", grade_numeric: 9, returned_at: "2026-07-01T00:00:00Z", actual_return_postage: 4 },
      },
    });

    const res = await reconciliationRoute.request("/", {}, { DB: db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      records: { strategy: string; actualGrade: number | null; forecastNetProfit: number | null }[];
      summary: { grade: { sampleSize: number } };
    };

    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.strategy).toBe("GRADE");
    expect(body.records[0]!.actualGrade).toBe(9);
    expect(body.records[0]!.forecastNetProfit).toBe(200); // psa9_profit, not psa10_profit
    expect(body.summary.grade.sampleSize).toBe(1);
  });

  it("marks a trade with no linked forecast as hasForecast:false and excludes it from the summary sample", async () => {
    const db = fakeD1({
      transactions: [flipTransaction({ id: "txn-3", inventory_id: "inv-noforecast" })],
      inventoryById: {
        "inv-noforecast": flipInventory({ id: "inv-noforecast", forecast_snapshot: null }),
      },
      cardsById: { "card-1": { id: "card-1", name: "Charizard VMAX" } },
    });

    const res = await reconciliationRoute.request("/", {}, { DB: db });
    const body = (await res.json()) as { records: { hasForecast: boolean; profitVariance: number | null }[]; summary: { overall: { sampleSize: number } } };

    expect(body.records).toHaveLength(1);
    expect(body.records[0]!.hasForecast).toBe(false);
    expect(body.records[0]!.profitVariance).toBeNull();
    expect(body.summary.overall.sampleSize).toBe(0);
  });

  it("does not audit by default (audit is null, no AI call attempted)", async () => {
    const db = fakeD1({
      transactions: [flipTransaction()],
      inventoryById: { "inv-flip-1": flipInventory() },
      cardsById: { "card-1": { id: "card-1", name: "Charizard VMAX" } },
    });

    const res = await reconciliationRoute.request("/", {}, { DB: db });
    const body = (await res.json()) as { audit: unknown; providerName: unknown };
    expect(body.audit).toBeNull();
    expect(body.providerName).toBeNull();
  });

  it("?audit=1 with no realised trade with a forecast yet returns an honest no-data caveat, never calling the model", async () => {
    const res = await reconciliationRoute.request("/?audit=1", {}, { DB: fakeD1() });
    const body = (await res.json()) as { audit: { available: boolean; caveats: string[] }; providerName: string | null };

    expect(body.audit.available).toBe(false);
    expect(body.audit.caveats[0]).toMatch(/nothing to audit/i);
    expect(body.providerName).toBeNull();
  });

  it("?audit=1 wires the full chain together and degrades honestly with no OPENAI_API_KEY bound, when there is data", async () => {
    const db = fakeD1({
      transactions: [flipTransaction()],
      inventoryById: { "inv-flip-1": flipInventory() },
      cardsById: { "card-1": { id: "card-1", name: "Charizard VMAX" } },
    });

    const res = await reconciliationRoute.request("/?audit=1", {}, { DB: db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { audit: { available: boolean; caveats: string[] }; providerName: string };

    expect(body.providerName).toBe("financial-auditor");
    expect(body.audit.available).toBe(false);
    expect(body.audit.caveats[0]).toMatch(/not configured|API key/i);
  });
});
