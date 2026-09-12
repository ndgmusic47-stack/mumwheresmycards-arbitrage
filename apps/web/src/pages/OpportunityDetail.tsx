import { useEffect, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { fetchOpportunityDetail, fetchOpportunities, updateOpportunityReview } from "../api/client";
import type { ReviewStatus } from "../api/client";
import type { GradeRung } from "../api/client";
import { formatFetchedAt } from "../components/OpportunityTable";
import type { OpportunityBrowseQueue } from "../components/OpportunityTable";
import { StateBadge } from "../components/ScoreBadge";
import { DealDesk } from "../components/DealDesk";
import { GradeCheckPanel } from "../components/GradeCheckPanel";
import { CardIdentityCopyStrip } from "../components/CopyButton";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

/*
 * ─────────────────────────────────────────────────────────────────────────
 * PANELS REMOVED 2026-09-12, AT THE OPERATOR'S REQUEST.
 *
 * Deleted outright rather than hidden behind a flag: five dead components
 * kept "in case" are five things that must still typecheck, still lint and
 * still be read past by anyone changing this file. Git has them.
 *
 *   Condition truth              — a read of eBay's condition fields; the
 *                                  Listing panel already shows the same
 *                                  descriptors, and the photo check answers
 *                                  the question it was really asked.
 *   Why is this priced this way? — explicitly "things to verify, not
 *                                  reasons"; it never knew the answer.
 *   Flip / Grade economics       — the ENGINE's forecast. Superseded by the
 *                                  deal desk, which prices the operator's
 *                                  own confirmed costs instead of the
 *                                  engine's assumptions.
 *   What if?                     — scenario overrides on that same engine
 *                                  forecast. The desk is the what-if now:
 *                                  change a cost, get the real number.
 *   AI advisory                  — on-demand prose about a listing. Its
 *                                  feature switch (`listingAdvisory`) was
 *                                  already false, so nothing was spending.
 *
 * WHAT WAS DELIBERATELY NOT TOUCHED. The worker routes behind these panels
 * (/advisory, /scenario) still exist and still work. They cost nothing when
 * nobody calls them, they are covered by tests, and the scan-time engine
 * that computes the economics figures is NOT optional — the table's sorting,
 * filtering and qualification all run on it. Deleting that to "save compute"
 * would delete the app.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * SOURCING WORKFLOW item 16: Previous/Next through the exact filtered/
 * sorted/paged queue the user was browsing on the dashboard, not a random
 * table. `queue`+`index` arrive via router navigation state (set by
 * OpportunityTable's CardCellWithSession) — absent on a direct URL visit or
 * a refresh, in which case this degrades to no prev/next rather than
 * fabricating a queue that doesn't reflect the current view.
 *
 * Crossing a page boundary (Next past the last id on this page, or Previous
 * before the first) re-fetches the adjacent page with `queue.queryParams`
 * (everything about the original query except `page`) and jumps to its
 * first/last row — "continue exactly there" across pages, not just within
 * one.
 */
function useBrowseNeighbour(): {
  position: { index: number; total: number; label: string } | null;
  goPrev: (() => void) | null;
  goNext: (() => void) | null;
} {
  const location = useLocation();
  const navigate = useNavigate();
  const state = location.state as { queue?: OpportunityBrowseQueue; index?: number } | null;
  const queue = state?.queue;
  const index = state?.index;

  if (!queue || index === undefined || index < 0) {
    return { position: null, goPrev: null, goNext: null };
  }

  const globalPosition = (queue.page - 1) * queue.limit + index + 1;

  async function jumpWithinPage(newIndex: number) {
    const id = queue!.ids[newIndex];
    // `replace: true` — Next/Prev browsing through a queue is one continuous
    // browsing session, not a chain of pages the user meant to visit. Without
    // this, hitting the browser/app Back button after clicking Next a dozen
    // times steps back through every intermediate card instead of returning
    // to the dashboard, defeating the "get back to where I was" fix below.
    navigate(`/opportunity/${id}`, { state: { queue, index: newIndex }, replace: true });
  }

  async function jumpToPage(targetPage: number, pickIndex: "first" | "last") {
    if (targetPage < 1 || targetPage > queue!.pageCount) return;
    // A queue with no query params (the Pipeline's columns) is a complete
    // list with nothing on either side of it. Re-running "the query" would
    // mean inventing one.
    if (!queue!.queryParams) return;
    try {
      const result = await fetchOpportunities({ ...queue!.queryParams, page: targetPage });
      if (result.opportunities.length === 0) return;
      const newIds = result.opportunities.map((o) => o.id);
      const newIndex = pickIndex === "first" ? 0 : newIds.length - 1;
      const newQueue: OpportunityBrowseQueue = { ...queue!, ids: newIds, page: targetPage, total: result.total, pageCount: result.pageCount };
      navigate(`/opportunity/${newIds[newIndex]}`, { state: { queue: newQueue, index: newIndex }, replace: true });
    } catch {
      // Cross-page navigation is a convenience — if it fails, the user can
      // still get to the next page from the dashboard itself.
    }
  }

  const goPrev =
    index > 0
      ? () => jumpWithinPage(index - 1)
      : queue.page > 1
        ? () => jumpToPage(queue.page - 1, "last")
        : null;

  const goNext =
    index < queue.ids.length - 1
      ? () => jumpWithinPage(index + 1)
      : queue.page < queue.pageCount
        ? () => jumpToPage(queue.page + 1, "first")
        : null;

  return {
    position: { index: globalPosition, total: queue.total, label: queue.label ?? "matching opportunities" },
    goPrev,
    goNext,
  };
}

export function OpportunityDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchOpportunityDetail>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { position, goPrev, goNext } = useBrowseNeighbour();
  const location = useLocation();
  const navigate = useNavigate();

  // SOURCING WORKFLOW final blocker: "Back to opportunities" used to be a
  // plain `<Link to="/">`, which always lands on a blank dashboard — losing
  // the tab, filters, sort, page, and scroll position the user came from.
  // `location.key !== "default"` is true whenever this page was reached via
  // an in-app navigation (the dashboard's card link, or Next/Prev above), so
  // browser-style `navigate(-1)` genuinely goes back to that exact state
  // (Dashboard.tsx then re-centres on the last-viewed row). A direct URL
  // visit or a hard refresh has no such history entry (`key === "default"`),
  // so it falls back to the dashboard's default landing instead of leaving
  // the app or going nowhere.
  function handleBack() {
    if (location.key !== "default") {
      navigate(-1);
      return;
    }
    // No history entry (direct URL, or a refresh while on this page). Fall
    // back to the view the row was opened from, which the table puts in
    // `from` — pathname plus query string, so tab, filters, sort and page
    // all come back. Only if even that is missing do we land on the default
    // dashboard, which itself rehydrates its last view.
    const from = (location.state as { from?: string } | null)?.from;
    navigate(from && from.startsWith("/") ? from : "/");
  }

  useEffect(() => {
    if (!id) return;
    setData(null);
    fetchOpportunityDetail(id)
      .then(setData)
      .catch((err) => setError(String(err)));
  }, [id]);

  if (error) return <p className="error-banner">{error}</p>;
  if (!data) return <p className="empty-state">Loading…</p>;

  const { opportunity: o, card, listing, reasoning } = data;

  return (
    <div>
      {/* 2026-09-09: this is the ONLY route that returns you to your exact
          place — the header nav goes to a different tab with its own saved
          view. It was a quiet text link and users reached for the nav
          instead, then reported the position fix as broken. Made prominent
          and explicit about what it does. */}
      <button type="button" onClick={handleBack} className="back-link back-link-button back-to-results">
        ← Back to my results
        <span className="back-link-hint">keeps your filters, place and scroll position</span>
      </button>

      <div className="page-header">
        <h1>
          {card?.name} — {card?.set_name} #{card?.card_number}
        </h1>
        <StateBadge state={o.state} />
      </div>

      <CardIdentityCopyStrip name={card?.name} setName={card?.set_name} cardNumber={card?.card_number} />

      {(goPrev || goNext || position) && (
        <div className="opportunity-nav">
          <button onClick={() => goPrev?.()} disabled={!goPrev}>
            ← Previous
          </button>
          {position && (
            <span className="page-indicator">
              {position.index} of {position.total} {position.label}
            </span>
          )}
          <button onClick={() => goNext?.()} disabled={!goNext}>
            Next →
          </button>
        </div>
      )}

      <ReviewStatusPanel
        opportunityId={o.id}
        reviewStatus={o.review_status}
        reviewNotes={o.review_notes}
        reviewedAt={o.reviewed_at}
        onSaved={(updated) => setData({ ...data, opportunity: { ...o, ...updated } })}
      />

      <div className="detail-grid">
        <section className="panel">
          <h2>Exact card identity</h2>
          <dl>
            <dt>Set</dt>
            <dd>
              {card?.set_name} ({card?.set_code})
            </dd>
            <dt>Card number</dt>
            <dd>{card?.card_number}</dd>
            <dt>Year</dt>
            <dd>{card?.year}</dd>
            <dt>Language</dt>
            <dd>{card?.language}</dd>
            <dt>Edition</dt>
            <dd>{card?.edition}</dd>
            <dt>Variant</dt>
            <dd>{card?.variant}</dd>
            <dt>Finish</dt>
            <dd>{card?.finish}</dd>
            <dt>Rarity</dt>
            <dd>{card?.rarity}</dd>
          </dl>
        </section>

        <section className="panel">
          <h2>Listing</h2>
          {listing && (
            <>
              <p>{listing.title}</p>
              <p>
                {listing.listing_type}
                {listing.listing_type === "AUCTION" ? " — price shown is the CURRENT bid, not final" : ""}
                {listing.item_condition ? ` · ${listing.item_condition}` : ""}
                {listing.status !== "ACTIVE" ? ` · status: ${listing.status}` : ""}
              </p>
              <p>Last seen in a search: {listing.fetched_at}</p>
              {listing.location_country && listing.location_country !== "GB" && (
                <p className="error-banner" style={{ marginTop: 0 }}>
                  IMPORT COST NOT MODELLED — VERIFY BEFORE BUYING. eBay reports this listing's location as "
                  {listing.location_country}", not the UK. This forecast's import tax and other acquisition fees
                  default to £0 everywhere in this app (nothing in the scan pipeline populates them yet — see
                  ARCHITECTURE.md) — check the real landed cost (customs/import duty, any handling fee) yourself
                  before buying; it is not reflected anywhere in the numbers on this page.
                </p>
              )}
              <p>
                Seller feedback: {listing.seller_feedback_score} ({listing.seller_feedback_pct}%)
              </p>
              <p>
                Price: {currency.format(listing.price)} + {currency.format(listing.shipping_cost)} postage
              </p>
              <a href={listing.item_url} target="_blank" rel="noreferrer">
                View on eBay ↗
              </a>
              <EbayConditionCheck listing={listing} />
              {listing.image_urls?.length > 0 && (
                <div className="listing-images">
                  {listing.image_urls.map((url: string) => (
                    <img key={url} src={url} alt={listing.title} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        {o.strategy === "GRADE" && (
          <section className="panel">
            <h2>Grade ladder</h2>
            <p className="result-count">
              Economics conditional on achieving each grade. Losing outcomes are shown, not hidden — this says
              nothing about the probability of any grade.
            </p>
            <div className="ladder-scroll">
              <table className="ladder-table">
                <thead>
                  <tr>
                    <th>Grade</th>
                    <th>Gross slab value</th>
                    <th>Selling fees</th>
                    <th>Net proceeds</th>
                    <th>Profit</th>
                    <th>ROC</th>
                  </tr>
                </thead>
                <tbody>
                  {parseRungs(o.grade_rungs).map((rung) => (
                    <tr key={rung.grade}>
                      <td>
                        PSA {rung.grade}
                        {rung.potentialUpcharge && (
                          <div className="warn-tag" title="This grade's slab value exceeds the service's declared-value cap.">
                            UPCHARGE RISK
                          </div>
                        )}
                      </td>
                      <td>{rung.grossSlabValue !== null ? currency.format(rung.grossSlabValue) : "no market data"}</td>
                      <td>{rung.sellingFees !== null ? currency.format(rung.sellingFees) : "—"}</td>
                      <td>{rung.netProceeds !== null ? currency.format(rung.netProceeds) : "—"}</td>
                      <td className={rung.profit !== null && rung.profit >= 0 ? "profit-positive" : "profit-negative"}>
                        {rung.profit !== null ? currency.format(rung.profit) : "—"}
                      </td>
                      <td className={rung.returnOnCapital !== null && rung.returnOnCapital >= 0 ? "profit-positive" : "profit-negative"}>
                        {rung.returnOnCapital !== null ? `${(rung.returnOnCapital * 100).toFixed(0)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {o.economic_class_rationale && (
              <p className="result-count" style={{ marginTop: 12 }}>
                {o.economic_class_rationale}
              </p>
            )}
          </section>
        )}

        <section className="panel">
          <h2>Confidence reasoning</h2>
          <ul className="reasoning-list">
            {reasoning.map((r: string, i: number) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>

        {/* Above the deal desk on purpose: whether the photos can be trusted
            is a question to settle BEFORE entering resale assumptions that
            depend on the card grading well. */}
        {o.strategy === "GRADE" && <GradeCheckPanel opportunityId={o.id} graderId={o.grader_id ?? "PSA"} />}

        <DealDesk opportunityId={o.id} strategy={o.strategy === "FLIP" ? "FLIP" : "GRADE"} />

        <AiCandidateReviewPanel opportunity={o} />

      </div>
    </div>
  );
}

const REVIEW_STATUS_OPTIONS: { value: ReviewStatus; label: string }[] = [
  { value: "UNREVIEWED", label: "Unreviewed" },
  { value: "CHECKED", label: "Checked" },
  { value: "INTERESTED", label: "Interested" },
  // Moves the card to the pipeline's UNDER OFFER column. A position, not an
  // offer record — the amount, if you want one tracked, is a real offer
  // placed in the deal desk below.
  { value: "UNDER_OFFER", label: "Under offer" },
  { value: "PASS", label: "Passed" },
  { value: "BOUGHT", label: "Bought" },
];

/**
 * SOURCING WORKFLOW item 17 (review-status workflow): a manual sourcing
 * decision the user records here — never fed back into the engine's own
 * state/qualifies/score, and (see updateOpportunityReview's doc comment in
 * opportunitiesRepo.ts) never overwritten by a later re-scan of the same
 * listing. Deliberately explicit-save, not autosave-on-every-keystroke: a
 * notes field the user is still typing into shouldn't fire a network call
 * per character, and an explicit Save gives clear feedback that the
 * decision actually persisted.
 */
function ReviewStatusPanel({
  opportunityId,
  reviewStatus,
  reviewNotes,
  reviewedAt,
  onSaved,
}: {
  opportunityId: string;
  reviewStatus: ReviewStatus;
  reviewNotes: string | null;
  reviewedAt: string | null;
  onSaved: (updated: { review_status: ReviewStatus; review_notes: string | null; reviewed_at: string | null }) => void;
}) {
  const [status, setStatus] = useState<ReviewStatus>(reviewStatus);
  const [notes, setNotes] = useState(reviewNotes ?? "");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(reviewedAt);
  const [error, setError] = useState<string | null>(null);

  const dirty = status !== reviewStatus || notes !== (reviewNotes ?? "");

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await updateOpportunityReview(opportunityId, { reviewStatus: status, reviewNotes: notes });
      setSavedAt(result.opportunity.reviewed_at);
      onSaved({
        review_status: result.opportunity.review_status,
        review_notes: result.opportunity.review_notes,
        reviewed_at: result.opportunity.reviewed_at,
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="review-status-panel">
      <label>
        Sourcing status
        <select value={status} onChange={(e) => setStatus(e.target.value as ReviewStatus)}>
          {REVIEW_STATUS_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <textarea
        placeholder="Notes — anything worth remembering about this one (verified in hand, seller queried about condition, etc.)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={2}
      />
      <button onClick={save} disabled={!dirty || saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      {savedAt && !dirty && <span className="hint-tag">Saved {formatFetchedAt(savedAt)}</span>}
      {error && <span className="error-banner">{error}</span>}
    </div>
  );
}

/**
 * MWMC V1 FINAL SHIP PASS item 2: the persisted, one-shot AI CANDIDATE
 * REVIEW verdict (route/confidence/reason) applied during the scan's
 * selective-review step (see selectiveAiCandidateReview.ts /
 * AiCandidateRouterProvider). This is the only AI opinion left on this page:
 * the on-demand advisory panel was removed on 2026-09-12 (see the header
 * comment on this file) because it restated numbers the desk already shows.
 * Renders nothing when ai_review_status is null or PASS_THROUGH (no
 * objection — never worth a panel of its own), so an ordinary qualified row
 * looks exactly as it always has. This is purely a read of already-computed
 * data — it can never change state/qualifies/economics (see
 * applyAiCandidateReview's own doc comment for the structural guarantee).
 */
function AiCandidateReviewPanel({ opportunity: o }: { opportunity: any }) {
  const status = o.ai_review_status as "PASS_THROUGH" | "REVIEW" | "BLOCK_FROM_ACTIONABLE" | null;
  if (status !== "REVIEW" && status !== "BLOCK_FROM_ACTIONABLE") return null;

  const confidence = o.ai_review_confidence as number | null;
  return (
    <section className="panel">
      <h2>AI candidate review</h2>
      <p className="result-count">
        AI routed this candidate to <strong>{status === "BLOCK_FROM_ACTIONABLE" ? "BLOCK" : "REVIEW"}</strong>
        {confidence !== null && ` at ${Math.round(confidence * 100)}% confidence`} — this is why it's hidden from the
        Actionable feed by default (see "Include AI-flagged" on the Actionable tab). This is an AI opinion only: it
        never changed this opportunity's computed state, qualification, or economics above, all of which came from
        the deterministic engine exactly as shown.
      </p>
      {o.ai_review_reason && <p className="result-count">Reason given: {o.ai_review_reason}</p>}
      {o.ai_reviewed_at && <p className="result-count">Reviewed at: {o.ai_reviewed_at}</p>}
    </section>
  );
}

/**
 * SOURCING WORKFLOW item 9 (two-stage eBay enrichment): shows the result
 * of the stage-two "Get Item" call, when this listing has been through one
 * (a small, budgeted subset — see scanRunner.ts, never every listing).
 *
 * conditionDescriptors are rendered as their RAW eBay dictionary IDs
 * (e.g. "27501: 400010"), not translated into words — eBay's Browse API
 * doesn't return the human label inline, and this app has not yet
 * independently verified a mapping against a real captured response (the
 * same discipline applied to PokeTrace's tier keys elsewhere in this
 * project: confirm against real data before trusting an interpretation,
 * never guess one from docs alone). `conditionDescription` (eBay's own
 * free-text elaboration, when present) is far more directly useful and is
 * shown first and plainly.
 */
function EbayConditionCheck({ listing }: { listing: any }) {
  if (!listing.enriched_at) {
    return (
      <p className="hint-tag" title="This listing hasn't gone through the deeper eBay 'Get Item' condition check yet — only a small, budgeted number of promising listings get one per scan.">
        No deeper eBay condition check yet
      </p>
    );
  }

  const descriptors = parseConditionDescriptors(listing.condition_descriptors);
  return (
    <div className="hint-tag" title={`Checked ${listing.enriched_at}`}>
      Deeper eBay condition check: {listing.condition_description || "no free-text elaboration from eBay"}
      {descriptors.length > 0 && (
        <div
          title="Raw eBay condition-descriptor dictionary IDs — not yet translated into words, see code comment. For reference/audit, not a plain-English condition."
        >
          Raw descriptor codes: {descriptors.map((d) => `${d.name}: ${d.values.join("/")}`).join(", ")}
        </div>
      )}
    </div>
  );
}

function parseConditionDescriptors(raw: unknown): { name: string; values: string[] }[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The full ladder is stored as JSON on the opportunity so the detail page
 * can show every grade's real economics rather than re-deriving them.
 * Falls back to an empty ladder rather than throwing on unexpected content.
 */
function parseRungs(raw: string | null | undefined): GradeRung[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as GradeRung[]) : [];
  } catch {
    return [];
  }
}
