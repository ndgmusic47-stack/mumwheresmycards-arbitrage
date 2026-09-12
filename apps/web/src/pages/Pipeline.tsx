import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchInventory,
  fetchOpportunities,
  fetchCommitments,
  fetchDealsUnderOffer,
  placeQuickOffer,
  resolveDealOffer,
  recordDealPurchase,
  type OpportunityListItem,
  type DealUnderOffer,
  type Commitments as CommitmentsSummary,
} from "../api/client";
import type { OpportunityBrowseQueue } from "../components/OpportunityTable";

const STAGES = ["PURCHASED", "AWAITING_GRADING", "GRADED", "LISTED", "SOLD"] as const;

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : currency.format(n));

/**
 * ─────────────────────────────────────────────────────────────────────────
 * MOVING A CARD ALONG THE PIPELINE, FROM THE PIPELINE.
 *
 * The UNDER OFFER stage existed but nothing could reach it: the only way to
 * put a card under offer was to open its deal desk, save a full set of
 * assumptions, and place an offer there. Reported plainly — "not moving to
 * under offer, not allowed in dropdown or drag and drop".
 *
 * WHAT A MOVE ACTUALLY REQUIRES, AND WHY A BARE DRAG CANNOT DO IT. "Under
 * offer" is not a flag on the card; it is a real offer of a real amount, and
 * that amount is summed into the exposure figure at the top of this page and
 * into the commitments strip. Dragging a card with no amount would either
 * refuse silently or invent a number, and an invented number here becomes
 * "money I have on the table" everywhere else.
 *
 * So the move ALWAYS asks for the amount, and both routes into it land on the
 * same small form:
 *   - the "Make an offer" button on a saved card, and
 *   - dragging a saved card onto the UNDER OFFER column.
 * Drag is the shortcut, not a second code path — it opens the form, it does
 * not complete the move.
 *
 * BACK OUT AND FORWARD ON. Each card under offer carries the four real
 * outcomes (accepted, rejected, expired, withdrawn). Three of them return the
 * card to SAVED. Accepted keeps it here, flagged, until the purchase is
 * recorded — which is refused, loudly and specifically, while any acquisition
 * cost is still unknown. That refusal is the point: a card is not "bought"
 * until what it cost is a fact.
 * ─────────────────────────────────────────────────────────────────────────
 */

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
    <Link to={to} className="pipeline-card-link" state={{ queue: columnQueue(ids, label), index, from: "/pipeline" }}>
      {children}
    </Link>
  );
}

/** The amount box. Deliberately the only way a card reaches UNDER OFFER. */
function OfferForm({
  onPlace,
  onCancel,
  busy,
  error,
}: {
  onPlace: (amount: number, currency: string) => void;
  onCancel: () => void;
  busy: boolean;
  error: string | null;
}) {
  const [amount, setAmount] = useState("");
  const [ccy, setCcy] = useState("GBP");
  const parsed = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(parsed) && parsed > 0;

  return (
    <form
      className="offer-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) onPlace(parsed, ccy);
      }}
    >
      <div className="offer-form-row">
        <input
          type="number"
          step="0.01"
          min="0"
          autoFocus
          placeholder="Offer amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Offer amount"
        />
        <select value={ccy} onChange={(e) => setCcy(e.target.value)} aria-label="Offer currency">
          {["GBP", "USD", "EUR"].map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="offer-form-row">
        <button type="submit" disabled={!valid || busy}>
          {busy ? "Placing…" : "Place offer"}
        </button>
        <button type="button" className="link-button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && <p className="error-banner small">{error}</p>}
      <p className="state-sub">
        This records what you offered. It is not spend, and it does not enter any cost you have not typed.
      </p>
    </form>
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
function SavedLeads({
  rows,
  loading,
  error,
  offerFor,
  setOfferFor,
  onPlace,
  placing,
  placeError,
  onDragStart,
}: {
  rows: OpportunityListItem[];
  loading: boolean;
  error: string | null;
  offerFor: string | null;
  setOfferFor: (id: string | null) => void;
  onPlace: (opportunityId: string, amount: number, currency: string) => void;
  placing: boolean;
  placeError: string | null;
  onDragStart: (id: string) => void;
}) {
  const ids = rows.map((o) => o.id);

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
      {rows.map((o, i) => (
        <div
          key={o.id}
          className="pipeline-card"
          draggable={offerFor !== o.id}
          onDragStart={() => onDragStart(o.id)}
          title="Drag onto Under offer, or use Make an offer"
        >
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
          {offerFor === o.id ? (
            <OfferForm
              busy={placing}
              error={placeError}
              onCancel={() => setOfferFor(null)}
              onPlace={(amount, ccy) => onPlace(o.id, amount, ccy)}
            />
          ) : (
            <button type="button" className="stage-move-button" onClick={() => setOfferFor(o.id)}>
              Make an offer →
            </button>
          )}
          <a href={o.listing_item_url} target="_blank" rel="noreferrer noopener" className="ebay-link">
            View on eBay
          </a>
        </div>
      ))}
    </div>
  );
}

const OUTCOMES = [
  { value: "ACCEPTED", label: "Accepted" },
  { value: "REJECTED", label: "Rejected" },
  { value: "EXPIRED", label: "Expired" },
  { value: "WITHDRAWN", label: "I withdrew it" },
] as const;

/**
 * UNDER OFFER — the stage between deciding you want a card and owning it.
 *
 * WHAT IS AND IS NOT A COMMITMENT. This column is NOT spend, and the wording
 * is careful about that everywhere — the amount shown is what would leave the
 * account if the offer were accepted, the same distinction the commitments
 * strip above draws and the reason those three figures are never summed.
 * Accepted offers are shown too, but excluded from that total: winning is not
 * paying.
 */
function UnderOffer({
  deals,
  error,
  onResolve,
  onRecordPurchase,
  busyOfferId,
  rowError,
  dropActive,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  deals: DealUnderOffer[];
  error: string | null;
  onResolve: (offerId: string, status: (typeof OUTCOMES)[number]["value"]) => void;
  onRecordPurchase: (dealId: string) => void;
  busyOfferId: string | null;
  rowError: { id: string; message: string } | null;
  dropActive: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: () => void;
}) {
  const ids = deals.map((d) => d.opportunity_id);
  const liveTotal = deals.filter((d) => d.offer_status === "PENDING").reduce((sum, d) => sum + d.amount_gbp, 0);

  return (
    <div
      className={`pipeline-column${dropActive ? " pipeline-column-drop" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <h3>UNDER OFFER</h3>
      {error && <p className="error-banner">{error}</p>}
      {dropActive && <p className="state-sub drop-hint">Drop to enter the amount you offered</p>}
      {!error && deals.length === 0 && (
        <p className="empty-state small">
          No live offers. Use <strong>Make an offer</strong> on a saved card, or drag one here.
        </p>
      )}
      {liveTotal > 0 && (
        <p className="state-sub">{money(liveTotal)} on the table — not spent, and only committed if accepted.</p>
      )}
      {deals.map((d, i) => (
        <div key={d.deal_id} className={`pipeline-card${d.offer_status === "ACCEPTED" ? " pipeline-card-accepted" : ""}`}>
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
            <strong>{d.currency === "GBP" ? money(d.amount_gbp) : `${d.amount} ${d.currency} (${money(d.amount_gbp)})`}</strong>
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

          {d.offer_status === "PENDING" ? (
            <select
              className="stage-move-select"
              value=""
              disabled={busyOfferId === d.offer_id}
              onChange={(e) => {
                const next = e.target.value as (typeof OUTCOMES)[number]["value"] | "";
                if (next) onResolve(d.offer_id, next);
              }}
              aria-label="What happened to this offer?"
            >
              <option value="">What happened? ▾</option>
              {OUTCOMES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <>
              <div className="state-sub accepted-tag">Accepted — not yet recorded as bought</div>
              <button
                type="button"
                className="stage-move-button"
                disabled={busyOfferId === d.offer_id}
                onClick={() => onRecordPurchase(d.deal_id)}
              >
                {busyOfferId === d.offer_id ? "Recording…" : "Record purchase →"}
              </button>
            </>
          )}

          {rowError?.id === d.offer_id && <p className="error-banner small">{rowError.message}</p>}

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
  const [inventory, setInventory] = useState<any[]>([]);
  const [saved, setSaved] = useState<OpportunityListItem[]>([]);
  const [savedLoading, setSavedLoading] = useState(true);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [underOffer, setUnderOffer] = useState<DealUnderOffer[]>([]);
  const [offerError, setOfferError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [offerFor, setOfferFor] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [busyOfferId, setBusyOfferId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    // No `state` filter: a saved lead stays saved even if a later scan moves
    // it out of ACTIONABLE (price rose, market data changed). Deliberately no
    // `listingStatus: "ACTIVE"` either — a lead should not vanish because the
    // listing sold while you were deciding. It stays, flagged.
    fetchOpportunities({ reviewStatus: "INTERESTED", limit: 200, sort: "newest", dir: "desc" })
      .then((r) => setSaved(r.opportunities))
      .catch((e) => setSavedError(String(e)))
      .finally(() => setSavedLoading(false));
    fetchInventory().then((r) => setInventory(r.inventory));
    fetchDealsUnderOffer()
      .then((r) => setUnderOffer(r.deals))
      .catch((e) => setOfferError(String(e)));
  }, [reloadKey]);

  const underOfferOpportunityIds = useMemo(() => new Set(underOffer.map((d) => d.opportunity_id)), [underOffer]);

  // A card you have bid on is no longer merely saved. Showing it in both
  // columns would put the same decision — and the same money — in two places.
  const savedVisible = saved.filter((o) => !underOfferOpportunityIds.has(o.id));

  async function place(opportunityId: string, amount: number, ccy: string) {
    setPlacing(true);
    setPlaceError(null);
    try {
      await placeQuickOffer(opportunityId, amount, ccy);
      setOfferFor(null);
      reload();
    } catch (e) {
      setPlaceError(String(e));
    } finally {
      setPlacing(false);
    }
  }

  async function resolve(offerId: string, status: (typeof OUTCOMES)[number]["value"]) {
    setBusyOfferId(offerId);
    setRowError(null);
    try {
      await resolveDealOffer(offerId, status);
      reload();
    } catch (e) {
      setRowError({ id: offerId, message: String(e) });
    } finally {
      setBusyOfferId(null);
    }
  }

  async function purchase(dealId: string) {
    const row = underOffer.find((d) => d.deal_id === dealId);
    const offerId = row?.offer_id ?? dealId;
    setBusyOfferId(offerId);
    setRowError(null);
    try {
      await recordDealPurchase(dealId);
      reload();
    } catch (e) {
      // The purchase route refuses while any acquisition cost is unknown, and
      // names each one. That refusal is shown verbatim — it is the most
      // useful thing on the card at that moment.
      setRowError({ id: offerId, message: String(e) });
    } finally {
      setBusyOfferId(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Pipeline</h1>
      </div>
      <Commitments reloadKey={reloadKey} />
      <p className="result-count">
        Saved leads, then cards you have bid on, then cards moving through purchase → grading → listing → sale. Drag a
        saved card onto Under offer, or use its Make an offer button — either way you enter the amount you actually
        offered.
      </p>
      <div className="pipeline-columns">
        <SavedLeads
          rows={savedVisible}
          loading={savedLoading}
          error={savedError}
          offerFor={offerFor}
          setOfferFor={(id) => {
            setPlaceError(null);
            setOfferFor(id);
          }}
          onPlace={place}
          placing={placing}
          placeError={placeError}
          onDragStart={setDragging}
        />
        <UnderOffer
          deals={underOffer}
          error={offerError}
          onResolve={resolve}
          onRecordPurchase={purchase}
          busyOfferId={busyOfferId}
          rowError={rowError}
          dropActive={dropActive}
          onDragOver={(e) => {
            if (!dragging) return;
            e.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={() => {
            setDropActive(false);
            if (!dragging) return;
            // The drop does not place the offer. It opens the amount box on
            // the card, because an offer without an amount is not an offer.
            setPlaceError(null);
            setOfferFor(dragging);
            setDragging(null);
          }}
        />
        {STAGES.map((stage) => (
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
