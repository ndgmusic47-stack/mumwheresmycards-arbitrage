import { Link } from "react-router-dom";
import type { OpportunityListItem, OpportunityQueryParams, OpportunitySortKey } from "../api/client";
import { ScoreBadge, StateBadge, EconomicClassBadge } from "./ScoreBadge";
import { groupRowsByKey } from "@mwmc/core";

/**
 * SOURCING WORKFLOW item 16: everything Opportunity Detail needs to offer
 * "← Previous / Next →" through the SAME filtered/sorted/paged queue the
 * user was browsing, including being able to fetch the adjacent PAGE when
 * the user runs off either end of the current one (`queryParams` is exactly
 * what was passed to fetchOpportunities to produce `ids`, minus `page`
 * itself, so the detail page can request page±1 with everything else held
 * constant). Carried via React Router's navigation `state`, not the URL —
 * it's a browsing aid, not something that should survive a bookmark/refresh
 * (which correctly falls back to no prev/next, rather than showing stale
 * neighbours from a query that's no longer being run).
 */
export interface OpportunityBrowseQueue {
  ids: string[];
  page: number;
  pageCount: number;
  total: number;
  limit: number;
  /**
   * OPTIONAL since 2026-09-12, so a queue can come from somewhere that is not
   * a paged table.
   *
   * The Pipeline's columns are single, complete lists — every saved lead, every
   * card under offer — with no page after them and no query to re-run. They
   * still deserve Previous/Next (opening a card from Pipeline used to strand
   * you there, which is what prompted this), so they build a queue with
   * `pageCount: 1` and no query params. `jumpToPage` refuses to run without
   * them rather than guessing a query, which is why it cannot fabricate
   * neighbours from a list it does not understand.
   */
  queryParams?: OpportunityQueryParams;
  /** What these rows ARE, for the "3 of 12 …" line. Defaults to matching opportunities. */
  label?: string;
}

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : currency.format(n));
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(0)}%`);
const days = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n)}d`);
const profitClass = (n: number | null | undefined) =>
  n === null || n === undefined ? "" : n >= 0 ? "profit-positive" : "profit-negative";

/** SOURCING WORKFLOW item 3: what the table needs to restore/track the
 *  user's sourcing session — which sort is active (so header arrows render
 *  correctly), a callback to change it, which row (if any) was last opened,
 *  and a callback fired right before navigating to Opportunity Detail so the
 *  scroll position and row id can be captured. All optional so this
 *  component still works anywhere it's used without wiring the full
 *  session-state machinery (e.g. a future embedded use). */
export interface TableSessionProps {
  sort?: OpportunitySortKey;
  dir?: "asc" | "desc";
  onSort?: (key: OpportunitySortKey) => void;
  /**
   * The listing whose eBay page was opened most recently, highlighted so the
   * user can see where they were when they come back from eBay. Rebuilt
   * 2026-09-09: this used to be set only when the in-tool detail page was
   * opened, which is not how the user actually works — they click the eBay
   * "View" link straight from the table.
   */
  lastViewedId?: string | null;
  /** Fired just before navigating away (detail page, or the eBay link) so
   *  the caller can capture scroll position and which row it was. */
  onOpen?: (id: string) => void;
  /**
   * 2026-09-09 Save/Pass. Records the user's decision on THIS listing without
   * leaving the table. Save marks it INTERESTED (it then appears in Pipeline
   * under "Saved"); Pass marks it PASS and it drops out of the working feed
   * for good, including after later scans — see buildFilterConditions'
   * excludeReviewStatus, and upsertOpportunity's ON CONFLICT clause, which
   * never overwrites a human decision.
   */
  onDecide?: (id: string, status: "INTERESTED" | "PASS") => void;
  /** Ids currently mid-save, so the buttons can show progress and not be
   *  double-fired. */
  decidingIds?: Set<string>;
  /** Item 16's queue — omit to render the table exactly as before with no
   *  prev/next context passed to Opportunity Detail. */
  browseQueue?: OpportunityBrowseQueue;
}

/**
 * SOURCING WORKFLOW item 12 (same-card grouping without over-suppression):
 * flattens `groupRowsByKey`'s output back into the exact row order the
 * table already renders in (server sort untouched — the "primary" of each
 * group is just whichever row came first in that order), annotating each
 * row with how many total listings share its card_id so FlipTable/
 * GradeTable can badge the first one and lightly distinguish the rest.
 * Every row from the input is still present exactly once — nothing here
 * ever removes a row from the table, only how it's labelled.
 */
function withGroupInfo(
  opportunities: OpportunityListItem[],
): { o: OpportunityListItem; groupSize: number; isSecondaryInGroup: boolean }[] {
  const groups = groupRowsByKey(opportunities, (o) => o.card_id);
  return groups.flatMap((g) => {
    const groupSize = 1 + g.others.length;
    return [
      { o: g.primary, groupSize, isSecondaryInGroup: false },
      ...g.others.map((o) => ({ o, groupSize, isSecondaryInGroup: true })),
    ];
  });
}

/**
 * FLIP and GRADE are different trades with different economics, so they get
 * different tables rather than one table of mostly-empty shared columns.
 * Each row shows enough to judge the trade in seconds — including the
 * downside, which is never hidden.
 */
export function OpportunityTable({
  opportunities,
  ...session
}: { opportunities: OpportunityListItem[] } & TableSessionProps) {
  if (opportunities.length === 0) {
    return <p className="empty-state">No opportunities match the current filters.</p>;
  }

  const flips = opportunities.filter((o) => o.strategy === "FLIP");
  const grades = opportunities.filter((o) => o.strategy === "GRADE");

  return (
    <>
      {flips.length > 0 && <FlipTable opportunities={flips} {...session} />}
      {grades.length > 0 && <GradeTable opportunities={grades} {...session} />}
    </>
  );
}

function SortableTh({
  label,
  sortKey,
  title,
  session,
}: {
  label: string;
  sortKey: OpportunitySortKey;
  title?: string;
  session: TableSessionProps;
}) {
  const active = session.sort === sortKey;
  const arrow = active ? (session.dir === "asc" ? "▲" : "▼") : "";
  if (!session.onSort) {
    return <th title={title}>{label}</th>;
  }
  return (
    <th
      title={title ? `${title} — click to sort` : "Click to sort"}
      className="sortable-th"
      onClick={() => session.onSort!(sortKey)}
    >
      {label}
      {arrow && <span className="sort-arrow">{arrow}</span>}
    </th>
  );
}

/**
 * The link the user actually uses. `onView` fires on click so the caller can
 * persist page/filters/sort/scroll and mark this row as the one being looked
 * at — the whole round trip (scroll, View, come back, decide) depends on it.
 *
 * The link still opens in a new tab, so in practice the tool's own tab isn't
 * unloaded at all and the position is already intact; capturing on click is
 * what makes it survive the case where it IS (middle-click into the same tab,
 * a browser that reuses the tab, or a later reload), and it's what supplies
 * the highlight either way.
 */
function EbayLink({ url, id, onView }: { url: string; id: string; onView?: (id: string) => void }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="ebay-link"
      onClick={() => onView?.(id)}
    >
      View
    </a>
  );
}

/**
 * Save / Pass, in the row. Deliberately here rather than only on the detail
 * page: the user's real loop is scroll -> View on eBay -> come back -> decide,
 * and forcing a detour through the detail page to record that decision was
 * the single biggest friction in it.
 */
function DecisionCell({
  o,
  session,
}: {
  o: OpportunityListItem;
  session: TableSessionProps;
}) {
  if (!session.onDecide) return <td />;
  const busy = session.decidingIds?.has(o.id) ?? false;
  const saved = o.review_status === "INTERESTED";
  const passed = o.review_status === "PASS";
  return (
    <td className="decision-cell">
      <button
        type="button"
        className={saved ? "decision-btn decision-btn-save is-active" : "decision-btn decision-btn-save"}
        disabled={busy}
        title={saved ? "Saved — showing in Pipeline. Click again to undo." : "Save this listing to Pipeline"}
        onClick={() => session.onDecide?.(o.id, "INTERESTED")}
      >
        {saved ? "Saved" : "Save"}
      </button>
      <button
        type="button"
        className={passed ? "decision-btn decision-btn-pass is-active" : "decision-btn decision-btn-pass"}
        disabled={busy}
        title={passed ? "Passed — hidden from your normal feed." : "Pass: hide this listing from your feed for good"}
        onClick={() => session.onDecide?.(o.id, "PASS")}
      >
        {passed ? "Passed" : "Pass"}
      </button>
    </td>
  );
}

/** STABILISATION item 6 (classification): an AUCTION's price is the
 *  CURRENT bid, not a guaranteed final cost (see the matching reasoning
 *  note the engine attaches to every AUCTION-derived candidate) — flagged
 *  here so it's visible without opening the detail page.
 *
 *  STABILISATION item 8 (freshness): a non-ACTIVE listing_status (currently
 *  only 'ENDED', for auctions past their end_time — see
 *  expireEndedAuctionListings()) is surfaced as its own tag rather than
 *  hidden — the opportunity stays visible, just honestly labelled. Every
 *  row also carries listing_fetched_at as a tooltip so "how fresh is this,
 *  really" is always one hover away instead of assumed.
 *
 *  SOURCING WORKFLOW item 14 (auction workflow): the actionable number on
 *  an auction is what you could bid up to, not the profit at the current
 *  bid — so an AUCTION row shows MAX BID, bid count and time remaining
 *  right here rather than leaving the user to work it out from the current
 *  price alone. max_bid is null on GRADE rows and on rows with no usable
 *  QSV reference — shown honestly as "not computed", never a fabricated
 *  number. Negative headroom (current bid already exceeds what the
 *  economics support) is shown as a warning, not silently hidden.
 *
 *  SOURCING WORKFLOW item 13 (listing category/quality badges):
 *  - CONDITION always renders — eBay's own `condition` field verbatim
 *    (typically "Ungraded"/"Graded" for this category, sometimes "New"/
 *    "Used"), or the literal "UNKNOWN" when eBay didn't report one. This is
 *    deliberately NOT relabelled to trading-card grades (NM/LP/MP/HP/
 *    DAMAGED) — eBay's basic search response doesn't carry that granularity
 *    (it lives, if anywhere, in per-listing `conditionDescriptors`/item
 *    aspects — item 9's two-stage enrichment, not yet built). Claiming a
 *    card-condition grade this data doesn't support is exactly what the
 *    spec's closing constraint forbids.
 *  - A listing eBay itself marks "Graded" gets an elevated WARNING tag, not
 *    a quiet label — this system still runs full raw-card FLIP/GRADE
 *    economics on it regardless (a confirmed, currently-open gap — see the
 *    STABILISATION release test's case 3 and the project doc's "already-
 *    graded slab detection" item), so the number in this row may not mean
 *    what it looks like it means. RAW/LOT/SEALED are not called out as
 *    their own badges: "RAW" is simply the absence of the GRADED warning
 *    (nothing to flag), and there is no LOT/SEALED detector in this
 *    codebase at all yet (a confirmed gap, not a silent omission) — badging
 *    either would fabricate a detection this tool doesn't actually do. */
/**
 * 2026-09-09: the max-bid line, now computed for GRADE auctions too.
 *
 * It previously read "Max bid: not computed" on every GRADE row — the worst
 * possible moment to say nothing, because an auction is closing and the user
 * is doing arithmetic under time pressure. That is exactly when people
 * overpay.
 *
 * The two strategies answer DIFFERENT questions, so this never prints a bare
 * number: `max_bid_basis` decides the wording.
 *
 *  - FLIP_QUALIFICATION — the highest bid still clearing the flip profit and
 *    ROC bars.
 *  - PSA7_BREAKEVEN — the highest bid at which a PSA 7 outcome still returns
 *    your money. NOT "this qualifies"; grades 8/9/10 are upside above it.
 *    See the derivation comment in apps/worker/src/routes/opportunities.ts
 *    for why the arithmetic is exact rather than an estimate.
 */
function MaxBidTag({ o }: { o: OpportunityListItem }) {
  if (o.max_bid === null) {
    return (
      <div
        className="hint-tag"
        title={
          o.strategy === "GRADE"
            ? "No PSA 7 profit figure on this row yet, so there is nothing to solve a break-even bid against."
            : "No usable QSV reference to solve a max bid against yet"
        }
      >
        Max bid: not computed
      </div>
    );
  }

  const breakEven = o.max_bid_basis === "PSA7_BREAKEVEN";
  const exceeded = o.headroom_vs_current_price !== null && o.headroom_vs_current_price < 0;

  if (exceeded) {
    return (
      <div
        className="warn-tag"
        title={
          breakEven
            ? `The current bid (£${o.listing_price.toFixed(2)}) is already above the £${o.max_bid.toFixed(2)} at which a PSA 7 would return your money. Above this price you are relying on a grade better than 7.`
            : `The current bid (£${o.listing_price.toFixed(2)}) already exceeds the £${o.max_bid.toFixed(2)} that would still clear the profit/ROC bar — this trade is no longer supported by the economics at this price.`
        }
      >
        Max bid: {money(o.max_bid)} — already exceeded
      </div>
    );
  }

  return (
    <div
      className="hint-tag"
      title={
        breakEven
          ? "Bid up to this and a PSA 7 still returns your money — grades 8, 9 and 10 are upside on top. Bid above it and the trade starts depending on a better grade. Excludes postage, tax and fees, which are already accounted for separately."
          : "The highest bid (before postage/tax/fees) that would still clear the current profit and ROC qualification bar"
      }
    >
      Max bid: {money(o.max_bid)}
      {breakEven && <span className="max-bid-basis"> to break even at PSA 7</span>}
    </div>
  );
}

function ListingMeta({ o }: { o: OpportunityListItem }) {
  return (
    <>
      <NonUkImportWarning countryCode={o.listing_location_country} />
      {o.listing_type === "AUCTION" && (
        <>
          <div className="warn-tag" title="Price shown is the CURRENT bid — it may rise before the auction ends">
            AUCTION
            {o.listing_bids !== null && ` · ${o.listing_bids} bid${o.listing_bids === 1 ? "" : "s"}`}
            {o.listing_end_time && ` · ${formatTimeRemaining(o.listing_end_time)}`}
          </div>
          <MaxBidTag o={o} />
        </>
      )}
      {o.listing_status !== "ACTIVE" && (
        <div className="warn-tag" title={`Listing status: ${o.listing_status}`}>
          {o.listing_status}
        </div>
      )}
      {o.listing_item_condition === "Graded" ? (
        <div
          className="warn-tag"
          title="eBay lists this item's condition as Graded — the profit numbers on this row still assume a RAW card. Verify from the listing before relying on them."
        >
          LISTED AS GRADED
        </div>
      ) : (
        <div className="hint-tag" title="eBay's own condition field, as reported — never inferred or upgraded to a trading-card grade">
          Condition: {o.listing_item_condition ?? "UNKNOWN"}
        </div>
      )}
      {/* SOURCING WORKFLOW item 9: signals a listing has been through the
          deeper "Get Item" condition check (small, budgeted subset only —
          see scanRunner.ts). Just a pointer to the detail page, not the
          raw descriptor data itself — that stays on the detail page where
          there's room to caveat it properly. */}
      {o.listing_enriched_at && (
        <div className="hint-tag" title="This listing has been through eBay's deeper 'Get Item' condition check — see the opportunity detail page for what it found">
          eBay condition checked
        </div>
      )}
      <div className="hint-tag" title="Last time this exact listing was re-observed in a search">
        seen {formatFetchedAt(o.listing_fetched_at)}
      </div>
    </>
  );
}

/**
 * MWMC V1 FINAL SHIP PASS item 10 (import-cost safety): ARCHITECTURE.md's
 * "Known gaps to verify before going live" documents that forecast
 * `importTax`/`acquisitionFees` are honoured fields the economics engine
 * correctly applies when present, but NOTHING in the live scan pipeline
 * ever populates them — every FLIP/GRADE forecast on this dashboard
 * silently assumes £0 import tax and £0 other acquisition fees, with no
 * prior indication of that anywhere in the UI. That's a real risk
 * specifically for a listing whose seller/item isn't in the UK: a genuine
 * import-duty/customs charge could turn an apparently-profitable trade
 * unprofitable, and nothing on this page would have said so.
 *
 * This is deliberately a UI-only warning, not a new engine state (unlike
 * REVIEW_ALREADY_GRADED/REVIEW_LIKELY_LOT) — it doesn't change what's
 * QUALIFIED_FLIP/QUALIFIED_GRADE/WATCH, it just tells the human buyer to
 * verify the real landed cost themselves before acting, exactly like the
 * "LISTED AS GRADED" tag already does for a different silent-assumption
 * risk. Only fires on POSITIVE evidence — eBay's own structured
 * location_country present and not "GB" — never on a null/unknown location,
 * matching this codebase's standing "no signal is not a confirmation"
 * discipline (see listingStructure.ts / ListingMeta's own doc comment); an
 * unknown location stays silently unflagged, same as before this item.
 */
function NonUkImportWarning({ countryCode }: { countryCode: string | null }) {
  if (!countryCode || countryCode === "GB") return null;
  return (
    <div
      className="warn-tag"
      title={`eBay reports this listing's location as "${countryCode}", not the UK. Import tax and other acquisition fees are NOT modelled anywhere in this forecast (they default to £0) — verify the real landed cost yourself before buying.`}
    >
      IMPORT COST NOT MODELLED — VERIFY BEFORE BUYING
    </div>
  );
}

/** Renders listing_fetched_at (a D1 `datetime('now')` UTC string) as a
 *  rough relative age. Deliberately coarse (minutes/hours/days) — this is a
 *  freshness hint, not a precise timestamp, and coarseness avoids timezone
 *  edge cases mattering. Exported (SOURCING WORKFLOW item 10) so
 *  OpportunityDetail.tsx's "why is this priced this way" panel can reuse
 *  it for listing.created_at rather than re-deriving the same logic. */
export function formatFetchedAt(fetchedAt: string): string {
  const then = new Date(fetchedAt.includes("Z") || fetchedAt.includes("T") ? fetchedAt : `${fetchedAt.replace(" ", "T")}Z`);
  if (Number.isNaN(then.getTime())) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - then.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** SOURCING WORKFLOW item 14: renders listing_end_time (eBay's own
 *  end-of-auction timestamp) as a rough countdown. "Ended" rather than a
 *  negative duration once it's passed — the row may still be showing while
 *  listing_status hasn't caught up yet (see expireEndedAuctionListings,
 *  which runs once per scan, not continuously). */
function formatTimeRemaining(endTime: string): string {
  const end = new Date(endTime.includes("Z") || endTime.includes("T") ? endTime : `${endTime.replace(" ", "T")}Z`);
  if (Number.isNaN(end.getTime())) return "—";
  const minutes = Math.round((end.getTime() - Date.now()) / 60000);
  if (minutes <= 0) return "ended";
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}

function rowClassName(o: OpportunityListItem, lastViewedId: string | null | undefined): string | undefined {
  const classes: string[] = [];
  if (o.qualifies === 1) classes.push("row-qualified");
  if (lastViewedId && o.id === lastViewedId) classes.push("row-last-viewed");
  return classes.length > 0 ? classes.join(" ") : undefined;
}

function FlipTable({ opportunities, ...session }: { opportunities: OpportunityListItem[] } & TableSessionProps) {
  return (
    <div className="strategy-block">
      <h2 className="strategy-heading">
        RAW FLIP <span className="strategy-count">{opportunities.length}</span>
      </h2>
      <div className="table-scroll">
        <table className="opp-table">
          <thead>
            <tr>
              <SortableTh label="Score" sortKey="score" session={session} />
              <th>Card</th>
              <th>State</th>
              <SortableTh label="Listing" sortKey="listing_price" session={session} />
              <SortableTh
                label="Delivered cost"
                sortKey="delivered_cost"
                title="Item price + postage + tax + fees"
                session={session}
              />
              <SortableTh
                label="QSV"
                sortKey="qsv"
                title="Quick Sale Value: lower of the 7d/30d sold medians, less an 8% haircut"
                session={session}
              />
              <SortableTh
                label="Discount to QSV"
                sortKey="discount_to_qsv"
                title="How far below QSV the delivered cost sits"
                session={session}
              />
              <SortableTh
                label="True net profit"
                sortKey="net_profit"
                title="Net sale cash minus total acquisition — after eBay fees, fee VAT, postage and packaging"
                session={session}
              />
              <SortableTh label="ROC" sortKey="roc" title="True net profit / total acquisition" session={session} />
              <SortableTh label="Margin" sortKey="margin" title="True net profit / buyer payment" session={session} />
              <SortableTh label="Liquidity" sortKey="liquidity" session={session} />
              <SortableTh label="Confidence" sortKey="confidence" session={session} />
              <th title="Estimated days from purchase to completed sale">Days to sale</th>
              <SortableTh
                label="First seen"
                sortKey="first_seen"
                title="When this tool first found the listing. This is the dashboard's default order — newest first. (The old 'Newest' column sorted by when the listing was last re-checked, which moved old listings to the top whenever a scan happened to re-observe them.)"
                session={session}
              />
              <SortableTh
                label="Ends"
                sortKey="time_remaining"
                title="Auction end time. Click once for soonest-first — that is the auction working view. Fixed-price listings have no end time and always sort to the bottom."
                session={session}
              />
              <th>eBay</th>
              <th title="Save keeps this listing in Pipeline. Pass hides it from your feed permanently.">Decision</th>
            </tr>
          </thead>
          <tbody>
            {withGroupInfo(opportunities).map(({ o, groupSize, isSecondaryInGroup }) => (
              <tr
                key={o.id}
                id={`opp-row-${o.id}`}
                className={`${rowClassName(o, session.lastViewedId)}${isSecondaryInGroup ? " grouped-row" : ""}`}
              >
                <td>
                  <ScoreBadge score={o.score ?? o.flip_score} />
                </td>
                <CardCellWithSession
                  o={o}
                  onOpen={session.onOpen}
                  browseQueue={session.browseQueue}
                  groupCount={isSecondaryInGroup ? undefined : groupSize}
                />
                <td>
                  <StateBadge state={o.state} />
                  {o.is_high_confidence_qsv === 0 && (
                    <div className="warn-tag" title={o.qsv_basis ?? undefined}>
                      QSV from fallback reference, not sold medians
                    </div>
                  )}
                </td>
                <td>{money(o.listing_price)}</td>
                <td>{money(o.total_acquisition_cost)}</td>
                <td>{money(o.qsv)}</td>
                <td>{o.qsv ? pct(Math.max(0, (o.qsv - o.total_acquisition_cost) / o.qsv)) : "—"}</td>
                <td className={profitClass(o.expected_net_profit)}>{money(o.expected_net_profit)}</td>
                <td className={profitClass(o.return_on_capital)}>{pct(o.return_on_capital)}</td>
                <td>{pct(o.profit_margin)}</td>
                <td>{o.liquidity}</td>
                <td>{pct(o.confidence)}</td>
                <td>{days(o.days_to_sale_estimate)}</td>
                <td title={`Last re-checked ${formatFetchedAt(o.listing_fetched_at)}`}>{formatFetchedAt(o.listing_first_seen)}</td>
                <td>{o.listing_end_time ? formatTimeRemaining(o.listing_end_time) : "—"}</td>
                <td>
                  <EbayLink url={o.listing_item_url} id={o.id} onView={session.onOpen} />
                  <ListingMeta o={o} />
                </td>
                <DecisionCell o={o} session={session} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** CardCell that records "this was the row I opened" before navigating
 *  (see Dashboard.tsx's handling of TableSessionProps.onOpen — persisted to
 *  sessionStorage and restored on return, item 3) and, when a browse queue
 *  is available, hands Opportunity Detail exactly enough state to offer
 *  Previous/Next through the same queue (item 16). */
function CardCellWithSession({
  o,
  onOpen,
  browseQueue,
  /** SOURCING WORKFLOW item 12 — only passed for a group's PRIMARY row when
   *  more than one listing shares this card_id; renders a small pointer to
   *  the others rather than leaving them looking like unrelated repeats. */
  groupCount,
}: {
  o: OpportunityListItem;
  onOpen?: (id: string) => void;
  browseQueue?: OpportunityBrowseQueue;
  groupCount?: number;
}) {
  // `from` carries the exact view being left — pathname AND query string —
  // so OpportunityDetail's Back can return to THIS tab's results even when
  // there is no history entry to go back to (a refresh on the detail page,
  // or arriving from a shared link). Without it the fallback was a bare "/",
  // which lands on the Opportunities tab regardless of where you started.
  const from = typeof window !== "undefined" ? window.location.pathname + window.location.search : undefined;
  const navState = { queue: browseQueue, index: browseQueue ? browseQueue.ids.indexOf(o.id) : undefined, from };
  return (
    <td>
      <Link to={`/opportunity/${o.id}`} state={navState} onClick={() => onOpen?.(o.id)}>
        {o.card_name} — {o.card_set_name} #{o.card_number}
      </Link>
      <div className="card-variant-tag">
        {o.card_edition !== "na" ? o.card_edition + " " : ""}
        {o.card_finish !== "na" ? o.card_finish + " " : ""}
        {o.card_variant}
      </div>
      {groupCount !== undefined && groupCount > 1 && (
        <div className="hint-tag" title="Other listings for this exact same card printing, shown in the rows directly below — every one is a real, separate opportunity, none are hidden.">
          +{groupCount - 1} more listing{groupCount - 1 === 1 ? "" : "s"} for this card ↓
        </div>
      )}
      <ReviewStatusTag status={o.review_status} />
      <AiFlagTag status={o.ai_review_status} reason={o.ai_review_reason} confidence={o.ai_review_confidence} />
    </td>
  );
}

/**
 * MWMC V1 FINAL SHIP PASS item 2: makes an AI REVIEW/BLOCK_FROM_ACTIONABLE
 * row INSPECTABLE right where it's shown — its AI route, confidence and
 * reason — rather than it simply disappearing from the ACTIONABLE feed with
 * no trace (see routes/opportunities.ts's includeAiFlagged gate and
 * FilterBar.tsx's "Include AI-flagged" toggle, which is what makes these
 * rows visible here in the first place). PASS_THROUGH and null both mean "no
 * objection" and render nothing — same "only earns its place once it says
 * something" discipline as ReviewStatusTag just above. This never reflects
 * or alters state/qualifies/economics — see applyAiCandidateReview's own
 * doc comment for the structural guarantee AI can only ever write these 4
 * columns.
 */
function AiFlagTag({
  status,
  reason,
  confidence,
}: {
  status: "PASS_THROUGH" | "REVIEW" | "BLOCK_FROM_ACTIONABLE" | null;
  reason: string | null;
  confidence: number | null;
}) {
  if (status !== "REVIEW" && status !== "BLOCK_FROM_ACTIONABLE") return null;
  const label = status === "BLOCK_FROM_ACTIONABLE" ? "AI: BLOCKED" : "AI: REVIEW";
  const confidencePct = confidence === null ? null : Math.round(confidence * 100);
  const title = [
    status === "BLOCK_FROM_ACTIONABLE"
      ? "AI routed this candidate to BLOCK — hidden from the Actionable feed by default."
      : "AI routed this candidate to REVIEW — hidden from the Actionable feed by default.",
    confidencePct !== null ? `Confidence: ${confidencePct}%.` : null,
    reason ? `Reason: ${reason}` : null,
    "This is an AI opinion only — it never changes the computed state, qualification, or economics above; open the opportunity for full detail.",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="warn-tag" title={title}>
      {label}
      {confidencePct !== null && ` (${confidencePct}%)`}
    </div>
  );
}

/**
 * SOURCING WORKFLOW item 17: the user's own manual sourcing decision,
 * separate from the engine's computed state. UNREVIEWED (the default for
 * essentially every row) renders nothing — a tag on ~1,300 unreviewed rows
 * would be pure noise; the badge only earns its place once a human has
 * actually acted on the row. Set from the opportunity detail page.
 */
function ReviewStatusTag({ status }: { status: string }) {
  if (status === "UNREVIEWED" || !status) return null;
  const className =
    status === "CHECKED"
      ? "review-tag review-checked"
      : status === "INTERESTED"
        ? "review-tag review-interested"
        : status === "UNDER_OFFER"
          ? "review-tag review-under-offer"
          : status === "BOUGHT"
            ? "review-tag review-bought"
            : "review-tag review-pass"; // PASS, and any unrecognised value
  const label = status === "PASS" ? "PASSED" : status.replace(/_/g, " ");
  return (
    <div className={className} title="Your own sourcing status for this opportunity — set from the detail page, not computed">
      {label}
    </div>
  );
}

/**
 * STABILISATION item 10: REVIEW / NEAR_MISS / REJECTED rows don't fit the
 * FLIP/GRADE economics tables — many of their economics fields are null by
 * construction (no market data, identity uncertain, a computation error).
 * Forcing them through FlipTable/GradeTable would print a wall of "—".
 * Instead this surfaces the one thing that actually explains each row: the
 * already-fetched-but-previously-unused `qualification_failures` field the
 * engine attaches to every non-qualifying candidate.
 */
export function ReasonsTable({
  opportunities,
  emptyMessage,
  ...session
}: { opportunities: OpportunityListItem[]; emptyMessage?: string } & TableSessionProps) {
  if (opportunities.length === 0) {
    // SOURCING WORKFLOW item 18: the generic default is wrong for the
    // REJECTED category specifically (see FilterBar's own hint) — "no
    // opportunities match the current filters" reads as "nothing was
    // rejected," when actually rejected candidates are never stored at all.
    // Callers that know the real reason pass a more accurate message.
    return <p className="empty-state">{emptyMessage ?? "No opportunities match the current filters."}</p>;
  }

  return (
    <div className="table-scroll">
      <table className="opp-table">
        <thead>
          <tr>
            <th>Card</th>
            <th>State</th>
            <th>Strategy</th>
            <SortableTh label="Listing price" sortKey="listing_price" session={session} />
            <th>Reasons</th>
            <th>eBay</th>
              <th title="Save keeps this listing in Pipeline. Pass hides it from your feed permanently.">Decision</th>
          </tr>
        </thead>
        <tbody>
          {opportunities.map((o) => (
            <tr key={o.id} id={`opp-row-${o.id}`} className={rowClassName(o, session.lastViewedId)}>
              <CardCellWithSession o={o} onOpen={session.onOpen} browseQueue={session.browseQueue} />
              <td>
                <StateBadge state={o.state} />
              </td>
              <td>{o.strategy}</td>
              <td>{money(o.listing_price)}</td>
              <td>
                <ReasonsList raw={o.qualification_failures} />
              </td>
              <td>
                <EbayLink url={o.listing_item_url} id={o.id} onView={session.onOpen} />
                <ListingMeta o={o} />
              </td>
              <DecisionCell o={o} session={session} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReasonsList({ raw }: { raw: string | null }) {
  const reasons = parseReasons(raw);
  if (reasons.length === 0) return <span>—</span>;
  return (
    <ul className="reasons-list">
      {reasons.map((r, i) => (
        <li key={i}>{r}</li>
      ))}
    </ul>
  );
}

/** qualification_failures is stored as a JSON array of QualificationFailure
 *  objects (`{ rule, reason }` — see packages/core/src/filters/types.ts),
 *  NOT plain strings. Bug fixed 2026-09-03 (MWMC V1 FINAL SHIP PASS live
 *  verification): this used to blind-`String()` each array entry, which on
 *  an object literal renders "[object Object]" — every WATCH/rejected row's
 *  reasons column was unreadable before this fix, silently, since a near-miss
 *  was never surfaced in the UI to catch it. Falls back to an empty list
 *  rather than throwing on unexpected content, same defensiveness as the
 *  detail page's grade_rungs parsing. */
function parseReasons(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [String(parsed)];
    return parsed.map((r) => (r && typeof r === "object" && "reason" in r ? String((r as { reason: unknown }).reason) : String(r)));
  } catch {
    return [raw];
  }
}

function GradeTable({ opportunities, ...session }: { opportunities: OpportunityListItem[] } & TableSessionProps) {
  return (
    <div className="strategy-block">
      <h2 className="strategy-heading">
        RAW → GRADED <span className="strategy-count">{opportunities.length}</span>
      </h2>
      <div className="table-scroll">
        <table className="opp-table">
          <thead>
            <tr>
              <SortableTh label="Score" sortKey="score" session={session} />
              <th>Card</th>
              <th title="The economic structure of this trade — see the rationale on the detail page">Class</th>
              <th>Raw price</th>
              <SortableTh
                label="Delivered raw"
                sortKey="delivered_cost"
                title="Item price + postage + tax + fees"
                session={session}
              />
              <th>Service</th>
              <SortableTh
                label="Graded basis"
                sortKey="graded_basis"
                title="Everything committed to get one saleable slab, including this card's share of batch logistics"
                session={session}
              />
              <SortableTh
                label="Break-even"
                sortKey="break_even_grade"
                title="Lowest grade at which this trade breaks even"
                session={session}
              />
              {/* 2026-09-09: these four were headed "PSA7".."PSA10" while the
                  cells show PROFIT in pounds. Read as slab VALUES they look
                  absurd — a "PSA7" of £20 next to a £40 raw price — which is
                  exactly the misreading that destroys trust in the numbers.
                  The word "profit" is now in the header, and the real slab
                  values are on the detail page's ladder. */}
              {/* 2026-09-11: PSA 6 was computed, stored and sent to the browser
                  since it was built, and never displayed. PSA 6 and 7 are
                  now sortable, because ranking by the FLOOR — what a card
                  pays at its worst realistic grade — is the ordering this
                  tool's strategy actually needs, and only PSA 9/10 could be
                  sorted before. */}
              <SortableTh label="PSA 6 profit" sortKey="psa6_profit" title="THE FLOOR. Sort by this to rank cards by how much they pay at the LOWEST grade — money back on a bad outcome, with 8, 9 and 10 as upside on top. This is the ordering that matches a break-even-at-6-or-7 strategy." session={session} />
              <SortableTh label="PSA 7 profit" sortKey="psa7_profit" title="THE FLOOR. Sort by this to rank cards by how much they pay at the LOWEST grade — money back on a bad outcome, with 8, 9 and 10 as upside on top. This is the ordering that matches a break-even-at-6-or-7 strategy." session={session} />
              <th title="PROFIT at this grade — not what the slab is worth. It is net sale proceeds at this grade minus everything committed (card + postage + grading fee + batch share + consumables). Open the row for the slab's actual market value, selling fees and net proceeds.">PSA 8 profit</th>
              <SortableTh label="PSA 9 profit" sortKey="psa9_profit" title="PROFIT at this grade — not what the slab is worth. It is net sale proceeds at this grade minus everything committed (card + postage + grading fee + batch share + consumables). Open the row for the slab's actual market value, selling fees and net proceeds." session={session} />
              <SortableTh label="PSA 10 profit" sortKey="psa10_profit" title="PROFIT at this grade — not what the slab is worth. It is net sale proceeds at this grade minus everything committed (card + postage + grading fee + batch share + consumables). Open the row for the slab's actual market value, selling fees and net proceeds." session={session} />
              <SortableTh
                label="Capital lock"
                sortKey="capital_lock"
                title="Grading turnaround plus estimated time to sell — an estimate"
                session={session}
              />
              <SortableTh label="Liquidity" sortKey="liquidity" session={session} />
              <SortableTh label="Confidence" sortKey="confidence" session={session} />
              {/* 2026-09-09: Grade had no date column at all, while Flip did.
                  Same column, same sort key, same meaning on both tabs. */}
              <SortableTh
                label="First seen"
                sortKey="first_seen"
                title="When this tool first found the listing. This is the dashboard's default order — newest first."
                session={session}
              />
              <SortableTh
                label="Ends"
                sortKey="time_remaining"
                title="Auction end time. Click once for soonest-first — that is the auction working view. Fixed-price listings have no end time and always sort to the bottom."
                session={session}
              />
              <th>eBay</th>
              <th title="Save keeps this listing in Pipeline. Pass hides it from your feed permanently.">Decision</th>
            </tr>
          </thead>
          <tbody>
            {withGroupInfo(opportunities).map(({ o, groupSize, isSecondaryInGroup }) => (
              <tr
                key={o.id}
                id={`opp-row-${o.id}`}
                className={`${rowClassName(o, session.lastViewedId)}${isSecondaryInGroup ? " grouped-row" : ""}`}
              >
                <td>
                  <ScoreBadge score={o.score ?? o.grade_score} />
                </td>
                <CardCellWithSession
                  o={o}
                  onOpen={session.onOpen}
                  browseQueue={session.browseQueue}
                  groupCount={isSecondaryInGroup ? undefined : groupSize}
                />
                <td>
                  <EconomicClassBadge economicClass={o.economic_class} />
                  <div className="state-sub">
                    <StateBadge state={o.state} />
                  </div>
                </td>
                <td>{money(o.listing_price)}</td>
                <td>{money(o.total_acquisition_cost)}</td>
                <td>
                  {o.grading_service_name ?? "—"}
                  {o.potential_upcharge === 1 && (
                    <div className="warn-tag" title="A grade's slab value exceeds this service's declared-value cap — the submission may be upcharged. Exact cost unknown before submission.">
                      POTENTIAL UPCHARGE
                    </div>
                  )}
                  {o.better_velocity_service_id && (
                    <div className="hint-tag" title="A different enabled service returns capital faster per day — estimates only.">
                      Faster: {o.better_velocity_service_id}
                    </div>
                  )}
                </td>
                <td>{money(o.total_graded_basis)}</td>
                <td>{o.break_even_grade ? `PSA ${o.break_even_grade}` : "None"}</td>
                <td className={profitClass(o.psa6_profit)}>{money(o.psa6_profit)}</td>
                <td className={profitClass(o.psa7_profit)}>{money(o.psa7_profit)}</td>
                <td className={profitClass(o.psa8_profit)}>{money(o.psa8_profit)}</td>
                <td className={profitClass(o.psa9_profit)}>{money(o.psa9_profit)}</td>
                <td className={profitClass(o.psa10_profit)}>{money(o.psa10_profit)}</td>
                <td>{days(o.estimated_capital_lock_days)}</td>
                <td>{o.liquidity}</td>
                <td>{pct(o.confidence)}</td>
                <td title={`Last re-checked ${formatFetchedAt(o.listing_fetched_at)}`}>{formatFetchedAt(o.listing_first_seen)}</td>
                <td>{o.listing_end_time ? formatTimeRemaining(o.listing_end_time) : "—"}</td>
                <td>
                  <EbayLink url={o.listing_item_url} id={o.id} onView={session.onOpen} />
                  <ListingMeta o={o} />
                </td>
                <DecisionCell o={o} session={session} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
