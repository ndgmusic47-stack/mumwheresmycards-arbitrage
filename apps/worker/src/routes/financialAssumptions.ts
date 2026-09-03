import { Hono } from "hono";
import { Db } from "@mwmc/db";
import type { Env } from "../env.js";
import {
  getFinancialAssumption,
  getFinancialAssumptionHistory,
  listFinancialAssumptions,
  summariseByClassification,
  upsertFinancialAssumption,
  type FinancialAssumptionClassification,
} from "../repo/financialAssumptionsRepo.js";

export const financialAssumptionsRoute = new Hono<{ Bindings: Env }>();

const VALID_CLASSIFICATIONS: FinancialAssumptionClassification[] = ["VERIFIED", "USER_SUPPLIED", "DERIVED", "UNKNOWN"];

/**
 * AI INTELLIGENCE spec item 11 (financial-assumptions ledger). Read-only
 * visibility for now — see financialAssumptionsRepo.ts's doc comment for
 * why this ledger is descriptive/auditable rather than a runtime config
 * layer. A dashboard surface for this is not yet built (Phase 1 of this
 * spec is deliberately deterministic-backend-only); this route exists so
 * the data is reachable and testable ahead of that.
 */
financialAssumptionsRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const assumptions = await listFinancialAssumptions(db);
  return c.json({ assumptions, summary: summariseByClassification(assumptions) });
});

financialAssumptionsRoute.get("/:id", async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param("id");
  const assumption = await getFinancialAssumption(db, id);
  if (!assumption) return c.json({ error: "Not found" }, 404);

  const history = await getFinancialAssumptionHistory(db, id);
  return c.json({ assumption, history });
});

interface UpdateAssumptionBody {
  category?: string;
  label?: string;
  value: unknown;
  classification: string;
  sourceNote?: string | null;
  updatedBy?: string | null;
}

/**
 * Deliberately requires category/label/classification to already exist (or
 * be supplied) rather than silently inventing them — an assumption row
 * with a blank label/category is worse than no ledger at all. Rejects an
 * unrecognised classification outright rather than accepting free text
 * that would defeat the whole point of a fixed, meaningful taxonomy.
 */
financialAssumptionsRoute.put("/:id", async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param("id");
  const body = await c.req.json<UpdateAssumptionBody>();

  if (!VALID_CLASSIFICATIONS.includes(body.classification as FinancialAssumptionClassification)) {
    return c.json({ error: `classification must be one of ${VALID_CLASSIFICATIONS.join(", ")}` }, 400);
  }

  const existing = await getFinancialAssumption(db, id);
  const category = body.category ?? existing?.category;
  const label = body.label ?? existing?.label;
  if (!category || !label) {
    return c.json({ error: "category and label are required for a new assumption" }, 400);
  }

  const updated = await upsertFinancialAssumption(db, {
    id,
    category,
    label,
    value: body.value,
    classification: body.classification as FinancialAssumptionClassification,
    sourceNote: body.sourceNote ?? null,
    updatedBy: body.updatedBy ?? "user",
  });

  return c.json({ assumption: updated });
});
