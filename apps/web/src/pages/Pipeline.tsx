import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchInventory,
  fetchOpportunities,
  fetchCommitments,
  fetchDealsUnderOffer,
  type OpportunityListItem,
  type DealUnderOffer,
  type Commitments as CommitmentsSummary,
} from "../api/client";
import type { OpportunityBrowseQueue } from "../components/OpportunityTable";

const STAGES = ["PURCHASED", "AWAITING_GRADING", "GRADED", "LISTED", "SOLD"] as const;

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : currency.format(n));

/**
 * OPENING A CARD FROM THE PIPELINE USED TO STRAND YOU THERE.
 *
 * Previous/Next on the detail page reads a browse queue out of the router's
 * navigation state (see useBrowseNeighbour in OpportunityDetail). The
 * dashboard table supplies one; these columns were plain `<Link>`s that
 * supplied nothing, so the buttons never rendered — reported as "I've lost
 * next and back in Pipeline, it still works in Grade".
 *
 * A Pipeline column is a complete list rather than one page of a query, so
 * the queue it builds is `pageCount: 1` with no query params: Previous/Next
 * walk this column and stop at its ends, and the cross-page jump refuses to
 * run rather than re-running a query that does not exist.
 */
function columnQueue(ids: string[], label: string): OpportunityBrowseQueue {
  return { ids, page: 1, pageCount: 1, total: ids.length, limit: ids.length, label };
}

function CardLink({
  to,
  ids,
  index,
  label,
  children,
}: {
  to: string;
  ids: string[];
  index: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className="pipeline-card-link"
      state={{ queue: columnQueue(ids, label), index, from: "/pipeline" }}
    >
      {children}
    </Link>
  );
}

/**
 * 2026-09-09: Pipeline used to start at PURCHASED, which left saved leads with
 * nowhere to go — the user could mark an opportunity INTERESTED from the
 * detail page and then had no way to find it again. Saving is now a one-click
 * action in the table (see OpportunityTable's DecisionCell), so the first
 * column here is the leads themselves: cards you have said yes to but not yet
 * bought.
 *
 * This is deliberately a different KIND of row from the stages after it.
 * "Saved" and "Under offer" read live from `opportunities`/`deals` (a listing
 * you're considering, which may sell to somebody else); PURCHASED onwards read
 * from `inventory` (a card you own). Keeping them in one left-to-right flow
 * matches how the decision actually progresses, without pretending a lead is
 * stock.
 */
function SavedLeads({ excludeOpportunityIds }: { excludeOpportunityIds: Set<string> }) {
  const [rows, setRows] = useState<OpportunityListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // No `state` filter: a saved lead stays saved even if a later scan moves
    // it out of ACTIONABLE (price rose, market data changed). Hiding it then
    // would be the same disappearing act the Save button exists to prevent.
    // Deliberately NO `listingStatus: "ACTIVE"` here, unlike the working feed:
    // a lead you saved should not silently disappear because the listing sold
    // while you were deciding. It stays, flagged, so you can see what happened
    // to it and clear it yourself.
    fetchOpportunities({ reviewStatus: "INTERESTED", limit: 200, sort: "newest", dir: "desc" })
      .then((r) => setRows(r.opportunities))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  // A card you have bid on is no longer merely saved. It has its own column
  // now, and showing it in both would put the same decision — and the same
  // money — in two places at once.
  const visible = rows.filter((o) => !excludeOpportunityIds.has(o.id));
  const ids = visible.map((o) => o.id);

  return (
    <div className="pipeline-column">
      <h3>SAVED</h3>
      {loading && <p className="empty-state small">Loading…</p>}
      {error && <p className="error-banner">{error}</p>}
      {!loading && !error && visible.length === 0 && (
        <p className="empty-state small">
          Nothing saved yet — press Save on a listing in Flips or Grade and it will appear here.
        </p>
      )}
      {visible.map((o, i) => (
        <div key={o.id} className="pipeline-card">
          <CardLink to={`/opportunity/${o.id}`} ids={ids} index={i} label="saved leads">
            {o.card_name}
          </CardLink>
          {o.listing_status !== "ACTIVE" && (
            <div className="state-sub listing-gone" title="This eBay listing is no longer live — sold, ended, or withdrawn.">
              No longer available on eBay
            </div>
          )}
          <div className="state-sub">
            {o.strategy === "GRADE" ? "Grade" : "Flip"} · {money(o.total_acquisition_cost)} delivered
            {o.strategy === "GRADE" && o.break_even_grade ? ` · pays back at PSA ${o.break_even_grade}` : ""}
            {o.strategy === "FLIP" && o.expected_net_profit !== null ? ` · ${money(o.expected_net_profit)} profit` : ""}
          </div>
          <a href={o.listing_item_url} target="_blank" rel="noreferrer noopener" className="ebay-link">
            View on eBay
          </a>
        </div>
      ))}
    </div>
  );
}

/**
 * UNDER OFFER — the stage between deciding you want a card and owning it.
 *
 * Asked for directly, and it was a real gap: a card you have bid on sat in
 * SAVED looking exactly like one you had merely bookmarked, even though real
 * money was on the table and a clock was running on it.
 *
 * WHAT IS AND IS NOT A COMMITMENT. This column is NOT spend, and the wording
 * is careful about that everywhere — the amount shown is what would leave the
 * account if the offer were accepted, which is the same distinction the
 * commitments strip above draws and the reason those three figures are never
 * summed. Only PENDING offers appear: accepted, rejected, expired and
 * withdrawn ones stay in the deal's own history where they can still be read,
 * but they are not live exposure and do not belong in a live stage.
 */
function UnderOffer({ deals, error }: { deals: DealUnderOffer[]; error: string | null }) {
  const ids = deals.map((d) => d.opportunity_id);
  const totalGbp = deals.reduce((sum, d) => sum + d.amount_gbp, 0);

  return (
    <div className="pipeline-column">
      <h3>UNDER OFFER</h3>
      {error && <p className="error-banner">{error}</p>}
      {!error && deals.length === 0 && (
        <p className="empty-state small">
          No live offers. Place one from a card&apos;s deal desk and it will move here.
        </p>
      )}
      {deals.length > 0 && (
        <p className="state-sub">
          {money(totalGbp)} on the table — not spent, and only committed if accepted.
        </p>
      )}
      {deals.map((d, i) => (
        <div key={d.deal_id} className="pipeline-card">
          <CardLink to={`/opportunity/${d.opportunity_id}`} ids={ids} index={i} label="cards under offer">
            {d.card_name ?? "(card)"}
          </CardLink>
          {d.card_number && (
            <div className="state-sub">
              {d.set_name} #{d.card_number}
            </div>
          )}
          <div className="state-sub">
            {d.strategy === "GRADE" ? "Grade" : "Flip"} · offered{" "}
            <strong>
              {d.currency === "GBP"
                ? money(d.amount_gbp)
                : `${d.amount} ${d.currency} (${money(d.amount_gbp)})`}
            </strong>
          </div>
          <div className="state-sub">
            Placed {new Date(d.placed_at).toLocaleDateString("en-GB")}
            {d.expires_at && ` · expires ${new Date(d.expires_at).toLocaleDateString("en-GB")}`}
          </div>
          {d.listing_status && d.listing_status !== "ACTIVE" && (
            <div className="state-sub listing-gone" title="This eBay listing is no longer live — sold, ended, or withdrawn.">
              No longer available on eBay
            </div>
          )}
          {d.listing_item_url && (
            <a href={d.listing_item_url} target="_blank" rel="noreferrer noopener" className="ebay-link">
              View on eBay
            </a>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * THREE FIGURES, NEVER ONE.
 *
 * A pending offer is not money spent — it is what would be committed if every
 * outstanding offer were accepted. Actual spend is money already gone.
 * Planned grading is money owed on cards already owned. Summing any two of
 * these produces a number that is true of nothing, which is why they are
 * rendered side by side with no total.
 */
function Commitments() {
  const [data, setData] = useState<CommitmentsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCommitments()
      .then(setData)
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="error-banner">Could not load commitments: {error}</p>;
  if (!data) return null;

  return (
    <div className="commitments-strip">
      <div className="commitment">
        <span className="commitment-label">Potential acquisition spend</span>
        <strong>{money(data.pendingOffers.potentialSpendGbp)}</strong>
        <span className="panel-caption">
          {data.pendingOffers.count} pending offer{data.pendingOffers.count === 1 ? "" : "s"} — not spent, and only
          committed if accepted
        </span>
      </div>
      <div className="commitment">
        <span className="commitment-label">Actually spent</span>
        <strong>{money(data.actualSpend.spentGbp)}</strong>
        <span className="panel-caption">
          {data.actualSpend.inventoryCount} card{data.actualSpend.inventoryCount === 1 ? "" : "s"} bought
        </span>
      </div>
      <div className="commitment">
        <span className="commitment-label">Planned grading</span>
        <strong>{money(data.plannedGrading.plannedGbp)}</strong>
        <span className="panel-caption">
          across {data.plannedGrading.cardCount} card{data.plannedGrading.cardCount === 1 ? "" : "s"} awaiting grading
          {data.plannedGrading.uncostedCards > 0 && (
            <>
              {" "}
              · {data.plannedGrading.uncostedCards} more with no saved grading cost, so not included
            </>
          )}
        </span>
      </div>
    </div>
  );
}

export function Pipeline() {
  const [rows, setRows] = useState<any[]>([]);
  const [underOffer, setUnderOffer] = useState<DealUnderOffer[]>([]);
  const [offerError, setOfferError] = useState<string | null>(null);

  useEffect(() => {
    fetchInventory().then((r) => setRows(r.inventory));
    fetchDealsUnderOffer()
      .then((r) => setUnderOffer(r.deals))
      .catch((e) => setOfferError(String(e)));
  }, []);

  const underOfferOpportunityIds = useMemo(
    () => new Set(underOffer.map((d) => d.opportunity_id)),
    [underOffer],
  );

  return (
    <div>
      <div className="page-header">
        <h1>Pipeline</h1>
      </div>
      <Commitments />
      <p className="result-count">
        Saved leads, then cards you have bid on, then cards moving through purchase → grading → listing → sale.
      </p>
      <div className="pipeline-columns">
        <SavedLeads excludeOpportunityIds={underOfferOpportunityIds} />
        <UnderOffer deals={underOffer} error={offerError} />
        {STAGES.map((stage) => (
          <div key={stage} className="pipeline-column">
            <h3>{stage.replace(/_/g, " ")}</h3>
            {rows
              .filter((r) => r.status === stage)
              .map((r) => (
                <div key={r.id} className="pipeline-card">
                  {r.strategy} · £{r.actual_total_acquisition_cost}
                </div>
              ))}
            {rows.filter((r) => r.status === stage).length === 0 && <p className="empty-state small">Empty</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
