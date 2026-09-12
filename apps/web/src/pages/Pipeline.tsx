import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchInventory,
  fetchOpportunities,
  fetchCommitments,
  type OpportunityListItem,
  type Commitments as CommitmentsSummary,
} from "../api/client";

const STAGES = ["PURCHASED", "AWAITING_GRADING", "GRADED", "LISTED", "SOLD"] as const;

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : currency.format(n));

/**
 * 2026-09-09: Pipeline used to start at PURCHASED, which left saved leads with
 * nowhere to go — the user could mark an opportunity INTERESTED from the
 * detail page and then had no way to find it again. Saving is now a one-click
 * action in the table (see OpportunityTable's DecisionCell), so the first
 * column here is the leads themselves: cards you have said yes to but not yet
 * bought.
 *
 * This is deliberately a different KIND of row from the five stages after it.
 * "Saved" reads live from `opportunities` (a listing you're considering, which
 * may sell to somebody else); PURCHASED onwards read from `inventory` (a card
 * you own). Keeping them in one left-to-right flow matches how the decision
 * actually progresses, without pretending a lead is stock.
 */
function SavedLeads() {
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

  return (
    <div className="pipeline-column">
      <h3>SAVED</h3>
      {loading && <p className="empty-state small">Loading…</p>}
      {error && <p className="error-banner">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="empty-state small">
          Nothing saved yet — press Save on a listing in Flips or Grade and it will appear here.
        </p>
      )}
      {rows.map((o) => (
        <div key={o.id} className="pipeline-card">
          <Link to={`/opportunity/${o.id}`} className="pipeline-card-link">
            {o.card_name}
          </Link>
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

  useEffect(() => {
    fetchInventory().then((r) => setRows(r.inventory));
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>Pipeline</h1>
      </div>
      <Commitments />
      <p className="result-count">Saved leads, then cards moving through purchase → grading → listing → sale.</p>
      <div className="pipeline-columns">
        <SavedLeads />
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
