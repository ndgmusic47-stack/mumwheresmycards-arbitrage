import { Hono } from "hono";
import { Db } from "@mwmc/db";
import { computeMaxRawPriceForGrading, DEFAULT_MAX_BUY_REFERENCE_GRADE, type PsaGrade } from "@mwmc/core";
import { loadSettings } from "../repo/settingsRepo.js";
import type { Env } from "../env.js";

export const maxBuyRoute = new Hono<{ Bindings: Env }>();

/**
 * AI INTELLIGENCE spec item 14: reverse max-buy solver, GRADE side. FLIP's
 * equivalent already exists inline on GET /opportunities (computeMaxBid,
 * per-row, against that row's own already-persisted economics) — this is
 * deliberately a SEPARATE, stateless "what-if" calculator rather than a new
 * column silently added to every GRADE row, because GRADE's real
 * qualification bar (../filters/types.ts's GradeQualificationRules) is a
 * multi-branch economic-class predicate, not a single (minNetProfit,
 * minReturnOnCapital) pair — collapsing it into one automatically-applied
 * pair for every row risked presenting a false, over-precise "safe to pay
 * up to £X" number. Here the caller supplies the target profit/ROC
 * explicitly (a specific human decision, or later an AI-layer query),
 * exactly the way computeMaxRawPriceForGrading itself is designed — see
 * that function's own doc comment in packages/core/src/calc/maxBuySolver.ts.
 */
interface MaxBuyGradeBody {
  slabValueAtGrade: number;
  /** Which grading service tier to solve against (e.g. "PSA_REGULAR",
   *  "PSA_VALUE") — looked up from live Settings, never hardcoded. */
  serviceId: string;
  minNetProfit: number;
  minReturnOnCapital: number;
  /** Which PSA grade this slabValueAtGrade refers to — informational only
   *  (the solve itself doesn't branch on grade number), defaults to the
   *  same reference grade convention used elsewhere for capital-velocity
   *  comparisons. */
  grade?: PsaGrade;
  sellerPostage?: number;
  importTax?: number;
  acquisitionFees?: number;
  upchargeReserve?: number;
}

maxBuyRoute.post("/grade", async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json<MaxBuyGradeBody>();

  if (typeof body.slabValueAtGrade !== "number" || typeof body.minNetProfit !== "number" || typeof body.minReturnOnCapital !== "number") {
    return c.json({ error: "slabValueAtGrade, minNetProfit and minReturnOnCapital are required numbers" }, 400);
  }
  if (!body.serviceId) {
    return c.json({ error: "serviceId is required" }, 400);
  }

  const settings = await loadSettings(db);
  const service = settings.gradingServices.find((s) => s.id === body.serviceId);
  if (!service) {
    return c.json({ error: `Unknown serviceId "${body.serviceId}" — not present in current Settings gradingServices` }, 400);
  }

  const result = computeMaxRawPriceForGrading({
    slabValueAtGrade: body.slabValueAtGrade,
    service,
    minNetProfit: body.minNetProfit,
    minReturnOnCapital: body.minReturnOnCapital,
    sellerPostage: body.sellerPostage,
    importTax: body.importTax,
    acquisitionFees: body.acquisitionFees,
    upchargeReserve: body.upchargeReserve,
    batch: settings.gradingBatch,
    consumables: settings.gradingConsumables,
    feeModel: settings.feeModel,
    sellingCosts: settings.sellingCosts,
  });

  return c.json({
    grade: body.grade ?? DEFAULT_MAX_BUY_REFERENCE_GRADE,
    serviceId: service.id,
    serviceName: service.name,
    ...result,
  });
});
