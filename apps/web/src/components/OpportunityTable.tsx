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
  queryParams: OpportunityQueryParams;
}

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : currency.format(n));
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(0)}%`);
const pct1 = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);
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
  lastViewedId?: string | null;
  onOpen?: (id: string) => void;
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

function EbayLink({ url }: { url: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="ebay-link">
      View
    </a>
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
function ListingMeta({ o }: { o: OpportunityListItem }) {
  return (
    <>
      {o.listing_type === "AUCTION" && (
        <>
          <div className="warn-tag" title="Price shown is the CURRENT bid — it may rise before the auction ends">
            AUCTION
            {o.listing_bids !== null && ` · ${o.listing_bids} bid${o.listing_bids === 1 ? "" : "s"}`}
            {o.listing_end_time && ` · ${formatTimeRemaining(o.listing_end_time)}`}
          </div>
          {o.max_bid === null ? (
            <div className="hint-tag" title="No usable QSV reference to solve a max bid against yet">
              Max bid: not computed
            </div>
          ) : o.headroom_vs_current_price !== null && o.headroom_vs_current_price < 0 ? (
            <div
              className="warn-tag"
              title={`The current bid (£${o.listing_price.toFixed(2)}) already exceeds the £${o.max_bid.toFixed(2)} that would still clear the profit/ROC bar — this trade is no longer supported by the economics at this price.`}
            >
              Max bid: {money(o.max_bid)} — already exceeded
            </div>
          ) : (
            <div className="hint-tag" title="The highest bid (before postage/tax/fees) that would still clear the current profit and ROC qualification bar">
              Max bid: {money(o.max_bid)}
            </div>
          )}
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
              <SortableTh label="Newest" sortKey="newest" title="Last time this listing was seen" session={session} />
              <th>eBay</th>
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
                <td>{formatFetchedAt(o.listing_fetched_at)}</td>
                <td>
                  <EbayLink url={o.listing_item_url} />
                  <ListingMeta o={o} />
                </td>
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
  const navState = browseQueue ? { queue: browseQueue, index: browseQueue.ids.indexOf(o.id) } : undefined;
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
    </td>
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
        : status === "BOUGHT"
          ? "review-tag review-bought"
          : "review-tag review-pass"; // PASS, and any unrecognised value
  const label = status === "PASS" ? "PASSED" : status;
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
                <EbayLink url={o.listing_item_url} />
                <ListingMeta o={o} />
              </td>
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

/** qualification_failures is stored as a JSON array of strings — falls back
 *  to an empty list rather than throwing on unexpected content, same
 *  defensiveness as the detail page's grade_rungs parsing. */
function parseReasons(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
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
              <th>PSA7</th>
              <th>PSA8</th>
              <SortableTh label="PSA9" sortKey="psa9_profit" session={session} />
              <SortableTh label="PSA10" sortKey="psa10_profit" session={session} />
              <th title="How often this must come back a PSA 10 to break even, if every other one grades PSA 9. REQUIRED, not predicted.">
                Req. 10 rate
              </th>
              <SortableTh
                label="Capital lock"
                sortKey="capital_lock"
                title="Grading turnaround plus estimated time to sell — an estimate"
                session={session}
              />
              <SortableTh label="Liquidity" sortKey="liquidity" session={session} />
              <SortableTh label="Confidence" sortKey="confidence" session={session} />
              <th>eBay</th>
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
                <td className={profitClass(o.psa7_profit)}>{money(o.psa7_profit)}</td>
                <td className={profitClass(o.psa8_profit)}>{money(o.psa8_profit)}</td>
                <td className={profitClass(o.psa9_profit)}>{money(o.psa9_profit)}</td>
                <td className={profitClass(o.psa10_profit)}>{money(o.psa10_profit)}</td>
                <td>
                  {o.required_psa10_rate_vs_psa9 === null ? "—" : pct1(o.required_psa10_rate_vs_psa9)}
                  {o.required_psa10_rate_vs_psa8 !== null && (
                    <div className="state-sub" title="Required PSA 10 rate if every other one grades PSA 8">
                      vs 8: {pct1(o.required_psa10_rate_vs_psa8)}
                    </div>
                  )}
                </td>
                <td>{days(o.estimated_capital_lock_days)}</td>
                <td>{o.liquidity}</td>
                <td>{pct(o.confidence)}</td>
                <td>
                  <EbayLink url={o.listing_item_url} />
                  <ListingMeta o={o} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
