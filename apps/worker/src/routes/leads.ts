import { Hono } from "hono";
import { Db, type CardRow } from "@mwmc/db";
import { buildOpportunities, type RawCardIdentity } from "@mwmc/core";
import { createEbayListingsProvider, parseEbayItemReference } from "@mwmc/providers";
import type { Env } from "../env.js";
import { loadSettings, usdPerGbpFrom } from "../repo/settingsRepo.js";
import { upsertListing } from "../repo/listingsRepo.js";
import { upsertOpportunity } from "../repo/opportunitiesRepo.js";
import { hydrateStoredSnapshots } from "../scan/marketProfiling.js";
import { rowToIdentity } from "../scan/scanRunner.js";

/**
 * ADDING A LEAD BY HAND.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. Reported 2026-09-14: "I bought a card from a vendor on
 * eBay but I can't add it in the pipeline, it didn't come from our tool."
 *
 * Everything in this app arrives through a keyword search built from the
 * catalogue. That is the right way to find cards at volume and it has one
 * hole: a card you found yourself — browsing a seller's other items, a
 * message from a vendor, a link from a friend — has no way in. It cannot be
 * tracked, it never reaches the deal desk, and when it is graded and sold it
 * is missing from every figure the tool reports back.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT ASKS WHICH CARD, INSTEAD OF READING THE TITLE.
 *
 * There is no title-to-identity parser in this codebase and this is not the
 * place to invent one. A listing title is marketing copy, and guessing a
 * printing from it is exactly how a jumbo gets priced as a standard.
 *
 * So the operator names the card, choosing from a list that shows name, set,
 * number and variant. It is one extra click and it removes a whole class of
 * misidentification. From there the listing runs through the same resolver,
 * the same engine and the same economics as a discovered one — a hand-added
 * lead is not a special kind of row, it is an ordinary row that happened to
 * be found by a human.
 *
 * The one thing it does NOT reuse is the scanner's title reconciliation. See
 * the note at the identity below for why that was wrong here, and what it
 * broke.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT IT WILL NOT DO. It will not fabricate a lead. If eBay has no such
 * item, if the reference is not an item link, if the card is not catalogued,
 * or if there is no market data to price the card against, it says which of
 * those happened and adds nothing. An empty pipeline is recoverable; a
 * pipeline with an invented row in it is not.
 */
export const leadsRoute = new Hono<{ Bindings: Env }>();

interface AddLeadBody {
  /** An eBay item URL, or the bare item number. */
  reference?: string;
  /** Which catalogued printing this listing is. */
  cardId?: string;
  /** Where it lands on the board. */
  reviewStatus?: string;
  notes?: string;
}

/** The board's own columns — anywhere else would not be "adding a lead". */
const ALLOWED_STAGES = ["INTERESTED", "UNDER_OFFER", "BOUGHT"] as const;

leadsRoute.post("/", async (c) => {
  const db = new Db(c.env.DB);
  const body = await c.req.json<AddLeadBody>().catch(() => null);

  if (!body) return c.json({ error: "Expected a JSON body." }, 400);

  const stage = String(body.reviewStatus ?? "INTERESTED").toUpperCase();
  if (!ALLOWED_STAGES.includes(stage as (typeof ALLOWED_STAGES)[number])) {
    return c.json({ error: `Stage must be one of ${ALLOWED_STAGES.join(", ")}.` }, 400);
  }

  const parsed = parseEbayItemReference(body.reference);
  if (!parsed) {
    return c.json(
      {
        error:
          "That doesn't look like an eBay item link. Paste the listing's web address (the one with /itm/ in it) " +
          "or just the item number.",
      },
      400,
    );
  }

  const cardId = String(body.cardId ?? "").trim();
  if (!cardId) return c.json({ error: "Pick which card this listing is." }, 400);

  const cardRow = await db.queryFirst<CardRow>(`SELECT * FROM cards WHERE id = ?`, cardId);
  if (!cardRow) {
    return c.json({ error: "That card isn't in the catalogue, so there is nothing to price this listing against." }, 404);
  }

  const ebayProvider = createEbayListingsProvider(c.env.EBAY_PROVIDER, {
    clientId: c.env.EBAY_CLIENT_ID,
    clientSecret: c.env.EBAY_CLIENT_SECRET,
    marketplaceId: c.env.EBAY_MARKETPLACE_ID,
    oauthScope: c.env.EBAY_OAUTH_SCOPE,
  });

  if (typeof ebayProvider.getListingById !== "function") {
    return c.json({ error: "The configured eBay provider cannot fetch a single listing by id." }, 501);
  }

  let raw;
  try {
    raw = await ebayProvider.getListingById(parsed.restfulItemId);
  } catch (err) {
    return c.json({ error: `eBay refused that lookup: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
  if (!raw) {
    return c.json({ error: `eBay has no item ${parsed.legacyItemId}. It may have been removed.` }, 404);
  }

  // Identity confidence 1: the operator told us which card this is. That is
  // a stronger claim than any title match, and it is recorded as a human
  // decision in identity_notes rather than passed off as the resolver's.
  await upsertListing(db, raw, cardRow.id, 1, `Added by hand and matched to ${cardRow.name} (${cardRow.set_name} #${cardRow.card_number}).`);

  const settings = await loadSettings(db);
  const snapshots = await hydrateStoredSnapshots(db, [cardRow.id], settings.fxRates);
  if (!snapshots.has(cardRow.id)) {
    return c.json(
      {
        error:
          `The listing was saved, but there is no market data for ${cardRow.name} yet, so it cannot be priced ` +
          `or put on the board. It will be priced automatically on a scan once the card has been profiled.`,
        listingSaved: true,
      },
      409,
    );
  }

  /*
   * THE IDENTITY IS ASSERTED, NOT INFERRED — corrected 2026-09-14, first try.
   *
   * This originally ran the catalogue identity through
   * reconcileIdentityWithTitle, on the reasoning that reusing the scanner's
   * path exactly was the safe thing to do. It was the wrong path, and it
   * rejected real listings outright:
   *
   *   API /leads failed: 409 ... FLIP: skipped_identity_uncertain;
   *                              GRADE: skipped_identity_uncertain
   *
   * Reconciliation answers "we SEARCHED for this card — does the listing
   * title corroborate it?", and it exists because eBay's search is full text
   * and cheerfully returns other cards. It corroborates-or-DROPS, and a
   * dropped required field is meant to route the listing to identity-
   * uncertain. That is correct for a guess and nonsense for an assertion.
   *
   * Here there was no search and no guess. A person looked at the listing,
   * looked at a list showing name, set, number and variant, and said which
   * card it is. Second-guessing that against marketing copy can only
   * overrule the one party actually holding the evidence.
   *
   * It also fails on ordinary data. Catalogue names carry parenthetical
   * qualifiers the seller writes differently: "Blastoise EX (142 Full Art)"
   * against a title reading "Blastoise EX 142/146 Full Art" fails the
   * name-substring test, drops `name`, and takes the whole resolve down with
   * it. Measured against five real catalogue names, one in five failed —
   * every one of them a card the operator had identified correctly.
   *
   * So the identity comes from the catalogue row, whole. resolveCardPrinting
   * then returns confidence 1 and the row's own printing hash, because these
   * are the exact fields that hash was computed from.
   */
  const identity: RawCardIdentity = rowToIdentity(cardRow);
  const candidates = buildOpportunities(
    [
      {
        listingId: raw.ebayItemId,
        title: raw.title,
        price: raw.price,
        shippingCost: raw.shippingCost,
        itemUrl: raw.itemUrl,
        sellerFeedbackScore: raw.sellerFeedbackScore,
        sellerFeedbackPct: raw.sellerFeedbackPct,
        parsedIdentity: identity,
        listingType: raw.listingType,
        itemCondition: raw.itemCondition,
      },
    ],
    snapshots,
    {
      qualification: settings.qualification,
      qsvSettings: settings.qsvSettings,
      feeModel: settings.feeModel,
      sellingCosts: settings.sellingCosts,
      gradingServices: settings.gradingServices,
      gradingBatch: settings.gradingBatch,
      gradingConsumables: settings.gradingConsumables,
      classificationSettings: settings.classificationSettings,
      flipScoreWeights: settings.flipScoreWeights,
      gradeScoreWeights: settings.gradeScoreWeights,
      usdPerGbp: usdPerGbpFrom(settings.fxRates),
    },
  );

  // A hand-add is its own kind of event and is recorded as one, so a row
  // that appeared without a search is traceable to the moment somebody put
  // it there rather than looking like it fell out of a scan.
  const runId = crypto.randomUUID();
  await db.exec(
    `INSERT INTO scan_runs (id, trigger, status, started_at, finished_at, strategy_scope)
     VALUES (?, 'MANUAL_LEAD', 'SUCCESS', datetime('now'), datetime('now'), '["FLIP","GRADE"]')`,
    runId,
  );

  const outcomes: string[] = [];
  let stored = 0;
  for (const candidate of candidates) {
    const outcome = await upsertOpportunity(db, candidate, runId);
    outcomes.push(`${candidate.strategy}: ${outcome}`);
    if (outcome === "created" || outcome === "updated") stored++;
  }

  if (stored === 0) {
    return c.json(
      {
        error:
          `The listing was saved, but no priced opportunity could be built from it (${outcomes.join("; ")}). ` +
          `Nothing was added to the board — see the listing on the Market tab.`,
        listingSaved: true,
        outcomes,
      },
      409,
    );
  }

  // Put it on the board. Deliberately last: the row has to exist and be
  // priced before it can be given a stage, and a failure anywhere above must
  // not leave a stage set on something that was never added.
  await db.exec(
    `UPDATE opportunities
        SET review_status = ?, reviewed_at = datetime('now'),
            review_notes = COALESCE(?, review_notes), updated_at = datetime('now')
      WHERE listing_id = ?`,
    stage,
    body.notes?.trim() ? body.notes.trim() : null,
    raw.ebayItemId,
  );

  const opportunity = await db.queryFirst<{ id: string }>(
    `SELECT id FROM opportunities WHERE listing_id = ? ORDER BY strategy LIMIT 1`,
    raw.ebayItemId,
  );

  return c.json({
    opportunityId: opportunity?.id ?? null,
    listingId: raw.ebayItemId,
    title: raw.title,
    price: raw.price,
    card: { id: cardRow.id, name: cardRow.name, setName: cardRow.set_name, cardNumber: cardRow.card_number },
    reviewStatus: stage,
    outcomes,
  });
});
