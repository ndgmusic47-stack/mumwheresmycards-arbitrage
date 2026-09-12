import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dealsRoute } from "../src/routes/deals.js";
import { createSqliteD1, seedOpportunity, type SqliteHarness } from "./helpers/sqliteD1.js";

/**
 * THE ACTUAL WORKFLOW, END TO END, AGAINST THE REAL SCHEMA.
 *
 * Everything else in this feature is tested in isolation: the arithmetic in
 * packages/core/test/dealCalculator.test.ts, the SQL guarantees in
 * dealsRepo.test.ts against a fake D1, the browser payload rules in
 * apps/web/test/dealForm.test.ts. All of those can pass while the feature is
 * still broken, because none of them ever runs the HTTP route against a
 * database that has the migrations applied.
 *
 * This file does. It drives the real Hono route over a real SQLite database
 * built from apps/worker/migrations, through the sequence the operator
 * actually performs:
 *
 *   open → save assumptions → reopen → offer → revise → accept → purchase →
 *   try to purchase again → commitments
 *
 * The assertions that matter most are the ones about what SURVIVES: a saved
 * assumption still being there on reopen, an offer history still being
 * readable after it is superseded, and the same pennies coming back out as
 * went in.
 *
 * HONEST SCOPE: this is Node's SQLite, not Cloudflare D1, and it is not
 * Miniflare. It proves the SQL, the schema and the route agree. It does not
 * prove anything about the deployed Worker runtime, and it does not touch the
 * React components at all.
 */

let harness: SqliteHarness;

const OPP = "opp-e2e-1";
const env = () => ({ DB: harness.d1 } as never);

async function call(path: string, init?: RequestInit) {
  return dealsRoute.request(path, init, env());
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** A complete, realistic GRADE deal: £40 card, PSA Value, 10-card batch. */
const GRADE_INPUTS = {
  strategy: "GRADE",
  acquisition: {
    price: { amount: 40, currency: "GBP", provenance: "CONFIRMED" },
    sellerPostage: { amount: 3.5, currency: "GBP", provenance: "CONFIRMED" },
    // Confirmed zeros, not blanks: a UK purchase from a UK seller genuinely
    // had no import charges, and saying so is different from not knowing.
    importCharges: { amount: 0, currency: "GBP", provenance: "CONFIRMED" },
    otherAcquisitionCosts: { amount: 0, currency: "GBP", provenance: "CONFIRMED" },
  },
  grading: {
    graderId: "PSA",
    serviceName: "Value",
    serviceFee: { amount: 23, currency: "GBP", provenance: "CONFIRMED" },
    submissionPostage: { amount: 15, currency: "GBP", provenance: "ESTIMATE" },
    returnPostage: { amount: 20, currency: "GBP", provenance: "ESTIMATE" },
    batchInsurance: { amount: 12, currency: "GBP", provenance: "ESTIMATE" },
    batchSize: 10,
    consumablesPerCard: { amount: 0.3, currency: "GBP", provenance: "CONFIRMED" },
    upcharge: { amount: null, provenance: "UNKNOWN" },
    upchargeAppliesToGradeKeys: [],
  },
  sale: {
    buyerPaidShipping: { amount: 0, currency: "GBP", provenance: "CONFIRMED" },
    outboundPostage: { amount: 2, currency: "GBP", provenance: "CONFIRMED" },
    packaging: { amount: 0.3, currency: "GBP", provenance: "CONFIRMED" },
    saleInsurance: { amount: null, provenance: "UNKNOWN" },
  },
  resale: [
    { gradeKey: "PSA_10", value: { amount: 700, currency: "GBP", provenance: "ESTIMATE" }, valuationSource: "Terapeak UK sold", valuationDate: "2026-09-01", foreignMarketReference: false },
    { gradeKey: "PSA_9", value: { amount: 300, currency: "GBP", provenance: "ESTIMATE" }, valuationSource: "Terapeak UK sold", valuationDate: "2026-09-01", foreignMarketReference: false },
  ],
};

beforeEach(() => {
  harness = createSqliteD1();
  seedOpportunity(harness.raw, { cardId: "card-e2e", listingId: "listing-e2e", opportunityId: OPP, strategy: "GRADE" });
});

afterEach(() => harness.close());

describe("the schema and the code agree", () => {
  it("applies every migration in the repo, including the deals one", () => {
    expect(harness.migrationsApplied).toContain("0024_deals_and_offers.sql");
    const tables = harness.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(expect.arrayContaining(["deals", "deal_offers", "grading_batches", "grading_batch_members"]));
  });
});

describe("opening a listing with no deal yet", () => {
  it("returns the grader scales and no deal, rather than 404", async () => {
    const res = await call(`/opportunity/${OPP}`);
    expect(res.status).toBe(200);
    const body = await json<{ deal: unknown; graderScales: Record<string, { rungs: unknown[] }>; calculation: unknown }>(res);
    expect(body.deal).toBeNull();
    expect(body.calculation).toBeNull();
    expect(Object.keys(body.graderScales)).toEqual(expect.arrayContaining(["PSA", "CGC"]));
  });

  it("offers CGC's own scale, with both of its tens, rather than reusing PSA's", async () => {
    const body = await json<{ graderScales: Record<string, { rungs: { key: string; value: number }[] }> }>(
      await call(`/opportunity/${OPP}`),
    );
    const cgcTens = body.graderScales.CGC!.rungs.filter((r) => r.value === 10).map((r) => r.key);
    expect(cgcTens).toEqual(expect.arrayContaining(["CGC_PRISTINE_10", "CGC_GEM_MINT_10"]));
    expect(body.graderScales.PSA!.rungs.filter((r) => r.value === 10)).toHaveLength(1);
  });
});

describe("saving assumptions and getting them back", () => {
  async function save(inputs: unknown = GRADE_INPUTS) {
    return call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(inputs),
    });
  }

  it("saves, and the reopened deal returns the identical inputs", async () => {
    expect((await save()).status).toBeLessThan(300);

    const body = await json<{ deal: { inputs_json: string } }>(await call(`/opportunity/${OPP}`));
    const restored = JSON.parse(body.deal.inputs_json);
    expect(restored.acquisition.price.amount).toBe(40);
    expect(restored.grading.serviceName).toBe("Value");
    expect(restored.grading.batchSize).toBe(10);
    // The rule the whole feature rests on: a blank stays blank, and a
    // confirmed zero stays distinguishable from it.
    expect(restored.sale.saleInsurance.amount).toBeNull();
    expect(restored.sale.saleInsurance.provenance).toBe("UNKNOWN");
    expect(restored.acquisition.importCharges.amount).toBe(0);
    expect(restored.acquisition.importCharges.provenance).toBe("CONFIRMED");
  });

  it("reconciles penny for penny with the inputs — hand-checked", async () => {
    await save();
    const body = await json<{
      calculation: {
        acquisition: { total: number };
        grading: { total: number };
        totalCostBeforeScenario: number;
        scenarios: { gradeKey: string; totalCost: number; netProfit: number }[];
      };
    }>(await call(`/opportunity/${OPP}`));

    const calc = body.calculation;
    // Acquisition: 40.00 + 3.50 + 0.00 + 0.00.
    expect(calc.acquisition.total).toBe(43.5);
    // Grading: 23.00 service + (15 + 20 + 12) / 10 batch + 0.30 consumables
    //        = 23.00 + 1.50 + 2.00 + 1.20 + 0.30 = 28.00
    expect(calc.grading.total).toBe(28);
    expect(calc.totalCostBeforeScenario).toBe(71.5);
    // No upcharge, so every outcome carries the same cost.
    for (const scenario of calc.scenarios) expect(scenario.totalCost).toBe(71.5);
  });

  it("divides a batch cost across the batch, not onto every card in full", async () => {
    await save();
    const ten = (await json<{ calculation: { grading: { total: number } } }>(await call(`/opportunity/${OPP}`))).calculation;

    await save({ ...GRADE_INPUTS, grading: { ...GRADE_INPUTS.grading, batchSize: 1 } });
    const one = (await json<{ calculation: { grading: { total: number } } }>(await call(`/opportunity/${OPP}`))).calculation;

    // 47.00 of shared cost: £4.70/card across ten, all £47 alone.
    expect(one.grading.total - ten.grading.total).toBe(42.3);
  });

  it("rejects an invalid batch size instead of dividing by it", async () => {
    const res = await save({ ...GRADE_INPUTS, grading: { ...GRADE_INPUTS.grading, batchSize: 0 } });
    expect(res.status).toBe(400);
  });

  it("rejects a negative cost rather than treating it as a discount", async () => {
    const res = await save({
      ...GRADE_INPUTS,
      acquisition: { ...GRADE_INPUTS.acquisition, sellerPostage: { amount: -5, currency: "GBP", provenance: "CONFIRMED" } },
    });
    expect(res.status).toBe(400);
  });

  it("reports which inputs are missing rather than showing a complete-looking profit", async () => {
    await save({
      ...GRADE_INPUTS,
      acquisition: { ...GRADE_INPUTS.acquisition, price: { amount: null, provenance: "UNKNOWN" } },
    });
    const body = await json<{ calculation: { isComplete: boolean; missingInputs: string[] } }>(
      await call(`/opportunity/${OPP}`),
    );
    expect(body.calculation.isComplete).toBe(false);
    expect(body.calculation.missingInputs.join(" ")).toMatch(/price/i);
  });

  it("saving twice updates the same deal rather than creating a second one", async () => {
    await save();
    await save({ ...GRADE_INPUTS, acquisition: { ...GRADE_INPUTS.acquisition, price: { amount: 45, currency: "GBP", provenance: "CONFIRMED" } } });
    const count = harness.raw.prepare(`SELECT COUNT(*) AS n FROM deals WHERE opportunity_id = ?`).get(OPP) as { n: number };
    expect(count.n).toBe(1);
    const body = await json<{ calculation: { acquisition: { total: number } } }>(await call(`/opportunity/${OPP}`));
    expect(body.calculation.acquisition.total).toBe(48.5);
  });

  it("keeps the original FX snapshot on a re-save, so a saved deal cannot silently reprice", async () => {
    await save();
    const before = await json<{ deal: { fx_snapshot_json: string } }>(await call(`/opportunity/${OPP}`));
    await save({ ...GRADE_INPUTS, grading: { ...GRADE_INPUTS.grading, serviceName: "Regular" } });
    const after = await json<{ deal: { fx_snapshot_json: string } }>(await call(`/opportunity/${OPP}`));
    expect(after.deal.fx_snapshot_json).toBe(before.deal.fx_snapshot_json);
  });
});

describe("a foreign-currency purchase converts once and shows its working", () => {
  it("records the original amount, currency and rate on the line", async () => {
    await call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...GRADE_INPUTS,
        acquisition: {
          ...GRADE_INPUTS.acquisition,
          price: { amount: 100, currency: "USD", provenance: "CONFIRMED" },
        },
      }),
    });

    const body = await json<{
      calculation: {
        acquisition: { lines: { key: string; gbp: number; detail: { originalAmount: number; originalCurrency: string; rateToGbp: number } }[] };
      };
    }>(await call(`/opportunity/${OPP}`));

    const line = body.calculation.acquisition.lines.find((l) => l.key === "price")!;
    expect(line.detail.originalCurrency).toBe("USD");
    expect(line.detail.originalAmount).toBe(100);
    // Whatever today's rate is, the GBP figure must be that rate applied
    // exactly once — the specific rate is not asserted, the arithmetic is.
    expect(line.gbp).toBeCloseTo(100 * line.detail.rateToGbp, 6);
    expect(line.detail.rateToGbp).toBeGreaterThan(0);
    expect(line.detail.rateToGbp).toBeLessThan(1.5);
  });
});

describe("the offer lifecycle", () => {
  let dealId: string;

  beforeEach(async () => {
    await call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GRADE_INPUTS),
    });
    dealId = (await json<{ deal: { id: string } }>(await call(`/opportunity/${OPP}`))).deal.id;
  });

  const offer = (amount: number, currency = "GBP") =>
    call(`/${dealId}/offers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount, currency }),
    });

  it("records a pending offer that is not counted as spend", async () => {
    expect((await offer(30)).status).toBeLessThan(300);
    const commitments = await json<{
      pendingOffers: { count: number; potentialSpendGbp: number };
      actualSpend: { inventoryCount: number; spentGbp: number };
    }>(await call(`/commitments`));

    expect(commitments.pendingOffers).toEqual({ count: 1, potentialSpendGbp: 30 });
    expect(commitments.actualSpend).toEqual({ inventoryCount: 0, spentGbp: 0 });
  });

  it("revising keeps the old offer readable and leaves exactly one pending", async () => {
    await offer(30);
    await offer(35);

    const body = await json<{ offers: { amount: number; status: string; supersedes_id: string | null }[] }>(
      await call(`/opportunity/${OPP}`),
    );
    expect(body.offers).toHaveLength(2);
    expect(body.offers.filter((o) => o.status === "PENDING")).toHaveLength(1);
    expect(body.offers.find((o) => o.amount === 30)!.status).toBe("WITHDRAWN");
    expect(body.offers.find((o) => o.amount === 35)!.supersedes_id).not.toBeNull();

    const commitments = await json<{ pendingOffers: { count: number; potentialSpendGbp: number } }>(await call(`/commitments`));
    // The revised figure only — never 30 + 35.
    expect(commitments.pendingOffers).toEqual({ count: 1, potentialSpendGbp: 35 });
  });

  it("a rejected offer stops being an exposure but stays in the history", async () => {
    await offer(30);
    const offerId = (await json<{ offers: { id: string }[] }>(await call(`/opportunity/${OPP}`))).offers[0]!.id;

    const res = await call(`/offers/${offerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "REJECTED" }),
    });
    expect(res.status).toBeLessThan(300);

    expect((await json<{ pendingOffers: { count: number } }>(await call(`/commitments`))).pendingOffers.count).toBe(0);
    expect((await json<{ offers: unknown[] }>(await call(`/opportunity/${OPP}`))).offers).toHaveLength(1);
  });

  it("the same offer cannot be resolved twice into different outcomes", async () => {
    await offer(30);
    const offerId = (await json<{ offers: { id: string }[] }>(await call(`/opportunity/${OPP}`))).offers[0]!.id;
    const patch = (status: string) =>
      call(`/offers/${offerId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });

    expect((await patch("ACCEPTED")).status).toBeLessThan(300);
    expect((await patch("REJECTED")).status).toBeGreaterThanOrEqual(400);

    const stored = harness.raw.prepare(`SELECT status FROM deal_offers WHERE id = ?`).get(offerId) as { status: string };
    expect(stored.status).toBe("ACCEPTED");
  });

  it("rejects an invalid status instead of writing it", async () => {
    await offer(30);
    const offerId = (await json<{ offers: { id: string }[] }>(await call(`/opportunity/${OPP}`))).offers[0]!.id;
    const res = await call(`/offers/${offerId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "MAYBE" }),
    });
    expect(res.status).toBe(400);
  });

  it("a foreign-currency offer is exposed in GBP with its rate recorded", async () => {
    await offer(50, "USD");
    const body = await json<{ offers: { amount: number; currency: string; amount_gbp: number; rate_to_gbp: number }[] }>(
      await call(`/opportunity/${OPP}`),
    );
    const placed = body.offers[0]!;
    expect(placed.currency).toBe("USD");
    expect(placed.amount).toBe(50);
    expect(placed.amount_gbp).toBeCloseTo(50 * placed.rate_to_gbp, 6);
  });
});

describe("recording the purchase", () => {
  let dealId: string;

  beforeEach(async () => {
    await call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GRADE_INPUTS),
    });
    dealId = (await json<{ deal: { id: string } }>(await call(`/opportunity/${OPP}`))).deal.id;
  });

  const purchase = () => call(`/${dealId}/purchase`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

  it("creates exactly one inventory row with the itemised acquisition figures", async () => {
    const res = await purchase();
    expect(res.status).toBe(201);
    const { inventoryId } = await json<{ inventoryId: string }>(res);

    const row = harness.raw.prepare(`SELECT * FROM inventory WHERE id = ?`).get(inventoryId) as Record<string, unknown>;
    expect(row.actual_purchase_price).toBe(40);
    expect(row.actual_seller_postage).toBe(3.5);
    expect(row.actual_total_acquisition_cost).toBe(43.5);
    expect(row.status).toBe("PURCHASED");
    expect(row.deal_id).toBe(dealId);
  });

  it("refuses a second purchase for the same deal and names the existing row", async () => {
    const { inventoryId } = await json<{ inventoryId: string }>(await purchase());
    const second = await purchase();
    expect(second.status).toBe(409);
    expect((await json<{ inventoryId: string }>(second)).inventoryId).toBe(inventoryId);

    const count = harness.raw.prepare(`SELECT COUNT(*) AS n FROM inventory WHERE deal_id = ?`).get(dealId) as { n: number };
    expect(count.n).toBe(1);
  });

  it("the database itself forbids a second purchase, not only the route's check", async () => {
    // Proves the UNIQUE index is real, which is what protects against a
    // concurrent double-submit that the route's read-then-write cannot: the
    // second INSERT is attempted directly, bypassing the route entirely.
    await purchase();
    expect(() =>
      harness.raw
        .prepare(
          `INSERT INTO inventory (id, card_id, strategy, actual_purchase_price, actual_total_acquisition_cost, deal_id) VALUES (?,?,?,?,?,?)`,
        )
        .run("inv-bypass", "card-e2e", "GRADE", 40, 43.5, dealId),
    ).toThrow();
  });

  it("allows two inventory rows that came from no deal at all", () => {
    // The UNIQUE index is partial (WHERE deal_id IS NOT NULL). Without that,
    // it would silently cap manually-entered stock at one row forever.
    const insert = (id: string) =>
      harness.raw
        .prepare(`INSERT INTO inventory (id, card_id, strategy, actual_purchase_price, actual_total_acquisition_cost) VALUES (?,?,?,?,?)`)
        .run(id, "card-e2e", "FLIP", 10, 10);
    insert("inv-manual-1");
    expect(() => insert("inv-manual-2")).not.toThrow();
  });

  it("freezes the assumptions, so a later change to the deal does not rewrite the decision", async () => {
    const { inventoryId } = await json<{ inventoryId: string }>(await purchase());

    await call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...GRADE_INPUTS,
        acquisition: { ...GRADE_INPUTS.acquisition, price: { amount: 999, currency: "GBP", provenance: "CONFIRMED" } },
      }),
    });

    const row = harness.raw.prepare(`SELECT decision_snapshot FROM inventory WHERE id = ?`).get(inventoryId) as {
      decision_snapshot: string;
    };
    const frozen = JSON.parse(row.decision_snapshot);
    expect(frozen.inputs.acquisition.price.amount).toBe(40);
    expect(frozen.calculation.acquisition.total).toBe(43.5);
    expect(frozen.calcVersion).toBeTruthy();
    expect(frozen.committedAt).toBeTruthy();
  });

  it("the frozen record includes the operator's own overrides, not just the scan", async () => {
    const { inventoryId } = await json<{ inventoryId: string }>(await purchase());
    const frozen = JSON.parse(
      (harness.raw.prepare(`SELECT decision_snapshot FROM inventory WHERE id = ?`).get(inventoryId) as { decision_snapshot: string })
        .decision_snapshot,
    );
    expect(frozen.inputs.grading.serviceName).toBe("Value");
    expect(frozen.inputs.resale[0].valuationSource).toBe("Terapeak UK sold");
    expect(frozen.inputs.fx.capturedAt).toBeTruthy();
  });

  it("moves the card into the existing pipeline, where planned grading is then owed", async () => {
    await purchase();
    const commitments = await json<{
      actualSpend: { inventoryCount: number; spentGbp: number };
      plannedGrading: { cardCount: number; plannedGbp: number; uncostedCards: number };
    }>(await call(`/commitments`));

    expect(commitments.actualSpend).toEqual({ inventoryCount: 1, spentGbp: 43.5 });
    // The grading side of the frozen decision — owed, not yet spent.
    expect(commitments.plannedGrading).toEqual({ cardCount: 1, plannedGbp: 28, uncostedCards: 0 });
  });

  it("refuses to record spend while an acquisition cost is still unknown, and names it", async () => {
    // Regression guard for the bug this end-to-end test found: committing
    // used to succeed here, writing a total that silently omitted the
    // unknown line and then read downstream as money actually spent.
    await call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...GRADE_INPUTS,
        acquisition: { ...GRADE_INPUTS.acquisition, sellerPostage: { amount: null, provenance: "UNKNOWN" } },
      }),
    });

    const res = await purchase();
    expect(res.status).toBe(400);
    const body = await json<{ missingInputs: string[] }>(res);
    expect(body.missingInputs.join(" ").toLowerCase()).toMatch(/postage/);

    const count = harness.raw.prepare(`SELECT COUNT(*) AS n FROM inventory`).get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("a confirmed zero is accepted where a blank is refused", async () => {
    await call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...GRADE_INPUTS,
        acquisition: { ...GRADE_INPUTS.acquisition, sellerPostage: { amount: 0, currency: "GBP", provenance: "CONFIRMED" } },
      }),
    });
    expect((await purchase()).status).toBe(201);
  });
});

describe("the operator's assumptions are not reachable by a rescan", () => {
  it("nothing in the opportunities table can overwrite a saved deal", async () => {
    await call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GRADE_INPUTS),
    });

    // Simulate what a rescan does: rewrite the opportunity row wholesale.
    harness.raw.prepare(`UPDATE opportunities SET strategy = 'FLIP' WHERE id = ?`).run(OPP);

    const body = await json<{ deal: { inputs_json: string } | null }>(await call(`/opportunity/${OPP}`));
    expect(body.deal).not.toBeNull();
    expect(JSON.parse(body.deal!.inputs_json).acquisition.price.amount).toBe(40);
  });
});

/**
 * THE 500 THAT TOOK THE WHOLE DESK DOWN (found in production, 2026-09-12).
 *
 * The opportunity page returned `500 Internal Server Error` and every part of
 * the deal desk vanished with it — inputs, offers, calculation, offer history.
 * The cause was an OPTIONAL lookup: the provider price reference reads
 * `market_snapshots.graded_prices_json`, added by migration 0026, and the
 * worker had been deployed ahead of its migrations.
 *
 * This test recreates that exact database state by removing the column after
 * the migrations run, which is the only faithful way to reproduce "the code
 * is newer than the schema" — the failure mode a migrations-applied harness
 * otherwise cannot see, and the one that actually happens on deploy day.
 *
 * The assertion is deliberately two-sided: the desk must survive, AND the
 * real database error must still be reported. A version of this fix that
 * simply returned null would pass the first half and hide an unapplied
 * migration indefinitely.
 */
describe("a broken optional price reference cannot take down the deal desk", () => {
  it("still serves the deal, and names the underlying database error", async () => {
    await call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GRADE_INPUTS),
    });

    // Put the schema behind the code, exactly as an unapplied 0026 would.
    harness.raw.exec(`ALTER TABLE market_snapshots DROP COLUMN graded_prices_json`);

    const res = await call(`/opportunity/${OPP}`);
    expect(res.status).toBe(200);

    const body = await json<{
      deal: { inputs_json: string } | null;
      calculation: unknown;
      gradedPriceReference: unknown;
      gradedPriceReferenceError: string | null;
    }>(res);

    expect(body.deal).not.toBeNull();
    expect(body.calculation).not.toBeNull();
    expect(body.gradedPriceReference).toBeNull();
    expect(body.gradedPriceReferenceError).toMatch(/graded_prices_json/);
    expect(body.gradedPriceReferenceError).toMatch(/migrate:remote/);
  });

  it("the same is true before any deal has been saved", async () => {
    harness.raw.exec(`ALTER TABLE market_snapshots DROP COLUMN graded_prices_json`);

    const res = await call(`/opportunity/${OPP}`);
    expect(res.status).toBe(200);
    const body = await json<{ deal: null; gradedPriceReferenceError: string | null }>(res);
    expect(body.deal).toBeNull();
    expect(body.gradedPriceReferenceError).toMatch(/graded_prices_json/);
  });
});

/**
 * THE UNDER-OFFER PIPELINE STAGE.
 *
 * The two assertions that matter are both about a card appearing in exactly
 * ONE place. A card can otherwise be counted as a live offer and as owned
 * stock simultaneously, which would show the same money in two columns of
 * the pipeline and in two of the three commitment figures.
 */
describe("cards under offer", () => {
  async function saveAndOffer(amount: number) {
    await call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GRADE_INPUTS),
    });
    const deal = await json<{ deal: { id: string } }>(await call(`/opportunity/${OPP}`));
    await call(`/${deal.deal.id}/offers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount, currency: "GBP" }),
    });
    return deal.deal.id;
  }

  it("lists a deal with a live offer, with the card's real identity", async () => {
    await saveAndOffer(37.5);
    const body = await json<{ deals: { card_name: string | null; amount_gbp: number; opportunity_id: string }[] }>(
      await call(`/under-offer`),
    );
    expect(body.deals).toHaveLength(1);
    expect(body.deals[0].amount_gbp).toBe(37.5);
    expect(body.deals[0].opportunity_id).toBe(OPP);
    expect(body.deals[0].card_name).toBeTruthy();
  });

  it("shows the live offer only, never a superseded one", async () => {
    const dealId = await saveAndOffer(30);
    await call(`/${dealId}/offers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 34, currency: "GBP" }),
    });

    const body = await json<{ deals: { amount_gbp: number }[] }>(await call(`/under-offer`));
    expect(body.deals).toHaveLength(1);
    expect(body.deals[0].amount_gbp).toBe(34);
  });

  it("drops out of under-offer once the card is actually bought", async () => {
    const dealId = await saveAndOffer(37.5);
    const purchased = await call(`/${dealId}/purchase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(purchased.status).toBe(201);

    const body = await json<{ deals: unknown[] }>(await call(`/under-offer`));
    expect(body.deals).toHaveLength(0);
  });

  it("is empty when there are no deals at all", async () => {
    const body = await json<{ deals: unknown[]; count: number }>(await call(`/under-offer`));
    expect(body.deals).toHaveLength(0);
    expect(body.count).toBe(0);
  });
});

/**
 * MOVING A LEAD TO "UNDER OFFER" WITHOUT OPENING ITS DESK FIRST.
 *
 * The dangerous version of this feature creates a deal with plausible
 * defaults so the shortcut "just works". These tests exist to make that
 * impossible: the created deal must contain the offer and nothing else, and
 * it must still be refused at the purchase gate.
 *
 * The second test is the one that protects real work — a card the operator
 * has already priced up must not have those assumptions replaced by a stub
 * because they used the fast path from the pipeline.
 */
describe("quick offer from the pipeline", () => {
  it("creates a deal containing the offer and no other figure", async () => {
    const res = await call(`/opportunity/${OPP}/quick-offer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 28.5 }),
    });
    expect(res.status).toBe(201);
    expect((await json<{ dealCreated: boolean; needsCosts: boolean }>(res)).dealCreated).toBe(true);

    const bundle = await json<{
      deal: { inputs_json: string } | null;
      calculation: { acquisition: { total: number }; scenarios: { missingInputs: string[]; netProfit: number | null }[] };
    }>(await call(`/opportunity/${OPP}`));

    const inputs = JSON.parse(bundle.deal!.inputs_json);
    expect(inputs.acquisition.price.amount).toBe(28.5);
    // An offer is not a payment.
    expect(inputs.acquisition.price.provenance).toBe("ESTIMATE");
    expect(inputs.acquisition.sellerPostage.amount).toBeNull();
    expect(inputs.grading.serviceFee.amount).toBeNull();

    // The offer is the only money in the deal, and no profit was invented.
    expect(bundle.calculation.acquisition.total).toBe(28.5);
    expect(bundle.calculation.scenarios[0].netProfit).toBeNull();
    expect(bundle.calculation.scenarios[0].missingInputs.length).toBeGreaterThan(0);
  });

  it("never overwrites assumptions the operator already saved", async () => {
    await call(`/opportunity/${OPP}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(GRADE_INPUTS),
    });

    const res = await call(`/opportunity/${OPP}/quick-offer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 28.5 }),
    });
    expect(res.status).toBe(201);
    expect((await json<{ dealCreated: boolean }>(res)).dealCreated).toBe(false);

    const bundle = await json<{ deal: { inputs_json: string } }>(await call(`/opportunity/${OPP}`));
    const inputs = JSON.parse(bundle.deal.inputs_json);
    // The worked deal is untouched — price still £40 CONFIRMED, not £28.50.
    expect(inputs.acquisition.price.amount).toBe(40);
    expect(inputs.acquisition.price.provenance).toBe("CONFIRMED");
    expect(inputs.acquisition.sellerPostage.amount).toBe(3.5);
  });

  it("refuses an offer with no amount, rather than inventing one", async () => {
    for (const body of [{}, { amount: 0 }, { amount: "30" }, { amount: -5 }]) {
      const res = await call(`/opportunity/${OPP}/quick-offer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
    const under = await json<{ deals: unknown[] }>(await call(`/under-offer`));
    expect(under.deals).toHaveLength(0);
  });

  it("a quick-offered card cannot be recorded as bought until its costs are stated", async () => {
    const placed = await json<{ dealId: string }>(
      await call(`/opportunity/${OPP}/quick-offer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 28.5 }),
      }),
    );

    const res = await call(`/${placed.dealId}/purchase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await json<{ missingInputs: string[] }>(res);
    expect(body.missingInputs.length).toBeGreaterThan(0);
  });

  it("an accepted offer stays in the column, flagged, until the purchase is recorded", async () => {
    await call(`/opportunity/${OPP}/quick-offer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 28.5 }),
    });
    const before = await json<{ deals: { offer_id: string; offer_status: string }[] }>(await call(`/under-offer`));
    expect(before.deals[0].offer_status).toBe("PENDING");

    await call(`/offers/${before.deals[0].offer_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ACCEPTED" }),
    });

    const after = await json<{ deals: { offer_status: string }[] }>(await call(`/under-offer`));
    expect(after.deals).toHaveLength(1);
    expect(after.deals[0].offer_status).toBe("ACCEPTED");
  });

  it("a rejected offer leaves the column entirely", async () => {
    await call(`/opportunity/${OPP}/quick-offer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 28.5 }),
    });
    const before = await json<{ deals: { offer_id: string }[] }>(await call(`/under-offer`));
    await call(`/offers/${before.deals[0].offer_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "REJECTED" }),
    });

    const after = await json<{ deals: unknown[] }>(await call(`/under-offer`));
    expect(after.deals).toHaveLength(0);
  });
});
