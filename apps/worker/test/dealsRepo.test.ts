import { describe, it, expect } from "vitest";
import type { D1Like, D1PreparedStatementLike, D1ResultLike } from "@mwmc/db";
import { Db } from "@mwmc/db";
import {
  placeOffer,
  resolveOffer,
  saveDeal,
  recordPurchaseFromDeal,
  pendingOfferExposure,
  actualAcquisitionSpend,
  plannedGradingCost,
  OFFER_STATUSES,
  type DealOfferRow,
} from "../src/repo/dealsRepo.js";
import type { DealInputs, FxSnapshot } from "@mwmc/core";

/**
 * REGRESSION GUARD for the per-card trading desk's persistence rules.
 *
 * These assert the properties that decide whether real money is
 * double-counted or a purchase is recorded twice — not that a row round
 * trips, which is trivially true of any column.
 *
 * Same fake-D1 approach as every other persistence test in this suite
 * (opportunityReview.test.ts, listingsRepo.test.ts): capture the SQL and
 * params actually generated, and assert against them. That is the only way
 * to pin down a guarantee that lives in a WHERE clause.
 */
function fakeDb(rows: Record<string, unknown[]> = {}) {
  const execs: { sql: string; params: unknown[] }[] = [];
  const d1: D1Like = {
    prepare: (sql: string): D1PreparedStatementLike => {
      let params: unknown[] = [];
      const self: D1PreparedStatementLike = {
        bind: (...args: unknown[]) => {
          params = args;
          return self;
        },
        first: async <T>() => {
          for (const [needle, result] of Object.entries(rows)) {
            if (sql.includes(needle)) return (result[0] ?? null) as T | null;
          }
          return null as T | null;
        },
        all: async <T>() => {
          for (const [needle, result] of Object.entries(rows)) {
            if (sql.includes(needle)) return { results: result as T[], success: true, meta: {} } as D1ResultLike<T>;
          }
          return { results: [] as T[], success: true, meta: {} } as D1ResultLike<T>;
        },
        run: async () => {
          execs.push({ sql, params });
          return { success: true, meta: {} };
        },
      };
      return self;
    },
    batch: async <T>() => [] as D1ResultLike<T>[],
  };
  return { db: new Db(d1), execs };
}

const FX: FxSnapshot = { rates: { GBP: 1, USD: 0.79 }, source: "LIVE", capturedAt: "2026-09-12T00:00:00.000Z" };

const INPUTS = {
  strategy: "GRADE",
  acquisition: { price: { amount: 40, currency: "GBP", provenance: "CONFIRMED" } },
  grading: { graderId: "PSA", serviceName: "Value", serviceFee: { amount: 23, provenance: "CONFIRMED" }, batchSize: 10 },
  sale: {},
  resale: [{ gradeKey: "PSA_9", value: { amount: 300, provenance: "ESTIMATE" } }],
  fx: FX,
} as unknown as DealInputs;

describe("saving assumptions is idempotent per opportunity", () => {
  it("upserts on opportunity_id, so saving twice updates rather than duplicating", async () => {
    const { db, execs } = fakeDb();
    await saveDeal(db, { id: "deal-1", opportunityId: "opp-1", cardId: "card-1", inputs: INPUTS, fx: FX });
    expect(execs[0]!.sql).toMatch(/ON CONFLICT\(opportunity_id\) DO UPDATE SET/);
  });

  it("never rewrites created_at — when a deal was first worked is part of its history", async () => {
    const { db, execs } = fakeDb();
    await saveDeal(db, { id: "deal-1", opportunityId: "opp-1", cardId: "card-1", inputs: INPUTS, fx: FX });
    const updateClause = execs[0]!.sql.split("DO UPDATE SET")[1]!;
    expect(updateClause).not.toMatch(/created_at/);
    expect(updateClause).toMatch(/updated_at/);
  });

  it("stores the FX snapshot alongside the inputs, so a reopened deal reproduces its own pennies", async () => {
    const { db, execs } = fakeDb();
    await saveDeal(db, { id: "deal-1", opportunityId: "opp-1", cardId: "card-1", inputs: INPUTS, fx: FX });
    // Asserted POSITIONALLY, not by searching the params for a substring:
    // `inputs_json` embeds the same snapshot, so a substring search finds the
    // wrong column and would pass even if fx_snapshot_json were never bound.
    // Bind order: id, opportunity_id, card_id, strategy, grader_id,
    //             grading_service_name, inputs_json, fx_snapshot_json, ...
    const params = execs[0]!.params;
    expect(JSON.parse(String(params[7]))).toEqual(FX);
    expect(JSON.parse(String(params[6])).strategy).toBe("GRADE");
  });
});

describe("offers are revised by superseding, never by editing", () => {
  const pending: DealOfferRow = {
    id: "offer-1",
    deal_id: "deal-1",
    amount: 30,
    currency: "GBP",
    rate_to_gbp: null,
    amount_gbp: 30,
    status: "PENDING",
    placed_at: "2026-09-12T00:00:00Z",
    resolved_at: null,
    expires_at: null,
    supersedes_id: null,
    note: null,
    created_at: "2026-09-12T00:00:00Z",
  };

  it("withdraws the previous pending offer and points the new one at it", async () => {
    const { db, execs } = fakeDb({ "status = 'PENDING'": [pending] });
    const { supersededId } = await placeOffer(db, {
      id: "offer-2",
      dealId: "deal-1",
      amount: 35,
      currency: "GBP",
      rateToGbp: null,
      amountGbp: 35,
    });

    expect(supersededId).toBe("offer-1");
    expect(execs[0]!.sql).toMatch(/SET status = 'WITHDRAWN'/);
    expect(execs[0]!.sql).toMatch(/AND status = 'PENDING'/);
    expect(execs[1]!.params).toContain("offer-1"); // supersedes_id
  });

  it("never issues a DELETE — offer history is permanent", async () => {
    const { db, execs } = fakeDb({ "status = 'PENDING'": [pending] });
    await placeOffer(db, { id: "offer-2", dealId: "deal-1", amount: 35, currency: "GBP", rateToGbp: null, amountGbp: 35 });
    for (const exec of execs) expect(exec.sql).not.toMatch(/DELETE/i);
  });

  it("leaves exactly one pending offer per deal, so exposure can never double-count", async () => {
    const { db, execs } = fakeDb({ "status = 'PENDING'": [pending] });
    await placeOffer(db, { id: "offer-2", dealId: "deal-1", amount: 35, currency: "GBP", rateToGbp: null, amountGbp: 35 });
    const withdrawals = execs.filter((e) => /SET status = 'WITHDRAWN'/.test(e.sql));
    const inserts = execs.filter((e) => /INSERT INTO deal_offers/.test(e.sql));
    expect(withdrawals).toHaveLength(1);
    expect(inserts).toHaveLength(1);
  });

  it("records a foreign-currency offer with the rate actually applied", async () => {
    const { db, execs } = fakeDb();
    await placeOffer(db, { id: "offer-1", dealId: "deal-1", amount: 100, currency: "USD", rateToGbp: 0.79, amountGbp: 79 });
    const insert = execs.find((e) => /INSERT INTO deal_offers/.test(e.sql))!;
    expect(insert.params).toContain("USD");
    expect(insert.params).toContain(0.79);
    expect(insert.params).toContain(79);
  });
});

describe("resolving an offer is guarded against being applied twice", () => {
  it("only updates a row that is still PENDING", async () => {
    const { db, execs } = fakeDb({ "WHERE id = ?": [{ id: "offer-1", status: "ACCEPTED" }] });
    await resolveOffer(db, "offer-1", "ACCEPTED");
    expect(execs[0]!.sql).toMatch(/WHERE id = \? AND status = 'PENDING'/);
  });

  it("reports failure when the offer was already resolved", async () => {
    const { db } = fakeDb({ "WHERE id = ?": [{ id: "offer-1", status: "REJECTED" }] });
    const result = await resolveOffer(db, "offer-1", "ACCEPTED");
    expect(result.updated).toBe(false);
  });

  it("covers every terminal status the workflow needs", () => {
    expect(OFFER_STATUSES).toEqual(["PENDING", "ACCEPTED", "REJECTED", "EXPIRED", "WITHDRAWN"]);
  });
});

describe("pending offers and actual spend are counted separately", () => {
  it("exposure sums only PENDING offers", async () => {
    const { db } = fakeDb({ "FROM deal_offers WHERE status = 'PENDING'": [{ n: 3, total: 145.5 }] });
    expect(await pendingOfferExposure(db)).toEqual({ count: 3, totalGbp: 145.5 });
  });

  it("actual spend reads inventory, never offers", async () => {
    const { db } = fakeDb({ "FROM inventory": [{ n: 2, total: 88 }] });
    const spend = await actualAcquisitionSpend(db);
    expect(spend).toEqual({ count: 2, totalGbp: 88 });
  });

  it("an empty ledger reports zero rather than null", async () => {
    const { db } = fakeDb({ "FROM deal_offers WHERE status = 'PENDING'": [{ n: 0, total: null }] });
    expect((await pendingOfferExposure(db)).totalGbp).toBe(0);
  });
});

describe("planned grading cost is read from the frozen decision, not recomputed", () => {
  const snapshot = (gradingTotal: number) => JSON.stringify({ calculation: { grading: { total: gradingTotal } } });

  it("sums the grading side of each unfinished GRADE card", async () => {
    const { db } = fakeDb({
      "FROM inventory": [{ decision_snapshot: snapshot(31.06) }, { decision_snapshot: snapshot(26.7) }],
    });
    const planned = await plannedGradingCost(db);
    expect(planned.count).toBe(2);
    expect(planned.totalGbp).toBe(57.76);
  });

  it("counts a card with no snapshot as UNCOSTED rather than as zero", async () => {
    const { db } = fakeDb({
      "FROM inventory": [{ decision_snapshot: snapshot(31.06) }, { decision_snapshot: null }],
    });
    const planned = await plannedGradingCost(db);
    expect(planned.count).toBe(1);
    expect(planned.totalGbp).toBe(31.06);
    // The whole point: the £0 card is reported as missing a figure, not
    // silently averaged away into a total that looks complete.
    expect(planned.uncosted).toBe(1);
  });

  it("treats an unparseable snapshot as uncosted, never as free", async () => {
    const { db } = fakeDb({ "FROM inventory": [{ decision_snapshot: "{not json" }] });
    const planned = await plannedGradingCost(db);
    expect(planned.totalGbp).toBe(0);
    expect(planned.uncosted).toBe(1);
  });

  it("treats a snapshot with no grading total as uncosted", async () => {
    const { db } = fakeDb({ "FROM inventory": [{ decision_snapshot: JSON.stringify({ calculation: {} }) }] });
    expect((await plannedGradingCost(db)).uncosted).toBe(1);
  });

  it("only considers GRADE cards that have not yet been graded", async () => {
    const { db } = fakeDb();
    const captured: string[] = [];
    // Re-wrap to capture the SELECT, which is where the scoping lives.
    const original = (db as unknown as { queryAll: (sql: string) => Promise<unknown[]> }).queryAll.bind(db);
    (db as unknown as { queryAll: (sql: string) => Promise<unknown[]> }).queryAll = async (sql: string) => {
      captured.push(sql);
      return original(sql);
    };
    await plannedGradingCost(db);
    expect(captured[0]).toMatch(/strategy = 'GRADE'/);
    expect(captured[0]).toMatch(/status IN \('PURCHASED', 'AWAITING_GRADING'\)/);
  });
});

describe("a deal can only be purchased once", () => {
  it("refuses a second purchase and names the inventory row that already exists", async () => {
    const { db, execs } = fakeDb({ "FROM inventory WHERE deal_id = ?": [{ id: "inv-existing" }] });
    const result = await recordPurchaseFromDeal(db, {
      inventoryId: "inv-new",
      dealId: "deal-1",
      opportunityId: "opp-1",
      cardId: "card-1",
      strategy: "GRADE",
      purchasePrice: 40,
      sellerPostage: 3.5,
      importTax: 0,
      otherFees: 0,
      totalAcquisitionCost: 43.5,
      decisionSnapshot: { anything: true },
    });

    expect(result.created).toBe(false);
    expect(result.existingInventoryId).toBe("inv-existing");
    expect(execs.filter((e) => /INSERT INTO inventory/.test(e.sql))).toHaveLength(0);
  });

  it("freezes the decision snapshot on the inventory row when it does create one", async () => {
    const { db, execs } = fakeDb();
    const snapshot = { inputs: INPUTS, committedAt: "2026-09-12T12:00:00Z" };
    const result = await recordPurchaseFromDeal(db, {
      inventoryId: "inv-new",
      dealId: "deal-1",
      opportunityId: "opp-1",
      cardId: "card-1",
      strategy: "GRADE",
      purchasePrice: 40,
      sellerPostage: 3.5,
      importTax: 0,
      otherFees: 0,
      totalAcquisitionCost: 43.5,
      decisionSnapshot: snapshot,
    });

    expect(result.created).toBe(true);
    const insert = execs.find((e) => /INSERT INTO inventory/.test(e.sql))!;
    const stored = insert.params.map(String).find((p) => p.includes("committedAt"));
    expect(JSON.parse(stored!)).toEqual(snapshot);
    expect(insert.params).toContain("deal-1");
  });

  it("records the itemised acquisition figures, not just the total", async () => {
    const { db, execs } = fakeDb();
    await recordPurchaseFromDeal(db, {
      inventoryId: "inv-new",
      dealId: "deal-1",
      opportunityId: "opp-1",
      cardId: "card-1",
      strategy: "FLIP",
      purchasePrice: 40,
      sellerPostage: 3.5,
      importTax: 1.25,
      otherFees: 0.5,
      totalAcquisitionCost: 45.25,
      decisionSnapshot: {},
    });
    const insert = execs.find((e) => /INSERT INTO inventory/.test(e.sql))!;
    for (const value of [40, 3.5, 1.25, 0.5, 45.25]) expect(insert.params).toContain(value);
  });
});
