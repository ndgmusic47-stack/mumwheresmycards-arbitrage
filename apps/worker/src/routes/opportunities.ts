import { Hono } from "hono";
import { Db, type OpportunityRow, type CardRow, type EbayListingRow, type MarketSnapshotRow } from "@mwmc/db";
import { computeMaxBid, extractConditionTierPrices } from "@mwmc/core";
import {
  AiListingAnalystProvider,
  createAiModelProvider,
  AiCompletionCache,
  GuardedAiModelProvider,
} from "@mwmc/providers";
import {
  loadOpportunityCounts,
  updateOpportunityReview,
  listLearningReviewSnapshots,
  REVIEW_STATUSES,
  REVIEW_REASON_CODES,
  type ReviewStatus,
  type ReviewReasonCode,
} from "../repo/opportunitiesRepo.js";
import { loadSettings } from "../repo/settingsRepo.js";
import { buildAdvisoryEconomicsFacts, buildAdvisoryEvidence } from "../ai/advisoryEvidence.js";
import type { Env } from "../env.js";

export const opportunitiesRoute = new Hono<{ Bindings: Env }>();

interface OpportunityListItem extends OpportunityRow {
  card_name: string;
  card_set_name: string;
  card_set_code: string;
  card_number: string;
  card_edition: string;
  card_variant: string;
  card_finish: string;
  listing_title: string;
  listing_item_url: string;
  listing_type: string;
  /** STABILISATION item 6 (classification) — eBay's free-text condition
   *  value, already captured on ebay_listings but not previously joined
   *  into the list feed (only the detail endpoint had it). */
  listing_item_condition: string | null;
  /** STABILISATION item 8 (freshness) — 'ACTIVE' unless
   *  expireEndedAuctionListings() has since flipped it to 'ENDED'. */
  listing_status: string;
  /** STABILISATION item 8 (freshness) — the last time this exact eBay
   *  listing was actually re-observed in a search, not when the
   *  opportunity row was computed. Lets the dashboard show "last verified"
   *  rather than implying every row is as fresh as the scan that ran it. */
  listing_fetched_at: string;
  /** SOURCING WORKFLOW item 14 (auction workflow) — end_time/bids were
   *  captured on ebay_listings since the original schema but never joined
   *  into the list feed; the auction table needs both (time remaining,
   *  bid count) directly, not just via the detail endpoint. */
  listing_end_time: string | null;
  listing_bids: number | null;
  /** SOURCING WORKFLOW item 7 (XLSX export) — "shipping" and "first seen"
   *  fields the export's FLIP/GRADE field lists ask for. Cheap to always
   *  select (same already-joined ebay_listings row), so not gated behind
   *  includeMarketRef unlike the market-reference columns below. */
  listing_shipping_cost: number;
  listing_first_seen: string;
  /** SOURCING WORKFLOW item 9 (two-stage enrichment) — cheap to always
   *  select (same already-joined ebay_listings row). Null means "never
   *  gone through stage-two enrichment yet", not "checked, nothing found"
   *  (see EbayListingRow's doc comment). The full raw condition_descriptors/
   *  condition_description live on the /:id detail endpoint's `listing`,
   *  not duplicated into every list row — they're diagnostic detail, not
   *  something a sourcing list needs to sort/filter/render per row. */
  listing_enriched_at: string | null;
  /** SOURCING WORKFLOW item 17 (review-status workflow) — a manual sourcing
   *  decision recorded against THIS opportunity row, independent of its
   *  computed state/qualifies/score. Cheap to always select (no join, same
   *  opportunities row). See updateOpportunityReview() in
   *  opportunitiesRepo.ts for how these survive a re-scan. */
  review_status: "UNREVIEWED" | "CHECKED" | "INTERESTED" | "PASS" | "BOUGHT";
  review_notes: string | null;
  reviewed_at: string | null;
  /** SOURCING WORKFLOW item 7/11 — only populated when `includeMarketRef=1`
   *  is passed (see the LEFT JOIN below). These come from the market_snapshot
   *  the opportunity was actually priced against, not a live re-query, so a
   *  row keeps referring to the same numbers it was computed from even if
   *  the market has since moved. Absent (undefined, not null) rather than
   *  present-but-null when the flag isn't passed, since the SQL simply never
   *  selects them in that case — callers that don't ask for these never pay
   *  the extra JOIN cost on the normal, frequently-hit paginated list call.
   */
  market_median_7d?: number | null;
  market_median_30d?: number | null;
  market_sample_size?: number | null;
  market_psa7?: number | null;
  market_psa8?: number | null;
  market_psa9?: number | null;
  market_psa10?: number | null;
  /** SOURCING WORKFLOW item 14 (auction workflow) — the actionable number
   *  on an AUCTION listing is what you COULD bid up to, not the profit at
   *  the current bid. FLIP-strategy rows only; see computeMaxBid's own doc
   *  comment for why GRADE isn't computed here (null on GRADE rows, always
   *  — never a fabricated number). Computed fresh on every request from
   *  this row's own expected_net_sale_proceeds and the live settings
   *  qualification bar, so it's never stale relative to Settings. */
  max_bid: number | null;
  max_delivered_cost: number | null;
  headroom_vs_current_price: number | null;
}

/**
 * GET /api/opportunities — the dashboard's "BEST OPPORTUNITIES NOW" feed.
 *
 * Query params:
 *   strategy=FLIP|GRADE|BOTH, state=... (comma-separated for an IN (...) list,
 *   e.g. "QUALIFIED_FLIP,QUALIFIED_GRADE" — a single value still works exactly
 *   as before), limit= (page size, capped 500), offset= (page start),
 *   qualifiedOnly=true|false
 *
 * STABILISATION fix (item 1): this endpoint used to silently cap at 100/500
 * rows with no way to see how many candidates actually exist or page past
 * the first screen. It now returns `total` (rows matching the current
 * strategy/state/qualifiedOnly filter) and `counts` (a full breakdown of
 * every opportunity currently stored, independent of the filter, so the
 * dashboard can render "412 total candidates / 18 qualified flips / 26
 * grading candidates / 43 auctions / ... / 294 rejected" honestly instead of
 * only ever showing whatever fit in the first page).
 *
 * (Full dynamic filtering against live forecast fields is applied client-
 * side against this feed plus /api/settings' stored filter defaults —
 * heavier ad-hoc filter combinations can be pushed server-side later by
 * building a WHERE clause from the same FilterSet shape used by
 * packages/core/src/filters, without changing the response contract.)
 */
/**
 * Builds the `o.state = ?` / `o.state IN (?,?,...)` condition for a raw
 * `state` query param, which may now be a single value (unchanged, existing
 * behaviour) or a comma-separated list (STABILISATION item 10 — the
 * dashboard's category tabs each map to a list of states, e.g. "REJECTED"
 * covering NO_MARKET_DATA + both rejection reasons at once). Pulled out as
 * its own pure function so the SQL/params it produces can be pinned down
 * without spinning up a Hono app or a fake D1 binding.
 */
export function buildStateCondition(state: string | undefined): { clause: string; params: string[] } | null {
  if (!state) return null;
  const states = state
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (states.length === 0) return null;
  if (states.length === 1) return { clause: "o.state = ?", params: states };
  return { clause: `o.state IN (${states.map(() => "?").join(",")})`, params: states };
}

/**
 * AI INTELLIGENCE gap 3: "the final actionable feed" — apps/web/src/state/
 * filters.ts's CATEGORY_STATES.ACTIONABLE (["QUALIFIED_FLIP",
 * "QUALIFIED_GRADE"]) — is what re-evaluated AI routing must actually gate,
 * per the spec's explicit requirement. Detected structurally, not by a
 * magic "category" param the server never otherwise sees: a request is
 * "asking for the actionable feed" when EVERY state it asked for is one of
 * the two truly-actionable states, never a superset (so REVIEW's
 * ["INSPECT_PHOTOS"], NEAR_MISS, REJECTED, or an unfiltered "ALL" request
 * are all correctly left alone) and never empty (no state filter at all is
 * not "asking for ACTIONABLE"). A single-state "QUALIFIED_FLIP" lookup
 * (e.g. the FLIP-only dashboard view) is still correctly caught.
 */
const ACTIONABLE_ONLY_STATES = new Set(["QUALIFIED_FLIP", "QUALIFIED_GRADE"]);

export function isActionableStateFilter(state: string | undefined): boolean {
  if (!state) return false;
  const states = state
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (states.length === 0) return false;
  return states.every((s) => ACTIONABLE_ONLY_STATES.has(s));
}

/**
 * SOURCING WORKFLOW item 5: allowlisted sort keys mapped to real SQL
 * expressions. Never build ORDER BY from a raw query-string value directly —
 * that's a SQL-injection surface. An unknown/omitted key falls back to the
 * pre-existing default (qualifying first, then score) so old links/bookmarks
 * and the previous behaviour keep working exactly as before.
 *
 * "newest" sorts by `l.fetched_at` — the last time THIS TOOL observed the
 * listing, not eBay's own listing-start timestamp (the Browse API doesn't
 * expose one to this app). That's an honest proxy, not the literal thing
 * the spec's wording implies, and is documented as such rather than silently
 * assumed to mean something more precise than it does.
 */
const SORT_EXPRESSIONS: Record<string, string> = {
  newest: "l.fetched_at",
  score: "COALESCE(o.score, o.flip_score, o.grade_score)",
  listing_price: "o.listing_price",
  delivered_cost: "o.total_acquisition_cost",
  qsv: "o.qsv",
  // Fraction of QSV the delivered cost sits below — NULL (sorts last) when
  // QSV is unknown or zero, never a fabricated 0.
  discount_to_qsv: "(CASE WHEN o.qsv IS NULL OR o.qsv = 0 THEN NULL ELSE (o.qsv - o.total_acquisition_cost) / o.qsv END)",
  net_profit: "o.expected_net_profit",
  roc: "o.return_on_capital",
  margin: "o.profit_margin",
  liquidity: "(CASE o.liquidity WHEN 'VERY_HIGH' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 WHEN 'LOW' THEN 1 ELSE 0 END)",
  confidence: "o.confidence",
  card_name: "c.name",
  last_scan: "l.fetched_at",
  // GRADE-specific
  psa9_profit: "o.psa9_profit",
  psa10_profit: "o.psa10_profit",
  break_even_grade: "o.break_even_grade",
  graded_basis: "o.total_graded_basis",
  capital_lock: "o.estimated_capital_lock_days",
  // AUCTION-specific (current bid IS o.listing_price for an AUCTION listing —
  // see bug 9/item 6's classification fix; there is no separate column)
  current_bid: "o.listing_price",
  time_remaining: "l.end_time",
};

export function buildSortClause(sort: string | undefined, dir: string | undefined): string {
  const expr = (sort && SORT_EXPRESSIONS[sort]) || null;
  if (!expr) {
    // Default, unchanged from before item 5: qualifying first, then score.
    return "o.qualifies DESC, COALESCE(o.score, o.flip_score, o.grade_score) DESC";
  }
  const direction = dir === "asc" ? "ASC" : "DESC";
  // NULLs always sort last regardless of direction — a missing value (no
  // QSV yet, no end_time on a non-auction) should never masquerade as the
  // highest or lowest real value in the column.
  return `(${expr}) IS NULL, ${expr} ${direction}`;
}

/**
 * SOURCING WORKFLOW item 6: practical range/set filters beyond `state`.
 * Every value is bound as a parameter — only the (allowlisted) column
 * expression itself is ever concatenated into the SQL string.
 */
export function buildFilterConditions(query: URLSearchParams): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const numeric = (key: string, expr: string, cmp: ">=" | "<=") => {
    const raw = query.get(key);
    if (raw === null || raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    conditions.push(`${expr} ${cmp} ?`);
    params.push(n);
  };

  numeric("minListingPrice", "o.listing_price", ">=");
  numeric("maxListingPrice", "o.listing_price", "<=");
  numeric("minDeliveredCost", "o.total_acquisition_cost", ">=");
  numeric("maxDeliveredCost", "o.total_acquisition_cost", "<=");
  numeric("minQsv", "o.qsv", ">=");
  numeric("maxQsv", "o.qsv", "<=");
  numeric("minNetProfit", "o.expected_net_profit", ">=");
  numeric("minRoc", "o.return_on_capital", ">=");
  // AI INTELLIGENCE gap 4: profit_margin is FLIP-only (NULL on every GRADE
  // row, same as expected_net_profit/return_on_capital above) — the client
  // only ever sends this when strategy === "FLIP" (see buildServerFilterParams
  // in apps/web/src/state/filters.ts), same discipline as minNetProfit/minRoc.
  numeric("minMargin", "o.profit_margin", ">=");
  numeric("minConfidence", "o.confidence", ">=");
  numeric("minCapitalLock", "o.estimated_capital_lock_days", ">=");
  numeric("maxCapitalLock", "o.estimated_capital_lock_days", "<=");

  // Discount-to-QSV as a fraction (0.2 = "at least 20% below QSV"), NULL-safe.
  const minDiscount = query.get("minDiscountToQsv");
  if (minDiscount !== null && minDiscount !== "" && Number.isFinite(Number(minDiscount))) {
    conditions.push(
      "(o.qsv IS NOT NULL AND o.qsv > 0 AND (o.qsv - o.total_acquisition_cost) / o.qsv >= ?)",
    );
    params.push(Number(minDiscount));
  }

  const csvIn = (key: string, expr: string) => {
    const raw = query.get(key);
    if (!raw) return;
    const values = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (values.length === 0) return;
    conditions.push(`${expr} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };

  csvIn("liquidity", "o.liquidity");
  csvIn("listingType", "l.listing_type");
  // AI INTELLIGENCE gap 3 / release gate #5 (manual false-positive review):
  // lets a caller find exactly what AI routed a given way — e.g.
  // aiReviewStatus=REVIEW,BLOCK_FROM_ACTIONABLE to audit everything AI
  // flagged, independent of (and typically combined with)
  // includeAiFlagged=1 so those rows aren't also excluded by the
  // ACTIONABLE-feed gate above.
  csvIn("aiReviewStatus", "o.ai_review_status");

  // "UNKNOWN" as a sentinel for a NULL condition — the tool never invents a
  // condition value, so an unknown listing condition needs its own explicit
  // bucket rather than being silently excluded or silently matched.
  const conditionRaw = query.get("condition");
  if (conditionRaw) {
    const values = conditionRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const known = values.filter((v) => v !== "UNKNOWN");
    const wantsUnknown = values.includes("UNKNOWN");
    const parts: string[] = [];
    if (known.length > 0) {
      parts.push(`l.item_condition IN (${known.map(() => "?").join(",")})`);
      params.push(...known);
    }
    if (wantsUnknown) parts.push("l.item_condition IS NULL");
    if (parts.length > 0) conditions.push(`(${parts.join(" OR ")})`);
  }

  const cardName = query.get("cardName");
  if (cardName) {
    conditions.push("c.name LIKE ?");
    params.push(`%${cardName}%`);
  }
  const setName = query.get("set");
  if (setName) {
    conditions.push("(c.set_name LIKE ? OR c.set_code LIKE ?)");
    params.push(`%${setName}%`, `%${setName}%`);
  }

  return { clause: conditions.join(" AND "), params };
}

opportunitiesRoute.get("/", async (c) => {
  const db = new Db(c.env.DB);
  const strategy = c.req.query("strategy"); // FLIP | GRADE
  const state = c.req.query("state");
  const qualifiedOnlyParam = c.req.query("qualifiedOnly");
  // SOURCING WORKFLOW item 7 (XLSX export): raised from the STABILISATION-era
  // cap of 500 so an export of the current filtered set (up to the actual
  // actionable universe size, ~1,300 at last count — see the project doc) can
  // be fetched in one call rather than a page-by-page loop. Still a real,
  // fixed ceiling, not "load everything" — normal sourcing pagination keeps
  // using 75/page regardless (see PAGE_SIZE in apps/web/src/pages/Dashboard.tsx).
  const rawLimit = Math.min(Math.max(1, Number(c.req.query("limit") ?? c.req.query("pageSize") ?? 100)), 5000);
  // `page` (1-based) is the sourcing-workflow-friendly form (item 4); `offset`
  // still works directly for anything that already used it (item 1's counts
  // panel, the market page). If both are given, `page` wins.
  const pageParam = c.req.query("page");
  const offset =
    pageParam !== undefined
      ? Math.max(0, (Math.max(1, Number(pageParam)) - 1) * rawLimit)
      : Math.max(0, Number(c.req.query("offset") ?? 0));
  const limit = rawLimit;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (strategy && strategy !== "BOTH") {
    conditions.push("o.strategy = ?");
    params.push(strategy);
  }
  const stateCondition = buildStateCondition(state);
  if (stateCondition) {
    conditions.push(stateCondition.clause);
    params.push(...stateCondition.params);
  }
  if (qualifiedOnlyParam === "true") {
    conditions.push("o.qualifies = 1");
  }
  // AI INTELLIGENCE gap 3: "Re-evaluate routing after enrichment/AI before
  // the final actionable feed is persisted." — the actual gate is applied
  // HERE, at read time, not by mutating any row: a candidate AI routed to
  // REVIEW or BLOCK_FROM_ACTIONABLE simply never appears in the ACTIONABLE
  // feed's result set, while its own `state`/`qualifies` stay exactly what
  // the deterministic engine computed (untouched — see migration 0021's doc
  // comment). ai_review_status IS NULL (never AI-reviewed — no provider
  // configured, budget-capped, or not yet reached) is deliberately treated
  // as "no opinion", same as PASS_THROUGH, never as a block.
  // `includeAiFlagged=1` bypasses this for audit/QA tooling (release gate
  // #5's manual false-positive review) that needs to see what AI flagged,
  // not just what survived it.
  const includeAiFlagged = c.req.query("includeAiFlagged") === "1" || c.req.query("includeAiFlagged") === "true";
  if (!includeAiFlagged && isActionableStateFilter(state)) {
    conditions.push("(o.ai_review_status IS NULL OR o.ai_review_status = 'PASS_THROUGH')");
  }
  const url = new URL(c.req.url);
  const filterCondition = buildFilterConditions(url.searchParams);
  if (filterCondition.clause) {
    conditions.push(filterCondition.clause);
    params.push(...filterCondition.params);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderBy = buildSortClause(c.req.query("sort"), c.req.query("dir"));

  // SOURCING WORKFLOW item 7/11: only join market_snapshots (a real extra
  // JOIN cost) when a caller actually asks for the reference-price columns —
  // the export flow, and later the "why is this cheap?"/price-spread panel.
  // The normal paginated dashboard list never passes this flag.
  const includeMarketRef = c.req.query("includeMarketRef") === "1" || c.req.query("includeMarketRef") === "true";
  const marketRefJoin = includeMarketRef ? "LEFT JOIN market_snapshots ms ON ms.id = o.market_snapshot_id" : "";
  const marketRefColumns = includeMarketRef
    ? `, ms.raw_median_7d as market_median_7d, ms.raw_median_30d as market_median_30d,
              ms.sample_size as market_sample_size, ms.psa7 as market_psa7, ms.psa8 as market_psa8,
              ms.psa9 as market_psa9, ms.psa10 as market_psa10`
    : "";

  const [rows, totalRow, counts, settings] = await Promise.all([
    db.queryAll<OpportunityListItem>(
      `SELECT o.*, c.name as card_name, c.set_name as card_set_name, c.set_code as card_set_code,
              c.card_number as card_number, c.edition as card_edition, c.variant as card_variant, c.finish as card_finish,
              l.title as listing_title, l.item_url as listing_item_url, l.listing_type as listing_type,
              l.item_condition as listing_item_condition, l.status as listing_status, l.fetched_at as listing_fetched_at,
              l.end_time as listing_end_time, l.bids as listing_bids,
              l.shipping_cost as listing_shipping_cost, l.created_at as listing_first_seen,
              l.enriched_at as listing_enriched_at${marketRefColumns}
       FROM opportunities o
       JOIN cards c ON c.id = o.card_id
       JOIN ebay_listings l ON l.id = o.listing_id
       ${marketRefJoin}
       ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    ),
    db.queryFirst<{ total: number }>(
      `SELECT COUNT(*) as total FROM opportunities o JOIN ebay_listings l ON l.id = o.listing_id JOIN cards c ON c.id = o.card_id ${where}`,
      ...params,
    ),
    loadOpportunityCounts(db),
    loadSettings(db),
  ]);

  // SOURCING WORKFLOW item 14: computed fresh per request from each row's
  // own already-persisted expected_net_sale_proceeds plus the LIVE settings
  // qualification bar (never a value baked in at scan time, so it's never
  // stale relative to a Settings change) — see computeMaxBid's doc comment
  // for why this is FLIP-only.
  const flipQualification = settings.qualification.flip;
  for (const row of rows) {
    if (row.strategy === "FLIP") {
      const maxBid = computeMaxBid({
        expectedNetSaleProceeds: row.expected_net_sale_proceeds,
        totalAcquisitionCost: row.total_acquisition_cost,
        listingPrice: row.listing_price,
        minNetProfit: flipQualification.minNetProfit,
        minReturnOnCapital: flipQualification.minReturnOnCapital,
      });
      row.max_bid = maxBid.maxBid;
      row.max_delivered_cost = maxBid.maxDeliveredCost;
      row.headroom_vs_current_price = maxBid.headroomVsCurrentPrice;
    } else {
      row.max_bid = null;
      row.max_delivered_cost = null;
      row.headroom_vs_current_price = null;
    }
  }

  const total = totalRow?.total ?? 0;
  return c.json({
    opportunities: rows,
    total,
    limit,
    offset,
    page: Math.floor(offset / limit) + 1,
    pageCount: Math.max(1, Math.ceil(total / limit)),
    counts,
  });
});

opportunitiesRoute.get("/:id", async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param("id");

  const opportunity = await db.queryFirst<OpportunityRow>(`SELECT * FROM opportunities WHERE id = ?`, id);
  if (!opportunity) return c.json({ error: "Not found" }, 404);

  // SOURCING WORKFLOW item 10 ("why is this cheap?" panel): the opportunity
  // row already stores WHICH market_snapshots row it was actually priced
  // against (market_snapshot_id, frozen at scan time — see ARCHITECTURE.md's
  // "forecast frozen" principle), but the detail endpoint never fetched it.
  // A single extra queryFirst by primary key — cheap, and only for the one
  // opportunity being viewed, unlike the list feed's includeMarketRef flag
  // which gates a real per-row JOIN cost across many rows.
  const [card, listing, marketSnapshot, settings] = await Promise.all([
    db.queryFirst<CardRow>(`SELECT * FROM cards WHERE id = ?`, opportunity.card_id),
    db.queryFirst<EbayListingRow>(`SELECT * FROM ebay_listings WHERE id = ?`, opportunity.listing_id),
    opportunity.market_snapshot_id !== null
      ? db.queryFirst<MarketSnapshotRow>(`SELECT * FROM market_snapshots WHERE id = ?`, opportunity.market_snapshot_id)
      : Promise.resolve(null),
    loadSettings(db),
  ]);

  // SOURCING WORKFLOW item 8 (condition truth layer): market_snapshots has
  // stored the FULL PokeTrace card-detail response verbatim on every row
  // since migration 0002 (raw_payload, for audit) — and that response
  // carries real per-condition raw-card pricing (DAMAGED/HEAVILY_PLAYED/
  // MODERATELY_PLAYED/LIGHTLY_PLAYED/NEAR_MINT), not just the single
  // NEAR_MINT tier this app's economics use as "the" raw price. Extracted
  // here at request time (see extractConditionTierPrices's own doc
  // comment for why) rather than at scan time, so every already-profiled
  // card benefits immediately with no migration or re-scan. Uses the
  // LIVE settings.fxRates — the same FX table that would be used if this
  // card were re-scanned right now — rather than a hardcoded default, so
  // a user who has edited their FX rates in Settings gets a consistent
  // conversion here too.
  let conditionTierPrices = null;
  if (marketSnapshot?.raw_payload) {
    try {
      conditionTierPrices = extractConditionTierPrices(JSON.parse(marketSnapshot.raw_payload), settings.fxRates);
    } catch {
      // Malformed/unparseable raw_payload (shouldn't happen — it's written
      // by this app's own scan pipeline — but this is a display-only
      // enrichment, so fail soft rather than break the whole detail page.
      conditionTierPrices = null;
    }
  }

  return c.json({
    opportunity,
    card,
    listing: listing ? { ...listing, image_urls: listing.image_urls ? JSON.parse(listing.image_urls) : [] } : null,
    marketSnapshot,
    conditionTierPrices,
    reasoning: opportunity.reasoning ? JSON.parse(opportunity.reasoning) : [],
  });
});

// SOURCING WORKFLOW item 17 (review-status workflow): a manual sourcing
// decision the user records against a specific opportunity — never a
// computed/engine signal, never influencing state/qualifies/score. Accepts
// either or both of reviewStatus/reviewNotes so a notes-only save doesn't
// have to resend a status the caller didn't change.
opportunitiesRoute.patch("/:id/review", async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param("id");

  const body = await c
    .req
    .json<{ reviewStatus?: string; reviewNotes?: string | null; reviewReasonCode?: string | null }>()
    .catch(() => null);
  if (!body || (body.reviewStatus === undefined && body.reviewNotes === undefined && body.reviewReasonCode === undefined)) {
    return c.json({ error: "Provide reviewStatus, reviewNotes and/or reviewReasonCode" }, 400);
  }
  if (body.reviewStatus !== undefined && !REVIEW_STATUSES.includes(body.reviewStatus as ReviewStatus)) {
    return c.json({ error: `reviewStatus must be one of ${REVIEW_STATUSES.join(", ")}` }, 400);
  }
  // AI INTELLIGENCE spec item 20: reviewReasonCode is OPTIONAL (see
  // REVIEW_REASON_CODES's own doc comment for why it's never forced), but
  // when supplied it must be a real code — null explicitly clears it.
  if (
    body.reviewReasonCode !== undefined &&
    body.reviewReasonCode !== null &&
    !REVIEW_REASON_CODES.includes(body.reviewReasonCode as ReviewReasonCode)
  ) {
    return c.json({ error: `reviewReasonCode must be one of ${REVIEW_REASON_CODES.join(", ")}, or null` }, 400);
  }

  const opportunity = await db.queryFirst<OpportunityRow>(`SELECT id FROM opportunities WHERE id = ?`, id);
  if (!opportunity) return c.json({ error: "Not found" }, 404);

  await updateOpportunityReview(db, id, {
    reviewStatus: body.reviewStatus as ReviewStatus | undefined,
    reviewNotes: body.reviewNotes,
    reviewReasonCode: body.reviewReasonCode as ReviewReasonCode | null | undefined,
  });

  const updated = await db.queryFirst<OpportunityRow>(`SELECT * FROM opportunities WHERE id = ?`, id);
  return c.json({ opportunity: updated });
});

// AI INTELLIGENCE spec items 19-20 (learning database): the full history of
// review decisions recorded against this opportunity, each with an
// immutable copy of what the opportunity looked like at that moment — see
// captureLearningReviewSnapshot's doc comment in opportunitiesRepo.ts.
opportunitiesRoute.get("/:id/learning-snapshots", async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param("id");
  const snapshots = await listLearningReviewSnapshots(db, id);
  return c.json({ snapshots });
});

// SOURCING WORKFLOW item 15 built this as an optional AI-advisory
// interface stub, not a live integration, proving the interface was
// genuinely pluggable end-to-end against real per-opportunity data (not
// just declared in a types file nothing calls) — always returning the
// same honest "not connected" response via NullAiAdvisoryProvider. AI
// INTELLIGENCE spec Phase 2, Workstream J replaces that stub with a real
// implementation: `buildAdvisoryProvider()` below assembles the full
// chain — createAiModelProvider (Workstream F: NullAiModelProvider when
// no OPENAI_API_KEY is set, otherwise a real OpenAiModelProvider) ->
// AiCompletionCache (Workstream G: D1 caching + daily spend cap, per the
// live `settings.ai` row) -> GuardedAiModelProvider (Workstream I:
// rejects any response that contradicts this opportunity's own computed
// numbers) -> AiListingAnalystProvider (Workstream J itself). Built fresh
// PER REQUEST, not at module scope, since it depends on c.env (the
// binding-scoped API key) and live Settings — the exact same reason `db`
// is constructed inside every route handler in this file rather than
// once at module load. Still on-demand only (the UI fetches it on a
// button click, not on page load) — see AiAdvisoryPanel in
// OpportunityDetail.tsx.
function buildAdvisoryProvider(env: Env, db: Db, settings: Awaited<ReturnType<typeof loadSettings>>) {
  const modelProvider = createAiModelProvider(env);
  const cached = new AiCompletionCache(db, modelProvider, {
    dailySpendCapUsd: settings.ai.dailySpendCapUsd,
    pricing: settings.ai.pricingUsdPerMTok,
    scanRunId: null,
  });
  const guarded = new GuardedAiModelProvider(cached);
  return new AiListingAnalystProvider(guarded);
}

// buildAdvisoryEconomicsFacts / buildAdvisoryEvidence: moved to
// ../ai/advisoryEvidence.ts (gap 3, AI INTELLIGENCE) — scanRunner.ts needed
// the same pure functions for the new selective-AI-review pipeline step and
// must not import from routes/, so both now share that module. Imported
// above; see that file's doc comment for the full rationale. Tests moved
// with them — see apps/worker/test/advisoryEconomicsFacts.test.ts.

opportunitiesRoute.get("/:id/advisory", async (c) => {
  const db = new Db(c.env.DB);
  const id = c.req.param("id");

  const opportunity = await db.queryFirst<OpportunityRow>(`SELECT * FROM opportunities WHERE id = ?`, id);
  if (!opportunity) return c.json({ error: "Not found" }, 404);

  const [card, listing, settings] = await Promise.all([
    db.queryFirst<CardRow>(`SELECT * FROM cards WHERE id = ?`, opportunity.card_id),
    db.queryFirst<EbayListingRow>(`SELECT * FROM ebay_listings WHERE id = ?`, opportunity.listing_id),
    loadSettings(db),
  ]);

  const aiAdvisoryProvider = buildAdvisoryProvider(c.env, db, settings);

  const advisory = await aiAdvisoryProvider.getAdvisory({
    opportunityId: opportunity.id,
    cardName: card?.name ?? "Unknown card",
    strategy: opportunity.strategy as "FLIP" | "GRADE",
    listingTitle: listing?.title ?? "",
    listingPrice: opportunity.listing_price,
    totalAcquisitionCost: opportunity.total_acquisition_cost,
    reasoning: opportunity.reasoning ? JSON.parse(opportunity.reasoning) : [],
    economicsFacts: buildAdvisoryEconomicsFacts(opportunity),
    ...buildAdvisoryEvidence(listing),
  });

  return c.json({ advisory, providerName: aiAdvisoryProvider.name });
});
