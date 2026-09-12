import { Hono } from "hono";
import { Db, type OpportunityRow } from "@mwmc/db";
import {
  calculateDeal,
  DealInputError,
  MoneyInputError,
  rateFor,
  graderScale,
  GRADER_SCALES,
  resolveGradedPrices,
  gradersWithPrices,
  type DealInputs,
  type FxSnapshot,
} from "@mwmc/core";
import { loadSettings } from "../repo/settingsRepo.js";
import {
  getDealByOpportunity,
  getDealById,
  saveDeal,
  listOffers,
  placeOffer,
  resolveOffer,
  getOffer,
  pendingOfferExposure,
  actualAcquisitionSpend,
  plannedGradingCost,
  inventoryForDeal,
  recordPurchaseFromDeal,
  dealsUnderOffer,
  OFFER_STATUSES,
  type OfferStatus,
} from "../repo/dealsRepo.js";
import type { Env } from "../env.js";

/**
 * THE PER-CARD TRADING DESK API.
 *
 * Every route here writes only records the caller can name, and every write
 * validates its body before touching the database. Two rules run through all
 * of them:
 *
 *  - A CALCULATION IS NEVER TRUSTED FROM THE CLIENT. The browser sends
 *    INPUTS; the worker recomputes. A profit figure that arrived over the
 *    wire is a claim, not a result, and storing one would make the numbers
 *    unfalsifiable.
 *
 *  - THE FX SNAPSHOT IS SERVER-SIDE. A deal is priced against the live
 *    settings rate table at save time and that snapshot is stored WITH it.
 *    The client cannot supply rates, so it cannot price a deal at a rate
 *    that never existed.
 */
export const dealsRoute = new Hono<{ Bindings: Env }>();

function currentFxSnapshot(settings: Awaited<ReturnType<typeof loadSettings>>): FxSnapshot {
  return {
    rates: settings.fxRates,
    source: settings.fxRatesMeta?.source ?? "FALLBACK",
    capturedAt: settings.fxRatesMeta?.lastFetchedAt ?? new Date().toISOString(),
    // Carried INTO the snapshot, so a saved deal reproduces the same pennies
    // even if the operator changes their spread afterwards — the same reason
    // the rates themselves are frozen per deal.
    conversionSpreadPct: settings.fxConversionSpreadPct,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the shape the client sent well enough to hand to the calculator.
 * The calculator itself does the per-field money validation (negatives,
 * non-finite, unknown currency, contradictory provenance) and throws
 * MoneyInputError/DealInputError, which this route turns into a 400 with the
 * real message rather than a generic failure — the operator needs to know
 * WHICH field they got wrong.
 */
type DealInputsWithoutFx = Omit<DealInputs, "fx">;

function parseDealInputs(body: unknown): { inputs: DealInputsWithoutFx; error?: undefined } | { inputs?: undefined; error: string } {
  if (!isPlainObject(body)) return { error: "Body must be an object." };
  const strategy = body.strategy;
  if (strategy !== "FLIP" && strategy !== "GRADE") return { error: 'strategy must be "FLIP" or "GRADE".' };
  if (!isPlainObject(body.acquisition)) return { error: "acquisition is required." };
  if (!isPlainObject(body.sale)) return { error: "sale is required (it may be an empty object)." };
  if (!Array.isArray(body.resale) || body.resale.length === 0) {
    return { error: "resale must be a non-empty array of scenarios." };
  }
  if (strategy === "GRADE") {
    if (!isPlainObject(body.grading)) return { error: "grading is required for a GRADE deal." };
    const graderId = (body.grading as Record<string, unknown>).graderId;
    if (typeof graderId !== "string" || !graderScale(graderId)) {
      return {
        error: `graderId must be one with a published grade scale on file (${Object.keys(GRADER_SCALES).join(", ")}). A grader without one cannot have its outcomes priced without inventing them.`,
      };
    }
  }
  return { inputs: body as unknown as DealInputsWithoutFx };
}

/**
 * The provider's own graded prices for this card, as a reference the
 * operator can accept or overrule.
 *
 * WHY THIS IS A REFERENCE AND NOT A VALUE. These are PokeTrace figures,
 * which are US-market and already converted once into GBP. The deal desk
 * treats them as PROVENANCE "PROVIDER" precisely so they never masquerade as
 * the operator's own researched UK comps — the distinction the whole money
 * model is built on. They are offered as a starting point; nothing prefills
 * itself into a saved deal without the operator saving it.
 *
 * Returns null when the card has no snapshot, rather than an empty map, so
 * the UI can say "no market reference" instead of "every grade is worth
 * nothing".
 */
async function gradedPriceReference(
  db: Db,
  cardId: string,
  graderId: string,
): Promise<{
  graderId: string;
  priced: { gradeKey: string; gradeLabel: string; gbp: number; tierKey: string }[];
  unmappedTierKeys: string[];
  gradersAvailable: string[];
  capturedAt: string | null;
} | null> {
  const row = await db.queryFirst<{ graded_prices_json: string | null; price_timestamp: string | null }>(
    `SELECT graded_prices_json, price_timestamp
       FROM market_snapshots
      WHERE card_id = ? AND graded_prices_json IS NOT NULL
      ORDER BY price_timestamp DESC
      LIMIT 1`,
    cardId,
  );
  if (!row?.graded_prices_json) return null;

  let prices: Record<string, number>;
  try {
    const parsed: unknown = JSON.parse(row.graded_prices_json);
    if (!isPlainObject(parsed)) return null;
    prices = parsed as Record<string, number>;
  } catch {
    return null;
  }

  const { priced, unmappableTiers } = resolveGradedPrices(prices, graderId);
  return {
    graderId,
    priced,
    // Reported, not hidden: a tier the provider priced that no verified scale
    // can place. Mostly PSA half grades, plus the ambiguous tens.
    unmappedTierKeys: unmappableTiers.map((t) => t.tierKey),
    gradersAvailable: gradersWithPrices(prices),
    capturedAt: row.price_timestamp,
  };
}

/**
 * The reference lookup above, made unable to take the deal desk down with it.
 *
 * FOUND LIVE, 2026-09-12: the whole page returned `500 Internal Server Error`
 * and the operator's assumptions, offers and calculation were all unreachable
 * — because of an OPTIONAL price reference. The query above reads
 * `market_snapshots.graded_prices_json`, a column added by migration 0026. A
 * worker deployed ahead of its migrations hits "no such column", the
 * exception escapes the handler, and the response carries no clue as to
 * which of a dozen queries failed.
 *
 * THIS IS NOT THE ERROR BEING SWALLOWED. The message is returned verbatim in
 * `gradedPriceReferenceError` and shown on screen, so an unapplied migration
 * announces itself by name instead of hiding behind a blank 500. What
 * changes is only the blast radius: a missing REFERENCE degrades the price
 * suggestions, and must not delete the desk.
 *
 * The precedent is `calculationError` a few lines below — a stored deal that
 * no longer calculates still has to be readable so the operator can fix it.
 * Same rule, applied one layer out.
 */
async function safeGradedPriceReference(
  db: Db,
  cardId: string,
  graderId: string,
): Promise<{ reference: Awaited<ReturnType<typeof gradedPriceReference>>; error: string | null }> {
  try {
    return { reference: await gradedPriceReference(db, cardId, graderId), error: null };
  } catch (err) {
    return {
      reference: null,
      error:
        `Graded price reference unavailable: ${err instanceof Error ? err.message : String(err)}. ` +
        `Nothing else on this deal is affected — no price suggestions are being shown. ` +
        `If this mentions a missing column or table, the database is behind the deployed worker: ` +
        `run "pnpm --filter @mwmc/worker run migrate:remote".`,
    };
  }
}

/** GET the saved deal for an opportunity, plus its offers and a fresh calculation. */
dealsRoute.get("/opportunity/:opportunityId", async (c) => {
  const db = new Db(c.env.DB);
  const opportunityId = c.req.param("opportunityId");

  const opportunity = await db.queryFirst<OpportunityRow>(`SELECT * FROM opportunities WHERE id = ?`, opportunityId);
  if (!opportunity) return c.json({ error: "Not found" }, 404);

  const [deal, settings] = await Promise.all([getDealByOpportunity(db, opportunityId), loadSettings(db)]);
  if (!deal) {
    const ref = await safeGradedPriceReference(db, opportunity.card_id, "PSA");
    return c.json({
      deal: null,
      offers: [],
      calculation: null,
      graderScales: GRADER_SCALES,
      gradedPriceReference: ref.reference,
      gradedPriceReferenceError: ref.error,
      fx: currentFxSnapshot(settings),
    });
  }

  const [offers, purchased] = await Promise.all([listOffers(db, deal.id), inventoryForDeal(db, deal.id)]);

  let calculation = null;
  let calculationError: string | null = null;
  try {
    const inputs: DealInputs = { ...(JSON.parse(deal.inputs_json) as DealInputsWithoutFx), fx: JSON.parse(deal.fx_snapshot_json) as FxSnapshot };
    calculation = calculateDeal(inputs, settings.feeModel, settings.sellingCosts);
  } catch (err) {
    // A stored deal that no longer calculates must still be READABLE — the
    // operator needs to see and fix their inputs, not lose them.
    calculationError = err instanceof Error ? err.message : String(err);
  }

  const ref = await safeGradedPriceReference(db, deal.card_id, deal.grader_id ?? "PSA");

  return c.json({
    deal,
    offers,
    calculation,
    calculationError,
    purchasedInventoryId: purchased?.id ?? null,
    graderScales: GRADER_SCALES,
    gradedPriceReference: ref.reference,
    gradedPriceReferenceError: ref.error,
    fx: currentFxSnapshot(settings),
  });
});

/** Save (create or replace) the operator's assumptions, and return the recomputed result. */
dealsRoute.put("/opportunity/:opportunityId", async (c) => {
  const db = new Db(c.env.DB);
  const opportunityId = c.req.param("opportunityId");

  const opportunity = await db.queryFirst<OpportunityRow>(`SELECT * FROM opportunities WHERE id = ?`, opportunityId);
  if (!opportunity) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json().catch(() => null);
  const parsed = parseDealInputs(body);
  if (parsed.error) return c.json({ error: parsed.error }, 400);

  const settings = await loadSettings(db);
  const existing = await getDealByOpportunity(db, opportunityId);

  // An existing deal keeps its ORIGINAL rate snapshot unless the caller asks
  // to re-price. Silently re-pricing on every save would mean a deal's
  // figures moved because time passed, not because the operator changed
  // anything.
  const repriceRequested = isPlainObject(body) && body.reprice === true;
  const fx: FxSnapshot =
    existing && !repriceRequested ? (JSON.parse(existing.fx_snapshot_json) as FxSnapshot) : currentFxSnapshot(settings);

  const inputs: DealInputs = { ...(parsed.inputs as DealInputsWithoutFx), fx };

  let calculation;
  try {
    calculation = calculateDeal(inputs, settings.feeModel, settings.sellingCosts);
  } catch (err) {
    if (err instanceof DealInputError || err instanceof MoneyInputError) return c.json({ error: err.message }, 400);
    throw err;
  }

  const id = existing?.id ?? crypto.randomUUID();
  const notes = isPlainObject(body) && typeof body.notes === "string" ? body.notes : null;
  await saveDeal(db, { id, opportunityId, cardId: opportunity.card_id, inputs, fx, notes });

  const saved = await getDealByOpportunity(db, opportunityId);
  return c.json({ deal: saved, calculation });
});

/** Place (or revise) an offer. */
dealsRoute.post("/:dealId/offers", async (c) => {
  const db = new Db(c.env.DB);
  const dealId = c.req.param("dealId");

  const deal = await getDealById(db, dealId);
  if (!deal) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body)) return c.json({ error: "Body must be an object." }, 400);

  const amount = body.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    return c.json({ error: "amount must be a non-negative finite number." }, 400);
  }
  const currency = typeof body.currency === "string" && body.currency.trim() ? body.currency.trim().toUpperCase() : "GBP";

  const settings = await loadSettings(db);
  // The offer is expressed in GBP using the DEAL's own frozen snapshot, so
  // the exposure figure and the deal's own costs are on the same rates.
  const fx = JSON.parse(deal.fx_snapshot_json) as FxSnapshot;
  const rate = rateFor(currency, fx);
  if (rate === null) {
    return c.json({ error: `No exchange rate for "${currency}" in this deal's rate snapshot.` }, 400);
  }
  void settings;

  const amountGbp = Math.round(amount * rate * 100) / 100;
  const id = crypto.randomUUID();
  const { supersededId } = await placeOffer(db, {
    id,
    dealId,
    amount,
    currency,
    rateToGbp: currency === "GBP" ? null : rate,
    amountGbp,
    expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
    note: typeof body.note === "string" ? body.note : null,
  });

  const offers = await listOffers(db, dealId);
  return c.json({ offerId: id, supersededId, offers }, 201);
});

/** Record what happened to an offer. */
dealsRoute.patch("/offers/:offerId", async (c) => {
  const db = new Db(c.env.DB);
  const offerId = c.req.param("offerId");

  const body = await c.req.json().catch(() => null);
  if (!isPlainObject(body)) return c.json({ error: "Body must be an object." }, 400);

  const status = body.status;
  if (typeof status !== "string" || !OFFER_STATUSES.includes(status as OfferStatus) || status === "PENDING") {
    return c.json({ error: `status must be one of: ${OFFER_STATUSES.filter((s) => s !== "PENDING").join(", ")}.` }, 400);
  }

  const offer = await getOffer(db, offerId);
  if (!offer) return c.json({ error: "Not found" }, 404);

  const { updated } = await resolveOffer(db, offerId, status as Exclude<OfferStatus, "PENDING">, typeof body.note === "string" ? body.note : null);
  if (!updated) {
    return c.json({ error: `This offer is already ${offer.status} — it cannot be resolved again.` }, 409);
  }

  return c.json({ offer: await getOffer(db, offerId) });
});

/**
 * Record the actual purchase, freezing the decision and creating inventory.
 *
 * Refuses a second purchase for the same deal rather than creating a
 * duplicate inventory row — and says which row already exists, so the
 * operator can go to it.
 */
dealsRoute.post("/:dealId/purchase", async (c) => {
  const db = new Db(c.env.DB);
  const dealId = c.req.param("dealId");

  const deal = await getDealById(db, dealId);
  if (!deal) return c.json({ error: "Not found" }, 404);

  const existing = await inventoryForDeal(db, dealId);
  if (existing) {
    return c.json({ error: "This deal has already been recorded as purchased.", inventoryId: existing.id }, 409);
  }

  const settings = await loadSettings(db);
  const inputs: DealInputs = { ...(JSON.parse(deal.inputs_json) as DealInputsWithoutFx), fx: JSON.parse(deal.fx_snapshot_json) as FxSnapshot };

  let calculation;
  try {
    calculation = calculateDeal(inputs, settings.feeModel, settings.sellingCosts);
  } catch (err) {
    if (err instanceof DealInputError || err instanceof MoneyInputError) {
      return c.json({ error: `This deal does not currently calculate, so it cannot be committed: ${err.message}` }, 400);
    }
    throw err;
  }

  /*
   * EVERY ACQUISITION COST MUST BE STATED BEFORE THE SPEND IS RECORDED.
   *
   * Found by the end-to-end test in test/dealWorkflow.test.ts, not by any
   * unit test: a deal whose price was still "not known yet" was happily
   * committed, writing an `actual_total_acquisition_cost` that omitted it and
   * then reading back, everywhere downstream, as a complete figure for money
   * actually spent.
   *
   * Saving assumptions with unknowns is fine and necessary — that is how a
   * deal gets worked. Recording a PURCHASE is different: it asserts that this
   * money left the account. "I don't know what I paid" cannot become a
   * number, so the commit is refused and the missing lines are named.
   *
   * The operator's escape hatch is not a default: it is entering the cost as
   * a CONFIRMED zero. "There were no import charges on this UK purchase" is a
   * fact they can state; it is not something this route may assume for them.
   */
  const missingAcquisition = calculation.acquisition.lines.filter((l) => l.detail.missing).map((l) => l.label);
  if (missingAcquisition.length > 0) {
    return c.json(
      {
        error:
          `These acquisition costs are still marked as not known, so this purchase cannot be recorded as actual spend: ` +
          `${missingAcquisition.join(", ")}. Enter each one, or set it to a confirmed zero if there was no such cost.`,
        missingInputs: missingAcquisition,
      },
      400,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const sourceUrl = isPlainObject(body) && typeof body.sourceUrl === "string" ? body.sourceUrl : null;
  const notes = isPlainObject(body) && typeof body.notes === "string" ? body.notes : null;

  const lineGbp = (key: string) => calculation.acquisition.lines.find((l) => l.key === key)?.gbp ?? 0;

  const inventoryId = crypto.randomUUID();
  const result = await recordPurchaseFromDeal(db, {
    inventoryId,
    dealId,
    opportunityId: deal.opportunity_id,
    cardId: deal.card_id,
    strategy: deal.strategy,
    purchasePrice: lineGbp("price"),
    sellerPostage: lineGbp("sellerPostage"),
    importTax: lineGbp("importCharges"),
    otherFees: lineGbp("otherAcquisitionCosts"),
    totalAcquisitionCost: calculation.acquisition.total,
    sourceUrl,
    // THE FROZEN RECORD: the operator's own inputs, the rates they were
    // priced at, and the calculation they committed against.
    decisionSnapshot: { inputs, calculation, committedAt: new Date().toISOString(), calcVersion: calculation.calcVersion },
    notes,
  });

  if (!result.created) {
    return c.json({ error: "This deal has already been recorded as purchased.", inventoryId: result.existingInventoryId }, 409);
  }
  return c.json({ inventoryId }, 201);
});

/**
 * Commitment summary — deliberately two separate figures.
 *
 * Pending offers are NOT spend. They are what would be committed if every
 * outstanding offer were accepted. Adding them to actual spend would
 * overstate what has left the account; omitting them would understate the
 * exposure. Both are returned, separately labelled, and never summed here.
 */
/**
 * Cards with a live offer out on them — the pipeline stage between a saved
 * lead and a card you own.
 *
 * Read-only and cheap: one query, no calculation, no model. It is a listing
 * of rows that already exist, which is why it does not recompute the deal —
 * the amount shown is the offer actually placed, not what the desk thinks
 * the card is worth today.
 */
dealsRoute.get("/under-offer", async (c) => {
  const db = new Db(c.env.DB);
  const rows = await dealsUnderOffer(db);
  return c.json({ deals: rows, count: rows.length });
});

dealsRoute.get("/commitments", async (c) => {
  const db = new Db(c.env.DB);
  const [pending, actual, planned] = await Promise.all([
    pendingOfferExposure(db),
    actualAcquisitionSpend(db),
    plannedGradingCost(db),
  ]);
  return c.json({
    pendingOffers: { count: pending.count, potentialSpendGbp: Math.round(pending.totalGbp * 100) / 100 },
    actualSpend: { inventoryCount: actual.count, spentGbp: Math.round(actual.totalGbp * 100) / 100 },
    plannedGrading: { cardCount: planned.count, plannedGbp: planned.totalGbp, uncostedCards: planned.uncosted },
  });
});
