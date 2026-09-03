import { Hono } from "hono";
import { Db } from "@mwmc/db";
import { allocateCapital } from "@mwmc/core";
import { listCapitalAllocationCandidates } from "../repo/opportunitiesRepo.js";
import type { Env } from "../env.js";

export const capitalAllocationRoute = new Hono<{ Bindings: Env }>();

/**
 * AI INTELLIGENCE spec item 28 (deterministic capital allocation). Given a
 * total capital pool (a per-request figure — see capitalAllocation.ts's own
 * doc comment on why this module never assumes a default budget), decides
 * which of the CURRENTLY QUALIFIED opportunities to fund, deterministically.
 * A live, read-only "what-if" calculator: nothing here writes to the
 * database, marks anything as bought, or places any order — see the
 * top-level spec's DO-NOT-DO list ("no autonomous purchasing").
 */
interface CapitalAllocationBody {
  totalAvailableCapital: number;
  maxSingleOpportunityFraction?: number;
  maxPerCardFraction?: number;
  reserveFraction?: number;
}

capitalAllocationRoute.post("/", async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json<CapitalAllocationBody>().catch(() => ({}) as CapitalAllocationBody);

  if (typeof body.totalAvailableCapital !== "number" || !(body.totalAvailableCapital > 0)) {
    return c.json({ error: "totalAvailableCapital is required and must be a positive number" }, 400);
  }

  const candidates = await listCapitalAllocationCandidates(db);
  const result = allocateCapital(candidates, {
    totalAvailableCapital: body.totalAvailableCapital,
    maxSingleOpportunityFraction: body.maxSingleOpportunityFraction,
    maxPerCardFraction: body.maxPerCardFraction,
    reserveFraction: body.reserveFraction,
  });

  return c.json({
    candidatesConsidered: candidates.length,
    ...result,
  });
});
