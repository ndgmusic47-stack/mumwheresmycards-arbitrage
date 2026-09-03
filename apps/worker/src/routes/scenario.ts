import { Hono } from "hono";
import { Db, type OpportunityRow, type CardRow, type MarketSnapshotRow } from "@mwmc/db";
import {
  runFlipScenario,
  runGradeScenario,
  computeGradedBasis,
  round2,
  PSA_GRADES,
  type PsaGrade,
  type FlipScenarioResult,
  type GradeScenarioResult,
  type SellingCostSettings,
  type ExitMarketFeeModel,
  type GradingBatchSettings,
  type GradingConsumables,
  type GradingService,
} from "@mwmc/core";
import {
  createAiModelProvider,
  AiCompletionCache,
  GuardedAiModelProvider,
  AiScenarioNarratorProvider,
  type ScenarioNarrationResponse,
} from "@mwmc/providers";
import { loadSettings, usdPerGbpFrom } from "../repo/settingsRepo.js";
import type { Env } from "../env.js";

export const scenarioRoute = new Hono<{ Bindings: Env }>();

/**
 * AI INTELLIGENCE spec Phase 2, Workstream M: `POST
 * /arbitrage/api/opportunities/:id/scenario` — "what if?" for a real
 * opportunity. Loads the opportunity (plus its linked market snapshot and
 * live Settings), reconstructs its real baseline inputs, applies the
 * caller's overrides, and recomputes via `runFlipScenario`/
 * `runGradeScenario` (packages/core/src/calc/scenarioEngine.ts) — the SAME
 * calculators the real opportunity engine uses, never a second
 * implementation. `narrate: true` additionally asks an AI narrator to
 * describe the already-computed delta in plain English (DEEP tier, same
 * provider-chain composition as Workstream J's `/advisory` route — see
 * `buildScenarioNarrator` below) — off by default, since it costs real
 * money and a caller iterating through several hypotheticals shouldn't pay
 * for narration on every one.
 *
 * WHY A SINGLE ROUTE FOR BOTH STRATEGIES: an opportunity's `strategy` is
 * fixed by the row itself (never chosen by the caller here), so there's
 * nothing to disambiguate — the response shape is simply conditional on
 * `opportunity.strategy`, same as `buildAdvisoryEconomicsFacts` in
 * opportunities.ts.
 */

interface ScenarioRequestBody {
  totalAcquisitionCost?: unknown;
  qsv?: unknown;
  totalGradedBasis?: unknown;
  /** Grade (6-10, as either a number or numeric-string JSON key — JSON
   *  object keys are always strings on the wire) -> gross slab value in
   *  GBP, or `null` to model "no market data for this grade". Any other
   *  key, or a non-number/non-null value, is silently dropped by
   *  `sanitizeSlabValueOverrides` below — never trusted or coerced. */
  slabValues?: unknown;
  narrate?: unknown;
  /**
   * AI INTELLIGENCE gap 4 (financial engineering — business-cost scenario
   * overrides): "what if packaging/postage/fees/grading costs were
   * different" WITHOUT mutating production Settings. Every sub-field is
   * optional and independently sanitised (see sanitizeBusinessCostOverrides
   * below) — an absent or invalid sub-field simply falls back to the live
   * Settings value, same "never trust a request body's shape" discipline
   * as slabValues/sanitizeSlabValueOverrides.
   */
  businessCosts?: unknown;
}

/**
 * Re-validated, partial overrides onto the four commercial cost settings a
 * FLIP or GRADE scenario can be run against. Every numeric field is
 * independently bounds-checked; anything missing, malformed, or
 * out-of-range is simply left out (falls back to the live settings value),
 * never coerced or defaulted to something invented — same trust boundary
 * as `sanitizeSlabValueOverrides`.
 */
export interface BusinessCostOverrides {
  sellingCosts: Partial<SellingCostSettings>;
  feeModel: Partial<ExitMarketFeeModel>;
  gradingBatch: Partial<GradingBatchSettings>;
  gradingConsumables: Partial<GradingConsumables>;
}

function pickNonNegativeNumbers<K extends string>(source: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const value = source[key];
    if (isNonNegativeFiniteNumber(value)) result[key] = value;
  }
  return result;
}

/** Fraction fields (percentages stored as 0..1) get an extra <= 1 bound — a caller sending "20" for 20% (i.e. forgetting to divide by 100) is dropped, not silently misapplied as a 2000% fee. */
function pickFractions<K extends string>(source: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, number>> {
  const result: Partial<Record<K, number>> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) result[key] = value;
  }
  return result;
}

export function sanitizeBusinessCostOverrides(raw: unknown): BusinessCostOverrides {
  const empty: BusinessCostOverrides = { sellingCosts: {}, feeModel: {}, gradingBatch: {}, gradingConsumables: {} };
  if (!raw || typeof raw !== "object") return empty;
  const source = raw as Record<string, unknown>;

  const sellingCostsSource = (source.sellingCosts && typeof source.sellingCosts === "object" ? source.sellingCosts : {}) as Record<string, unknown>;
  const sellingCosts = pickNonNegativeNumbers(sellingCostsSource, [
    "outboundPostage",
    "outboundPostageGraded",
    "packaging",
    "saleInsurance",
    "saleInsuranceGraded",
  ] as const);

  const feeModelSource = (source.feeModel && typeof source.feeModel === "object" ? source.feeModel : {}) as Record<string, unknown>;
  const feeModel: Partial<ExitMarketFeeModel> = {
    ...pickFractions(feeModelSource, [
      "finalValueFeePct",
      "regulatoryOperatingFeePct",
      "promotedListingsPct",
      "internationalFeePct",
      "feeVatRate",
    ] as const),
    ...pickNonNegativeNumbers(feeModelSource, ["perOrderFee", "perOrderFeeThreshold", "perOrderFeeBelowThreshold"] as const),
    ...(typeof feeModelSource.sellerFeeVatRecoverable === "boolean"
      ? { sellerFeeVatRecoverable: feeModelSource.sellerFeeVatRecoverable }
      : {}),
  };

  const gradingBatchSource = (source.gradingBatch && typeof source.gradingBatch === "object" ? source.gradingBatch : {}) as Record<string, unknown>;
  const gradingBatch: Partial<GradingBatchSettings> = {
    ...pickNonNegativeNumbers(gradingBatchSource, ["batchOutboundPostage", "batchReturnPostage", "batchInsurance"] as const),
    ...(typeof gradingBatchSource.batchSize === "number" && Number.isInteger(gradingBatchSource.batchSize) && gradingBatchSource.batchSize >= 1
      ? { batchSize: gradingBatchSource.batchSize }
      : {}),
  };

  const gradingConsumablesSource = (source.gradingConsumables && typeof source.gradingConsumables === "object" ? source.gradingConsumables : {}) as Record<string, unknown>;
  const gradingConsumables = pickNonNegativeNumbers(gradingConsumablesSource, ["sleeveCost", "cardSaverCost"] as const);

  return { sellingCosts, feeModel, gradingBatch, gradingConsumables };
}

function hasAnyOverride(overrides: Record<string, unknown>): boolean {
  return Object.keys(overrides).length > 0;
}

/** Plain-English fragments describing a businessCosts override, for narration's `changesDescription` — never fed a raw object, so the model is never handed unlabelled numbers to guess the meaning of. */
function businessCostsSummary(overrides: BusinessCostOverrides): string[] {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(overrides.sellingCosts)) parts.push(`selling cost ${key} -> £${(value as number).toFixed(2)}`);
  for (const [key, value] of Object.entries(overrides.feeModel)) parts.push(`fee ${key} -> ${value}`);
  for (const [key, value] of Object.entries(overrides.gradingBatch)) parts.push(`grading batch ${key} -> ${value}`);
  for (const [key, value] of Object.entries(overrides.gradingConsumables)) parts.push(`grading consumable ${key} -> £${(value as number).toFixed(2)}`);
  return parts;
}

/**
 * A stand-in GradingService used ONLY to isolate the batch/consumables
 * PORTION of computeGradedBasis's total — every other field it takes
 * (rawPurchasePrice, sellerPostage, importTax, acquisitionFees,
 * service.feePerCard, upchargeReserve) is held at an identical constant
 * across the "before" and "after" calls in gradingCostOverrideDelta below,
 * so it cancels out of the subtraction regardless of its actual value.
 * This deliberately avoids needing to reload the opportunity's real listing
 * (raw price/postage) just to recompute a basis this route never actually
 * needs the absolute value of — only the delta a batch/consumables change
 * would cause.
 */
const ZERO_FEE_SERVICE: GradingService = {
  id: "scenario-delta-only",
  graderId: "scenario-delta-only",
  name: "scenario-delta-only",
  feePerCard: 0,
  estimatedTurnaroundBusinessDays: 0,
  declaredValueCapUsd: null,
  enabled: true,
};

/**
 * How much a grading-batch/consumables override would move the total
 * graded basis, in isolation — see ZERO_FEE_SERVICE's doc comment for why
 * this is a pure delta rather than a full basis recomputation. Returns 0
 * when neither sub-field was overridden (no-op, applied to any
 * totalGradedBasis unchanged).
 */
export function gradingCostOverrideDelta(
  overrides: BusinessCostOverrides,
  baselineBatch: GradingBatchSettings,
  baselineConsumables: GradingConsumables,
): number {
  if (!hasAnyOverride(overrides.gradingBatch) && !hasAnyOverride(overrides.gradingConsumables)) return 0;

  const scenarioBatch: GradingBatchSettings = { ...baselineBatch, ...overrides.gradingBatch };
  const scenarioConsumables: GradingConsumables = { ...baselineConsumables, ...overrides.gradingConsumables };

  const before = computeGradedBasis({
    rawPurchasePrice: 0,
    sellerPostage: 0,
    service: ZERO_FEE_SERVICE,
    batch: baselineBatch,
    consumables: baselineConsumables,
  }).total;
  const after = computeGradedBasis({
    rawPurchasePrice: 0,
    sellerPostage: 0,
    service: ZERO_FEE_SERVICE,
    batch: scenarioBatch,
    consumables: scenarioConsumables,
  }).total;

  return round2(after - before);
}

/**
 * Re-validates a caller-supplied `slabValues` body field against the exact
 * bounds a human-operated UI control would be held to — same "re-validate,
 * never trust a request body's shape" trust boundary as
 * `sanitizeInterpretedFilters` (Workstream L). A grade that is missing,
 * malformed, or negative is simply left out of the result (falls back to
 * the opportunity's real baseline value in `runGradeScenario`'s override
 * merge), never coerced or defaulted to something invented.
 */
export function sanitizeSlabValueOverrides(raw: unknown): Partial<Record<PsaGrade, number | null>> {
  const result: Partial<Record<PsaGrade, number | null>> = {};
  if (!raw || typeof raw !== "object") return result;
  const source = raw as Record<string, unknown>;
  for (const grade of PSA_GRADES) {
    const value = source[String(grade)];
    if (value === null) {
      result[grade] = null;
    } else if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      result[grade] = value;
    }
  }
  return result;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Same provider-chain composition as `buildAdvisoryProvider` in
 * opportunities.ts (Workstream J) and the query-interpret route
 * (Workstream L) — createAiModelProvider (F) -> AiCompletionCache (G) ->
 * GuardedAiModelProvider (I) -> AiScenarioNarratorProvider (M itself).
 * Built fresh PER REQUEST, never at module scope, since it depends on
 * `c.env` and live Settings.
 */
function buildScenarioNarrator(env: Env, db: Db, settings: Awaited<ReturnType<typeof loadSettings>>) {
  const modelProvider = createAiModelProvider(env);
  const cached = new AiCompletionCache(db, modelProvider, {
    dailySpendCapUsd: settings.ai.dailySpendCapUsd,
    pricing: settings.ai.pricingUsdPerMTok,
    scanRunId: null,
  });
  const guarded = new GuardedAiModelProvider(cached);
  return new AiScenarioNarratorProvider(guarded);
}

const CURRENCY_FMT = (n: number) => `£${n.toFixed(2)}`;

scenarioRoute.post("/:id/scenario", async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param("id");

  const opportunity = await db.queryFirst<OpportunityRow>(`SELECT * FROM opportunities WHERE id = ?`, id);
  if (!opportunity) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<ScenarioRequestBody>().catch(() => ({}) as ScenarioRequestBody);
  const narrate = body.narrate === true;
  const businessCostOverrides = sanitizeBusinessCostOverrides(body.businessCosts);
  const hasBusinessCostOverrides =
    hasAnyOverride(businessCostOverrides.sellingCosts) ||
    hasAnyOverride(businessCostOverrides.feeModel) ||
    hasAnyOverride(businessCostOverrides.gradingBatch) ||
    hasAnyOverride(businessCostOverrides.gradingConsumables);

  const [card, marketSnapshot, settings] = await Promise.all([
    db.queryFirst<CardRow>(`SELECT * FROM cards WHERE id = ?`, opportunity.card_id),
    opportunity.market_snapshot_id !== null
      ? db.queryFirst<MarketSnapshotRow>(`SELECT * FROM market_snapshots WHERE id = ?`, opportunity.market_snapshot_id)
      : Promise.resolve(null),
    loadSettings(db),
  ]);

  const cardName = card?.name ?? "Unknown card";
  const strategy = opportunity.strategy as "FLIP" | "GRADE";

  if (strategy === "FLIP") {
    if (opportunity.qsv === null) {
      return c.json({ error: "This opportunity has no QSV recorded — a FLIP scenario needs a baseline reference sale price." }, 400);
    }

    const overrides: { totalAcquisitionCost?: number; qsv?: number } = {};
    if (isNonNegativeFiniteNumber(body.totalAcquisitionCost)) overrides.totalAcquisitionCost = body.totalAcquisitionCost;
    if (isNonNegativeFiniteNumber(body.qsv)) overrides.qsv = body.qsv;

    if (Object.keys(overrides).length === 0 && !hasBusinessCostOverrides) {
      return c.json(
        { error: "Provide at least one valid override: totalAcquisitionCost, qsv (non-negative numbers), and/or businessCosts." },
        400,
      );
    }

    // AI INTELLIGENCE gap 4: a businessCosts override applies ONLY to the
    // scenario side (runFlipScenario's scenarioFeeModel/scenarioSellingCosts
    // params) — the baseline always stays on the live production settings,
    // never mutated, so "what if postage cost more" never quietly moves the
    // thing it's being compared against.
    const scenarioFeeModel = hasAnyOverride(businessCostOverrides.feeModel)
      ? { ...settings.feeModel, ...businessCostOverrides.feeModel }
      : undefined;
    const scenarioSellingCosts = hasAnyOverride(businessCostOverrides.sellingCosts)
      ? { ...settings.sellingCosts, ...businessCostOverrides.sellingCosts }
      : undefined;

    const scenario: FlipScenarioResult = runFlipScenario(
      { totalAcquisitionCost: opportunity.total_acquisition_cost, qsv: opportunity.qsv },
      overrides,
      settings.feeModel,
      settings.sellingCosts,
      scenarioFeeModel,
      scenarioSellingCosts,
    );

    const { narration, providerName } = await maybeNarrateFlip(c.env, db, settings, narrate, {
      cardName,
      opportunity,
      overrides,
      scenario,
      businessCostOverrides,
    });

    return c.json({ strategy: "FLIP", scenario, narration, providerName });
  }

  // GRADE
  if (opportunity.total_graded_basis === null) {
    return c.json({ error: "This opportunity has no graded basis recorded — a GRADE scenario needs a baseline." }, 400);
  }

  const baselineSlabValues: Partial<Record<PsaGrade, number | null>> = {};
  for (const grade of PSA_GRADES) {
    const raw = marketSnapshot ? (marketSnapshot as unknown as Record<string, number | null>)[`psa${grade}`] : null;
    baselineSlabValues[grade] = typeof raw === "number" ? raw : null;
  }

  const overrides: { totalGradedBasis?: number; slabValues?: Partial<Record<PsaGrade, number | null>> } = {};
  if (isNonNegativeFiniteNumber(body.totalGradedBasis)) overrides.totalGradedBasis = body.totalGradedBasis;
  const slabOverrides = sanitizeSlabValueOverrides(body.slabValues);
  if (Object.keys(slabOverrides).length > 0) overrides.slabValues = slabOverrides;

  // AI INTELLIGENCE gap 4: a gradingBatch/gradingConsumables override moves
  // the graded basis itself (batch logistics + per-card consumables — see
  // gradingCostOverrideDelta's doc comment for why this is a pure delta
  // rather than a full basis recomputation, which would need the real
  // listing's raw purchase price/postage this route never otherwise
  // loads). Applied ON TOP of whichever totalGradedBasis is already in
  // play (an explicit override, or the opportunity's real baseline) —
  // composing with, not replacing, that override.
  const gradingCostDelta = gradingCostOverrideDelta(businessCostOverrides, settings.gradingBatch, settings.gradingConsumables);
  if (gradingCostDelta !== 0) {
    overrides.totalGradedBasis = round2((overrides.totalGradedBasis ?? opportunity.total_graded_basis) + gradingCostDelta);
  }

  if (overrides.totalGradedBasis === undefined && overrides.slabValues === undefined && !hasAnyOverride(businessCostOverrides.feeModel) && !hasAnyOverride(businessCostOverrides.sellingCosts)) {
    return c.json(
      {
        error:
          "Provide at least one valid override: totalGradedBasis, slabValues (grade 6-10 -> non-negative number or null), and/or businessCosts.",
      },
      400,
    );
  }

  const gradingService = settings.gradingServices.find((s) => s.id === opportunity.grading_service_id);

  // Same baseline-untouched discipline as the FLIP branch above.
  const scenarioFeeModel = hasAnyOverride(businessCostOverrides.feeModel)
    ? { ...settings.feeModel, ...businessCostOverrides.feeModel }
    : undefined;
  const scenarioSellingCosts = hasAnyOverride(businessCostOverrides.sellingCosts)
    ? { ...settings.sellingCosts, ...businessCostOverrides.sellingCosts }
    : undefined;

  const scenario: GradeScenarioResult = runGradeScenario(
    { totalGradedBasis: opportunity.total_graded_basis, slabValues: baselineSlabValues },
    overrides,
    gradingService,
    settings.feeModel,
    settings.sellingCosts,
    usdPerGbpFrom(settings.fxRates) ?? undefined,
    scenarioFeeModel,
    scenarioSellingCosts,
  );

  const { narration, providerName } = await maybeNarrateGrade(c.env, db, settings, narrate, {
    cardName,
    opportunity,
    overrides,
    scenario,
    businessCostOverrides,
  });

  return c.json({ strategy: "GRADE", scenario, narration, providerName });
});

async function maybeNarrateFlip(
  env: Env,
  db: Db,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  narrate: boolean,
  args: {
    cardName: string;
    opportunity: OpportunityRow;
    overrides: { totalAcquisitionCost?: number; qsv?: number };
    scenario: FlipScenarioResult;
    businessCostOverrides: BusinessCostOverrides;
  },
): Promise<{ narration: ScenarioNarrationResponse | null; providerName: string | null }> {
  if (!narrate) return { narration: null, providerName: null };

  const parts: string[] = [];
  if (args.overrides.totalAcquisitionCost !== undefined) {
    parts.push(
      `total acquisition cost: ${CURRENCY_FMT(args.opportunity.total_acquisition_cost)} -> ${CURRENCY_FMT(args.overrides.totalAcquisitionCost)}`,
    );
  }
  if (args.overrides.qsv !== undefined) {
    parts.push(`QSV: ${CURRENCY_FMT(args.opportunity.qsv!)} -> ${CURRENCY_FMT(args.overrides.qsv)}`);
  }
  parts.push(...businessCostsSummary(args.businessCostOverrides));

  const narrator = buildScenarioNarrator(env, db, settings);
  const narration = await narrator.narrateScenario({
    cardName: args.cardName,
    strategy: "FLIP",
    changesDescription: parts.join("; "),
    keyMetricLabel: "net profit",
    keyMetricBaseline: args.scenario.baseline.netProfit,
    keyMetricScenario: args.scenario.scenario.netProfit,
    economicsFacts: {
      baselineReturnOnCapital: args.scenario.baseline.returnOnCapital,
      scenarioReturnOnCapital: args.scenario.scenario.returnOnCapital,
      baselineProfitMargin: args.scenario.baseline.profitMargin,
      scenarioProfitMargin: args.scenario.scenario.profitMargin,
    },
  });
  return { narration, providerName: narrator.name };
}

async function maybeNarrateGrade(
  env: Env,
  db: Db,
  settings: Awaited<ReturnType<typeof loadSettings>>,
  narrate: boolean,
  args: {
    cardName: string;
    opportunity: OpportunityRow;
    overrides: { totalGradedBasis?: number; slabValues?: Partial<Record<PsaGrade, number | null>> };
    scenario: GradeScenarioResult;
    businessCostOverrides: BusinessCostOverrides;
  },
): Promise<{ narration: ScenarioNarrationResponse | null; providerName: string | null }> {
  if (!narrate) return { narration: null, providerName: null };

  // The headline metric for a GRADE scenario is PSA10 profit — but if
  // either side has no market data at PSA10, there's no honest number to
  // narrate against, so narration is skipped entirely rather than sending
  // the model a fabricated 0.
  const baselinePsa10 = args.scenario.baseline.rungs.find((r) => r.grade === 10)?.profit ?? null;
  const scenarioPsa10 = args.scenario.scenario.rungs.find((r) => r.grade === 10)?.profit ?? null;
  if (baselinePsa10 === null || scenarioPsa10 === null) {
    return {
      narration: {
        available: false,
        summary: null,
        caveats: ["No PSA10 market data on one side of this scenario — narration needs a genuine headline figure to compare, not a fabricated one."],
      },
      providerName: null,
    };
  }

  const parts: string[] = [];
  if (args.overrides.totalGradedBasis !== undefined) {
    parts.push(`total graded basis: ${CURRENCY_FMT(args.opportunity.total_graded_basis!)} -> ${CURRENCY_FMT(args.overrides.totalGradedBasis)}`);
  }
  if (args.overrides.slabValues) {
    for (const [gradeKey, value] of Object.entries(args.overrides.slabValues)) {
      parts.push(`PSA${gradeKey} slab value -> ${value === null ? "no market data" : CURRENCY_FMT(value)}`);
    }
  }
  parts.push(...businessCostsSummary(args.businessCostOverrides));

  const baselinePsa9 = args.scenario.baseline.rungs.find((r) => r.grade === 9)?.profit ?? null;
  const scenarioPsa9 = args.scenario.scenario.rungs.find((r) => r.grade === 9)?.profit ?? null;
  const economicsFacts: Record<string, number> = {};
  if (baselinePsa9 !== null) economicsFacts.baselinePsa9Profit = baselinePsa9;
  if (scenarioPsa9 !== null) economicsFacts.scenarioPsa9Profit = scenarioPsa9;

  const narrator = buildScenarioNarrator(env, db, settings);
  const narration = await narrator.narrateScenario({
    cardName: args.cardName,
    strategy: "GRADE",
    changesDescription: parts.join("; ") || "(no valid override applied)",
    keyMetricLabel: "PSA10 profit",
    keyMetricBaseline: baselinePsa10,
    keyMetricScenario: scenarioPsa10,
    economicsFacts,
  });
  return { narration, providerName: narrator.name };
}
