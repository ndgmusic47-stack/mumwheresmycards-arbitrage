import { Hono } from "hono";
import { Db } from "@mwmc/db";
import { LIQUIDITY_ORDER } from "@mwmc/core";
import type { LiquidityLevel } from "@mwmc/core";
import type { Env } from "../env.js";
import { loadMarketSummaryStats } from "../repo/marketProfilesRepo.js";

export const marketRoute = new Hono<{ Bindings: Env }>();

/**
 * The MARKET tab's backing API: explores the ENTIRE auto-synced card
 * database (CARD MARKET layer) — every catalogued card, whether or not it
 * currently clears any dashboard filter — with the full filter set from
 * the realignment brief: raw price range, PSA8/9/10 minimums, break-even
 * grade ceiling, grade/flip score minimums, liquidity/confidence minimums,
 * raw sales (sample size) minimum, plus set/name/variant text filters.
 * Deliberately separate from /opportunities, which only ever shows a real
 * listing-backed trade — this shows the market's economics independent of
 * live eBay supply.
 */
marketRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const q = c.req.query();

  const conditions: string[] = [];
  const params: unknown[] = [];

  const addRange = (column: string, min?: string, max?: string) => {
    if (min !== undefined && min !== "") {
      conditions.push(`${column} >= ?`);
      params.push(Number(min));
    }
    if (max !== undefined && max !== "") {
      conditions.push(`${column} <= ?`);
      params.push(Number(max));
    }
  };

  addRange("fp.raw_market_value", q.rawMin, q.rawMax);
  addRange("gp.psa8", q.psa8Min, undefined);
  addRange("gp.psa9", q.psa9Min, undefined);
  addRange("gp.psa10", q.psa10Min, undefined);
  addRange("gp.grade_market_score", q.gradeScoreMin, undefined);
  addRange("fp.flip_market_score", q.flipScoreMin, undefined);
  addRange("COALESCE(gp.raw_sample_size, fp.raw_sample_size)", q.rawSalesMin, undefined);

  if (q.breakEvenMax) {
    conditions.push(`gp.break_even_grade IS NOT NULL AND gp.break_even_grade <= ?`);
    params.push(Number(q.breakEvenMax));
  }

  if (q.liquidityMin && isLiquidityLevel(q.liquidityMin)) {
    const minOrder = LIQUIDITY_ORDER[q.liquidityMin];
    const levelsAtOrAbove = (Object.keys(LIQUIDITY_ORDER) as LiquidityLevel[]).filter((l) => LIQUIDITY_ORDER[l] >= minOrder);
    conditions.push(
      `(COALESCE(fp.liquidity, gp.liquidity) IN (${levelsAtOrAbove.map(() => "?").join(",")}))`,
    );
    params.push(...levelsAtOrAbove);
  }

  if (q.confidenceMin) {
    conditions.push(`COALESCE(fp.confidence, gp.confidence, 0) >= ?`);
    params.push(Number(q.confidenceMin));
  }

  if (q.set) {
    conditions.push(`(c.set_name LIKE ? OR c.set_code LIKE ?)`);
    params.push(`%${q.set}%`, `%${q.set}%`);
  }
  if (q.name) {
    conditions.push(`c.name LIKE ?`);
    params.push(`%${q.name}%`);
  }
  if (q.variant) {
    conditions.push(`c.variant = ?`);
    params.push(q.variant);
  }
  if (q.strategy === "FLIP") {
    conditions.push(`fp.eligible = 1`);
  } else if (q.strategy === "GRADE") {
    conditions.push(`gp.eligible = 1`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(500, Number(q.limit) || 100);

  const rows = await db.queryAll(
    `SELECT
       c.id, c.name, c.set_name, c.set_code, c.card_number, c.year, c.edition, c.variant, c.finish, c.rarity,
       c.last_ebay_scanned_at,
       fp.raw_market_value, fp.conservative_qsv, fp.raw_sample_size as flip_raw_sample_size,
       fp.liquidity as flip_liquidity, fp.confidence as flip_confidence,
       fp.max_profitable_acquisition_price, fp.eligible as flip_eligible, fp.flip_market_score,
       gp.psa7, gp.psa8, gp.psa9, gp.psa10, gp.raw_sample_size as grade_raw_sample_size,
       gp.break_even_grade, gp.psa10_upside_multiple, gp.liquidity as grade_liquidity,
       gp.confidence as grade_confidence, gp.eligible as grade_eligible, gp.grade_market_score
     FROM cards c
     LEFT JOIN flip_profiles fp ON fp.card_id = c.id
     LEFT JOIN grade_profiles gp ON gp.card_id = c.id
     ${where}
     ORDER BY COALESCE(gp.grade_market_score, 0) + COALESCE(fp.flip_market_score, 0) DESC
     LIMIT ?`,
    ...params,
    limit,
  );

  return c.json({ cards: rows });
});

/** Dashboard summary header — always computed live, never a stale estimate. */
marketRoute.get("/summary", async (c) => {
  const db = new Db(c.env.DB);
  const stats = await loadMarketSummaryStats(db);
  return c.json(stats);
});

function isLiquidityLevel(value: string): value is LiquidityLevel {
  return value in LIQUIDITY_ORDER;
}
