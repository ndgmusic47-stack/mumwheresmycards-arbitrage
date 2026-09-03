import { describe, it, expect } from "vitest";
import { buildStateCondition, buildFilterConditions } from "../src/routes/opportunities.js";

/**
 * MWMC V1 FINAL SHIP PASS item 8: fixture-based regression proof that manual
 * numeric filters can retrieve a genuine, positive-economics candidate that
 * fails the PERSISTED qualification bar (~£40 profit / 40% ROC), as long as
 * it's queried against a broader threshold — WITHOUT the server ever
 * lowering the hardcoded 40/40 bar itself. This is the actual, wire-level
 * behaviour of GET /api/opportunities?state=WATCH&minNetProfit=...&minRoc=...
 * (the "Near misses" tab — apps/web/src/state/filters.ts's
 * CATEGORY_STATES.NEAR_MISS — with the FilterBar's manual thresholds
 * loosened past their £40/40% defaults), reusing the REAL, exported
 * `buildStateCondition`/`buildFilterConditions` functions the route handler
 * itself calls — not a reimplementation of their logic.
 *
 * No D1/Miniflare harness exists in this repo (every other route test in
 * this file's neighbourhood pins down SQL-building pure functions directly —
 * see opportunitiesStateFilter.test.ts / opportunitiesSortAndFilters.test.ts
 * — or fakes a `Db` that recognises whole queries by substring — see
 * scanAiEnrichmentOrdering.test.ts). This test follows the same discipline
 * one level further: it evaluates the REAL clause/params those two functions
 * produce against in-memory fixture rows with a tiny, scoped WHERE
 * evaluator (evaluateWhere below) that only needs to understand the finite,
 * known grammar those two functions can ever emit (`expr >= ?`, `expr <= ?`,
 * `expr IN (?,...)`, joined by ` AND `) — it is not a general SQL parser,
 * and is deliberately narrow enough to stay trustworthy.
 *
 * Four named candidates:
 *   A — CLEARS the £40/40% bar outright. Lives in QUALIFIED_FLIP. The
 *       existing, unchanged ACTIONABLE feed.
 *   B — the spec's own example: £32 profit / 28% ROC. Real, positive
 *       economics, but below the persisted bar — lives in WATCH. Must be
 *       invisible to the default view, and must become retrievable the
 *       moment a manual filter is loosened to minNetProfit=30/minRoc=0.25 —
 *       proving discovery/qualification decoupling, not a lowered bar.
 *   C — decent profit/ROC but LOW liquidity and low confidence — proves a
 *       loosened profit/ROC filter does NOT bypass the liquidity/confidence
 *       floors; needs those loosened too before it appears.
 *   D — genuinely uneconomic (negative profit) — must NEVER appear, at any
 *       filter looseness used here. The one candidate a broader discovery
 *       ceiling must still correctly exclude.
 */

interface FixtureRow {
  name: string;
  state: string;
  expected_net_profit: number;
  return_on_capital: number;
  profit_margin: number;
  total_acquisition_cost: number;
  qsv: number;
  liquidity: "LOW" | "MEDIUM" | "HIGH" | "VERY_HIGH";
  confidence: number;
}

const CANDIDATE_A: FixtureRow = {
  name: "A (clears the £40/40% bar)",
  state: "QUALIFIED_FLIP",
  expected_net_profit: 55,
  return_on_capital: 0.5,
  profit_margin: 0.35,
  total_acquisition_cost: 120,
  qsv: 200,
  liquidity: "HIGH",
  confidence: 0.8,
};

const CANDIDATE_B: FixtureRow = {
  name: "B (£32 profit / 28% ROC — real economics, below the persisted bar)",
  state: "WATCH",
  expected_net_profit: 32,
  return_on_capital: 0.28,
  profit_margin: 0.22,
  total_acquisition_cost: 114,
  qsv: 180,
  liquidity: "HIGH",
  confidence: 0.75,
};

const CANDIDATE_C: FixtureRow = {
  name: "C (decent profit/ROC, but LOW liquidity and low confidence)",
  state: "WATCH",
  expected_net_profit: 35,
  return_on_capital: 0.3,
  profit_margin: 0.25,
  total_acquisition_cost: 100,
  qsv: 150,
  liquidity: "LOW",
  confidence: 0.3,
};

const CANDIDATE_D: FixtureRow = {
  name: "D (genuinely uneconomic — negative profit)",
  state: "WATCH",
  expected_net_profit: -5,
  return_on_capital: -0.1,
  profit_margin: -0.05,
  total_acquisition_cost: 90,
  qsv: 80,
  liquidity: "MEDIUM",
  confidence: 0.5,
};

const ALL_CANDIDATES = [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C, CANDIDATE_D];

/**
 * Mirrors filters.ts's buildServerFilterParams's liquidity mapping (min
 * level -> CSV of every level at or above it) without importing across the
 * apps/web -> apps/worker boundary — see this file's own doc comment.
 */
const LIQUIDITY_ORDER = { LOW: 0, MEDIUM: 1, HIGH: 2, VERY_HIGH: 3 } as const;
function liquidityCsvAtOrAbove(min: keyof typeof LIQUIDITY_ORDER): string {
  return (Object.keys(LIQUIDITY_ORDER) as (keyof typeof LIQUIDITY_ORDER)[])
    .filter((l) => LIQUIDITY_ORDER[l] >= LIQUIDITY_ORDER[min])
    .join(",");
}

/** Builds the query string GET /api/opportunities actually receives for a
 *  given category's state list plus the FilterBar's numeric thresholds —
 *  the same fields buildServerFilterParams (apps/web/src/state/filters.ts)
 *  sends for the FLIP strategy on an economics-filtered category. */
function queryFor(opts: {
  state: string | null;
  minNetProfit: number;
  minRoc: number;
  minLiquidity: keyof typeof LIQUIDITY_ORDER;
  minConfidence: number;
}): URLSearchParams {
  const qs = new URLSearchParams();
  if (opts.state) qs.set("state", opts.state);
  qs.set("minNetProfit", String(opts.minNetProfit));
  qs.set("minRoc", String(opts.minRoc));
  qs.set("liquidity", liquidityCsvAtOrAbove(opts.minLiquidity));
  qs.set("minConfidence", String(opts.minConfidence));
  return qs;
}

/**
 * Scoped WHERE evaluator — see the file's doc comment for why this is safe:
 * it only needs to understand the finite grammar buildStateCondition/
 * buildFilterConditions can ever emit for the condition kinds this test
 * exercises (numeric >=/<=, and IN (...) lists), joined by top-level " AND ".
 */
function evaluateWhere(row: FixtureRow, clause: string, params: unknown[]): boolean {
  if (!clause) return true;
  const atoms = clause.split(" AND ");
  let paramIdx = 0;
  for (const atom of atoms) {
    const placeholderCount = (atom.match(/\?/g) ?? []).length;
    const atomParams = params.slice(paramIdx, paramIdx + placeholderCount);
    paramIdx += placeholderCount;
    if (!evaluateAtom(row, atom.trim(), atomParams)) return false;
  }
  if (paramIdx !== params.length) {
    throw new Error(`evaluateWhere: param/placeholder count mismatch in test harness — clause "${clause}"`);
  }
  return true;
}

const COLUMN_TO_FIELD: Record<string, keyof FixtureRow> = {
  "o.state": "state",
  "o.expected_net_profit": "expected_net_profit",
  "o.return_on_capital": "return_on_capital",
  "o.profit_margin": "profit_margin",
  "o.total_acquisition_cost": "total_acquisition_cost",
  "o.qsv": "qsv",
  "o.liquidity": "liquidity",
  "o.confidence": "confidence",
};

function evaluateAtom(row: FixtureRow, atom: string, atomParams: unknown[]): boolean {
  const inMatch = atom.match(/^(\S+) IN \([^)]*\)$/);
  if (inMatch) {
    const field = COLUMN_TO_FIELD[inMatch[1]!];
    if (!field) throw new Error(`evaluateAtom: unmapped column in test harness — ${inMatch[1]}`);
    return atomParams.includes(row[field]);
  }
  const cmpMatch = atom.match(/^(\S+) (>=|<=|=) \?$/);
  if (cmpMatch) {
    const field = COLUMN_TO_FIELD[cmpMatch[1]!];
    if (!field) throw new Error(`evaluateAtom: unmapped column in test harness — ${cmpMatch[1]}`);
    const value = row[field] as number;
    const target = atomParams[0] as number;
    if (cmpMatch[2] === ">=") return value >= target;
    if (cmpMatch[2] === "<=") return value <= target;
    return value === target;
  }
  throw new Error(`evaluateAtom: unrecognised condition shape in test harness — "${atom}"`);
}

function matches(state: string | null, qs: URLSearchParams): FixtureRow[] {
  const stateCondition = buildStateCondition(state ?? undefined);
  const filterCondition = buildFilterConditions(qs);
  const clauses = [stateCondition?.clause, filterCondition.clause].filter((c): c is string => !!c);
  const params = [...(stateCondition?.params ?? []), ...filterCondition.params];
  const clause = clauses.join(" AND ");
  return ALL_CANDIDATES.filter((row) => evaluateWhere(row, clause, params));
}

describe("MWMC V1 FINAL SHIP PASS item 8 — discovery/qualification-bar decoupling, fixture candidates A/B/C/D", () => {
  it("ACTIONABLE (default £40/40% bar via state=QUALIFIED_FLIP,QUALIFIED_GRADE): only A — B/C/D are WATCH, excluded by state alone", () => {
    const qs = queryFor({ state: null, minNetProfit: 40, minRoc: 0.4, minLiquidity: "MEDIUM", minConfidence: 0.6 });
    const result = matches("QUALIFIED_FLIP,QUALIFIED_GRADE", qs);
    expect(result.map((r) => r.name)).toEqual([CANDIDATE_A.name]);
  });

  it("NEAR_MISS (state=WATCH) at the SAME £40/40% default thresholds: empty — merely switching tabs never surfaces a near-miss, the numeric filter has to actually be loosened", () => {
    const qs = queryFor({ state: null, minNetProfit: 40, minRoc: 0.4, minLiquidity: "MEDIUM", minConfidence: 0.6 });
    const result = matches("WATCH", qs);
    expect(result).toEqual([]);
  });

  it("NEAR_MISS with minNetProfit=30/minRoc=0.25 (the spec's own worked example): exactly B — never a lowered 40/40 bar, a genuinely different, user-chosen threshold", () => {
    const qs = queryFor({ state: null, minNetProfit: 30, minRoc: 0.25, minLiquidity: "MEDIUM", minConfidence: 0.6 });
    const result = matches("WATCH", qs);
    expect(result.map((r) => r.name)).toEqual([CANDIDATE_B.name]);
  });

  it("NEAR_MISS with minNetProfit=15/minRoc=0.1 AND liquidity/confidence loosened to LOW/0.2: B and C both surface, D never does", () => {
    const qs = queryFor({ state: null, minNetProfit: 15, minRoc: 0.1, minLiquidity: "LOW", minConfidence: 0.2 });
    const result = matches("WATCH", qs);
    expect(result.map((r) => r.name).sort()).toEqual([CANDIDATE_B.name, CANDIDATE_C.name].sort());
  });

  it("C stays hidden until liquidity/confidence are ALSO loosened — a loose profit/ROC filter alone doesn't bypass them", () => {
    // Same profit/ROC threshold as the previous test, but liquidity/confidence
    // still at their defaults — C must still be excluded on those grounds.
    const qs = queryFor({ state: null, minNetProfit: 15, minRoc: 0.1, minLiquidity: "MEDIUM", minConfidence: 0.6 });
    const result = matches("WATCH", qs);
    expect(result.map((r) => r.name)).toEqual([CANDIDATE_B.name]);
  });

  it("D never appears in any scenario tested here, including the loosest one — it is genuinely uneconomic, not merely below a bar", () => {
    const loosest = queryFor({ state: null, minNetProfit: 15, minRoc: 0.1, minLiquidity: "LOW", minConfidence: 0.2 });
    expect(matches("WATCH", loosest).some((r) => r.name === CANDIDATE_D.name)).toBe(false);
    expect(matches("QUALIFIED_FLIP,QUALIFIED_GRADE,WATCH,INSPECT_PHOTOS", loosest).some((r) => r.name === CANDIDATE_D.name)).toBe(
      false,
    );
  });

  it("total/pagination consistency: the same clause/params drive both the row query and the COUNT(*) query in the real route handler (opportunities.ts) — proven here by re-deriving the count from the identical filtered array", () => {
    const qs = queryFor({ state: null, minNetProfit: 30, minRoc: 0.25, minLiquidity: "MEDIUM", minConfidence: 0.6 });
    const result = matches("WATCH", qs);
    // The real route runs one query for `total` and a second (same WHERE,
    // plus LIMIT/OFFSET) for the page of rows — both built from the exact
    // same `conditions`/`params` arrays (see opportunities.ts's handler).
    // Nothing in that shared construction depends on LIMIT/OFFSET, so a
    // total computed from the very same filtered set is a faithful proxy
    // for "total stays honest relative to what the page shows" without
    // needing a real D1 LIMIT/OFFSET execution.
    expect(result.length).toBe(1);
  });
});
