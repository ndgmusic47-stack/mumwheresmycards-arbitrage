import { describe, it, expect } from "vitest";
import type { D1Like, D1PreparedStatementLike, D1ResultLike, InventoryRow } from "@mwmc/db";
import { inventoryRoute } from "../src/routes/inventory.js";

/**
 * REGRESSION GUARD for AI INTELLIGENCE spec item 19 (learning database —
 * arrival truth). Pins the honest-default contract: condition_matched_listing
 * is NULL (not yet confirmed either way) unless the caller explicitly says
 * true or false — it must never default to "matched".
 */
function fakeD1(row: InventoryRow | null): { d1: D1Like; updateArgs: unknown[][] } {
  const updateArgs: unknown[][] = [];
  const stmt = (sql: string): D1PreparedStatementLike => {
    let boundArgs: unknown[] = [];
    const self: D1PreparedStatementLike = {
      bind: (...args: unknown[]) => {
        boundArgs = args;
        return self;
      },
      first: async () => (sql.includes("SELECT") ? row : null),
      all: async () => ({ results: [], success: true, meta: {} }) as D1ResultLike<unknown>,
      run: async () => {
        if (sql.startsWith("UPDATE inventory")) updateArgs.push(boundArgs);
        return { success: true, meta: {} } as D1ResultLike<unknown>;
      },
    };
    return self;
  };
  return {
    d1: { prepare: (sql: string) => stmt(sql), batch: async () => [] },
    updateArgs,
  };
}

function row(overrides: Partial<InventoryRow> = {}): InventoryRow {
  return {
    id: "inv-1",
    opportunity_id: null,
    card_id: "card-1",
    strategy: "GRADE",
    status: "PURCHASED",
    actual_purchase_price: 80,
    actual_seller_postage: 2,
    actual_import_tax: 0,
    actual_other_acquisition_fees: 0,
    actual_total_acquisition_cost: 82,
    source_url: null,
    purchased_at: "2026-09-01T00:00:00Z",
    notes: null,
    forecast_snapshot: null,
    forecast_frozen_at: null,
    arrived_at: null,
    condition_matched_listing: null,
    arrival_notes: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  } as InventoryRow;
}

describe("PATCH /inventory/:id/arrival", () => {
  it("records a confirmed match", async () => {
    const { d1, updateArgs } = fakeD1(row());
    const res = await inventoryRoute.request(
      "/inv-1/arrival",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ conditionMatchedListing: true }) },
      { DB: d1 },
    );

    expect(res.status).toBe(200);
    expect(updateArgs[0]).toEqual([1, null, "inv-1"]);
  });

  it("records a real mismatch as 0, not silently dropped", async () => {
    const { d1, updateArgs } = fakeD1(row());
    const res = await inventoryRoute.request(
      "/inv-1/arrival",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conditionMatchedListing: false, notes: "Visible whitening not disclosed" }),
      },
      { DB: d1 },
    );

    expect(res.status).toBe(200);
    expect(updateArgs[0]).toEqual([0, "Visible whitening not disclosed", "inv-1"]);
  });

  it("defaults to NULL (not yet confirmed), never to 'matched', when omitted", async () => {
    const { d1, updateArgs } = fakeD1(row());
    await inventoryRoute.request("/inv-1/arrival", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }, { DB: d1 });

    expect(updateArgs[0]![0]).toBeNull();
  });

  it("404s for an inventory row that doesn't exist", async () => {
    const { d1 } = fakeD1(null);
    const res = await inventoryRoute.request(
      "/missing/arrival",
      { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ conditionMatchedListing: true }) },
      { DB: d1 },
    );

    expect(res.status).toBe(404);
  });
});
