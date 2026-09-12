import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchInventory,
  fetchOpportunities,
  fetchCommitments,
  updateOpportunityReview,
  type OpportunityListItem,
  type ReviewStatus,
  type Commitments as CommitmentsSummary,
} from "../api/client";
import type { OpportunityBrowseQueue } from "../components/OpportunityTable";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : currency.format(n));

/**
 * ─────────────────────────────────────────────────────────────────────────
 * THE PIPELINE IS A BOARD OF POSITIONS, NOT A LEDGER OF EVENTS.
 *
 * SIMPLIFIED 2026-09-12, and the reason is worth keeping. The first version
 * of "move a card to UNDER OFFER" made the move mean placing a recorded offer:
 * an amount, a currency, a pending row, and a "what happened?" dropdown to
 * resolve it. That was the wrong model for how this actually works —
 * "you go back and forth on the offers", so every round trip became an
 * accounting event the operator had to log, and the board asked a question
 * whose answer the board itself was already showing.
 *
 * The stage is now just the operator's own sourcing status, the same field
 * the detail page's Sourcing status dropdown writes. Moving a card means
 * changing that: drag it, or pick from the little select on the card. There
 * is nothing to resolve, nothing to reconcile, and no amount required to
 * express "I've bid on this".
 *
 * WHERE THE MONEY STILL LIVES. Recorded offers (deal_offers) have not gone
 * anywhere — they are placed in the deal desk, they carry a real amount, and
 * they are what the commitments strip sums into "Potential acquisition
 * spend". That is deliberate separation: this board says where a card IS, the
 * desk says what money is committed to it. Only one of those needs a number.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** The three positions a lead can hold before it becomes owned stock. */
const LEAD_STAGES = [
  { status: "INTERESTED" as const, heading: "SAVED", label: "saved leads" },
  { status: "UNDER_OFFER" as const, heading: "UNDER OFFER", label: "cards under offer" },
] as const;

/** Where a card can be sent from the board. PASS drops it out of the feed. */
const MOVE_TARGETS: { value: ReviewStatus; label: string }[] = [
  { value: "INTERESTED", label: "Saved" },
  { value: "UNDER_OFFER", label: "Under offer" },
  { value: "BOUGHT", label: "Bought" },
  { value: "PASS", label: "Passed — drop it" },
];

const INVENTORY_STAGES = ["PURCHASED", "AWAITING_GRADING", "GRADED", "LISTED", "SOLD"] as const;

/**
 * OPENING A CARD FROM THE PIPELINE USED TO STRAND YOU THERE.
 *
 * Previous/Next on the detail page reads a browse queue out of the router's
 * navigation state (see useBrowseNeighbour in OpportunityDetail). The
 * dashboard table supplies one; these columns were plain `<Link>`s that
 * supplied nothing, so the buttons never rendered.
 *
 * A Pipeline column is a complete list rather than one page of a query, so
 * the queue it builds is `pageCount: 1` with no query params: Previous/Next
 * walk this column and stop at its ends, and the cross-page jump refuses to
 * run rather than re-running a query that does not exist.
 */
function columnQueue(ids: string[], label: string): OpportunityBrowseQueue {
  return { ids, page: 1, pageCount: 1, total: ids.length, limit: ids.length, label };
}

function LeadCard({
  o,
  ids,
  index,
  label,
  busy,
  onMove,
  onDragStart,
}: {
  o: OpportunityListItem;
  ids: string[];
  index: number;
  label: string;
  busy: boolean;
  onMove: (id: string, status: ReviewStatus) => void;
  onDragStart: (id: string) => void;
}) {
  return (
    <div
      className="pipeline-card"
      draggable
      onDragStart={() => onDragStart(o.id)}
      title="Drag to another column, or use the dropdown"
    >
      <Link
        to={`/opportunity/${o.id}`}
        className="pipeline-card-link"
        state={{ queue: columnQueue(ids, label), index, from: "/pipeline" }}
      >
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
      <select
        className="stage-move-select"
        value={o.review_status}
        disabled={busy}
        onChange={(e) => onMove(o.id, e.target.value as ReviewStatus)}
        aria-label="Move this card"
      >
        {MOVE_TARGETS.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <a href={o.listing_item_url} target="_blank" rel="noreferrer noopener" className="ebay-link">
        View on eBay
      </a>
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
function Commitments({ reloadKey }: { reloadKey: number }) {
  const [data, setData] = useState<CommitmentsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCommitments()
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [reloadKey]);

  if (error) return <p className="error-banner">Could not load commitments: {error}</p>;
  if (!data) return null;

  return (
    <div className="commitments-strip">
      <div className="commitment">
        <span className="commitment-label">Potential acquisition spend</span>
        <strong>{money(data.pendingOffers.potentialSpendGbp)}</strong>
        <span className="panel-caption">
          {data.pendingOffers.count} offer{data.pendingOffers.count === 1 ? "" : "s"} recorded with an amount in the
          desk — not spent, and only committed if accepted
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
  const [inventory, setInventory] = useState<any[]>([]);
  const [leads, setLeads] = useState<OpportunityListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ReviewStatus | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    // Both lead columns in one request. No `state` filter: a lead stays where
    // the operator put it even if a later scan moves it out of ACTIONABLE, and
    // deliberately no `listingStatus: "ACTIVE"` either — a card should not
    // vanish because the listing sold while you were deciding. It stays,
    // flagged, so you can see what happened to it.
    fetchOpportunities({ reviewStatus: "INTERESTED,UNDER_OFFER", limit: 200, sort: "newest", dir: "desc" })
      .then((r) => setLeads(r.opportunities))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
    fetchInventory().then((r) => setInventory(r.inventory));
  }, [reloadKey]);

  const move = useCallback(
    async (id: string, status: ReviewStatus) => {
      setBusyId(id);
      setMoveError(null);
      // Optimistic: the board should feel like a board. A failure below puts
      // the real state back by reloading, and says so.
      setLeads((rows) => rows.map((r) => (r.id === id ? { ...r, review_status: status } : r)));
      try {
        await updateOpportunityReview(id, { reviewStatus: status });
        reload();
      } catch (e) {
        setMoveError(String(e));
        reload();
      } finally {
        setBusyId(null);
      }
    },
    [reload],
  );

  return (
    <div>
      <div className="page-header">
        <h1>Pipeline</h1>
      </div>
      <Commitments reloadKey={reloadKey} />
      <p className="result-count">
        Saved leads, then cards you have bid on, then cards moving through purchase → grading → listing → sale. Drag a
        card between the first two columns, or use its dropdown. It is the same sourcing status as on the card itself.
      </p>
      {moveError && <p className="error-banner">Could not move that card: {moveError}</p>}
      {error && <p className="error-banner">{error}</p>}

      <div className="pipeline-columns">
        {LEAD_STAGES.map((stage) => {
          const rows = leads.filter((o) => o.review_status === stage.status);
          const ids = rows.map((o) => o.id);
          return (
            <div
              key={stage.status}
              className={`pipeline-column${dropTarget === stage.status ? " pipeline-column-drop" : ""}`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                setDropTarget(stage.status);
              }}
              onDragLeave={() => setDropTarget((t) => (t === stage.status ? null : t))}
              onDrop={() => {
                setDropTarget(null);
                if (dragging) void move(dragging, stage.status);
                setDragging(null);
              }}
            >
              <h3>{stage.heading}</h3>
              {loading && <p className="empty-state small">Loading…</p>}
              {!loading && rows.length === 0 && (
                <p className="empty-state small">
                  {stage.status === "INTERESTED"
                    ? "Nothing saved yet — press Save on a listing in Flips or Grade and it will appear here."
                    : "Nothing bid on. Drag a saved card here, or set Under offer on the card itself."}
                </p>
              )}
              {rows.map((o, i) => (
                <LeadCard
                  key={o.id}
                  o={o}
                  ids={ids}
                  index={i}
                  label={stage.label}
                  busy={busyId === o.id}
                  onMove={move}
                  onDragStart={setDragging}
                />
              ))}
            </div>
          );
        })}

        {INVENTORY_STAGES.map((stage) => (
          <div key={stage} className="pipeline-column">
            <h3>{stage.replace(/_/g, " ")}</h3>
            {inventory
              .filter((r) => r.status === stage)
              .map((r) => (
                <div key={r.id} className="pipeline-card">
                  {r.strategy} · £{r.actual_total_acquisition_cost}
                </div>
              ))}
            {inventory.filter((r) => r.status === stage).length === 0 && <p className="empty-state small">Empty</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
