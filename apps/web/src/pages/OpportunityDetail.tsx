import { useEffect, useState } from "react";
import { useParams, useLocation, useNavigate } from "react-router-dom";
import { fetchOpportunityDetail, fetchOpportunities, fetchOpportunityAdvisory, updateOpportunityReview, runOpportunityScenario } from "../api/client";
import type { ReviewStatus } from "../api/client";
import type { GradeRung } from "../api/client";
import type { ConditionTierPrices } from "../api/client";
import type { ScenarioOverrides, FlipScenarioApiResult, GradeScenarioApiResult } from "../api/client";
import { formatFetchedAt } from "../components/OpportunityTable";
import type { OpportunityBrowseQueue } from "../components/OpportunityTable";
import { StateBadge, ScoreBadge, EconomicClassBadge } from "../components/ScoreBadge";
import { computePriceContext, computeMedianPriceSpread, listingQualityFromSeller, detectListingConditionSignal } from "@mwmc/core";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

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
  position: { index: number; total: number } | null;
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

  return { position: { index: globalPosition, total: queue.total }, goPrev, goNext };
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
    } else {
      navigate("/");
    }
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

  const { opportunity: o, card, listing, marketSnapshot, conditionTierPrices, reasoning } = data;

  return (
    <div>
      <button type="button" onClick={handleBack} className="back-link back-link-button">
        ← Back to opportunities
      </button>

      <div className="page-header">
        <h1>
          {card?.name} — {card?.set_name} #{card?.card_number}
        </h1>
        <StateBadge state={o.state} />
      </div>

      {(goPrev || goNext || position) && (
        <div className="opportunity-nav">
          <button onClick={() => goPrev?.()} disabled={!goPrev}>
            ← Previous
          </button>
          {position && (
            <span className="page-indicator">
              {position.index} of {position.total} matching opportunities
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

        <WhyThisPricePanel opportunity={o} listing={listing} marketSnapshot={marketSnapshot} />

        <ConditionTruthPanel listing={listing} marketSnapshot={marketSnapshot} conditionTierPrices={conditionTierPrices} />

        <section className="panel">
          <h2>{o.strategy === "FLIP" ? "Flip economics" : "Grade economics"}</h2>
          {o.strategy === "FLIP" ? (
            <dl>
              <dt>Score</dt>
              <dd>
                <ScoreBadge score={o.flip_score} />
              </dd>
              <dt>Total acquisition cost</dt>
              <dd>{currency.format(o.total_acquisition_cost)}</dd>
              <dt>QSV</dt>
              <dd>{o.qsv !== null ? currency.format(o.qsv) : "—"}</dd>
              <dt>Expected net sale proceeds</dt>
              <dd>{o.expected_net_sale_proceeds !== null ? currency.format(o.expected_net_sale_proceeds) : "—"}</dd>
              <dt>Expected net profit</dt>
              <dd>{o.expected_net_profit !== null ? currency.format(o.expected_net_profit) : "—"}</dd>
              <dt>Return on capital</dt>
              <dd>{o.return_on_capital !== null ? `${(o.return_on_capital * 100).toFixed(1)}%` : "—"}</dd>
              <dt>Profit margin</dt>
              <dd>{o.profit_margin !== null ? `${(o.profit_margin * 100).toFixed(1)}%` : "—"}</dd>
              <dt>Est. days to sale</dt>
              <dd>{o.days_to_sale_estimate ?? "—"}</dd>
            </dl>
          ) : (
            <dl>
              <dt>Score</dt>
              <dd>
                <ScoreBadge score={o.score ?? o.grade_score} />
              </dd>
              <dt>Economic class</dt>
              <dd>
                <EconomicClassBadge economicClass={o.economic_class} />
              </dd>
              <dt>Grading service</dt>
              <dd>
                {o.grading_service_name ?? "—"}
                {o.potential_upcharge === 1 && (
                  <div className="warn-tag">
                    POTENTIAL UPCHARGE — a grade's slab value exceeds this service's declared-value cap. The
                    exact escalation cost is not known before submission.
                  </div>
                )}
              </dd>
              <dt>Total graded basis</dt>
              <dd>{o.total_graded_basis !== null ? currency.format(o.total_graded_basis) : "—"}</dd>
              <dt>Break-even grade</dt>
              <dd>{o.break_even_grade ? `PSA ${o.break_even_grade}` : "None"}</dd>
              <dt>PSA10 gross multiple</dt>
              <dd>{o.psa10_gross_multiple !== null ? `${o.psa10_gross_multiple.toFixed(2)}x` : "—"}</dd>
              <dt title="How often this must come back PSA 10 to break even, if every other one grades PSA 9. A REQUIRED rate, not a prediction.">
                Required 10 rate (vs PSA 9)
              </dt>
              <dd>{formatRate(o.required_psa10_rate_vs_psa9)}</dd>
              <dt title="Same calculation, assuming every non-10 grades PSA 8 instead.">
                Required 10 rate (vs PSA 8)
              </dt>
              <dd>{formatRate(o.required_psa10_rate_vs_psa8)}</dd>
              <dt>Est. grading turnaround</dt>
              <dd>{o.estimated_grading_days !== null ? `${o.estimated_grading_days} days (estimate)` : "—"}</dd>
              <dt>Est. capital lock</dt>
              <dd>
                {o.estimated_capital_lock_days !== null
                  ? `${o.estimated_capital_lock_days} days (estimate)`
                  : "—"}
              </dd>
              <dt>Profit per capital day</dt>
              <dd>{o.profit_per_capital_day !== null ? currency.format(o.profit_per_capital_day) : "—"}</dd>
              <dt title="ROC scaled to a 365-day year. An indicator for comparing services, not a forecast return.">
                Annualised ROC indicator
              </dt>
              <dd>
                {o.annualised_roc_indicator !== null
                  ? `${(o.annualised_roc_indicator * 100).toFixed(0)}%`
                  : "—"}
              </dd>
            </dl>
          )}
        </section>

        {o.strategy === "GRADE" && (
          <section className="panel">
            <h2>Grade ladder</h2>
            <p className="result-count">
              Economics conditional on achieving each grade. Losing outcomes are shown, not hidden — this says
              nothing about the probability of any grade.
            </p>
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

        <ScenarioPanel opportunity={o} />

        <AiAdvisoryPanel opportunityId={o.id} />
      </div>
    </div>
  );
}

/**
 * AI INTELLIGENCE spec Phase 2, Workstream M: the "what if?" scenario
 * panel. Every number it shows comes back from the worker route's own
 * `runFlipScenario`/`runGradeScenario` call (packages/core/src/calc/
 * scenarioEngine.ts) — this component never computes economics itself, it
 * only collects the override(s) the user wants to try and renders whatever
 * the deterministic engine (and, optionally, its AI narrator) returns.
 * Explicit "Run scenario" button, not recompute-on-every-keystroke — same
 * discipline as ReviewStatusPanel's explicit Save, and the same reasoning:
 * a number the user is still typing shouldn't fire a network call per
 * character.
 */
function ScenarioPanel({ opportunity }: { opportunity: any }) {
  const strategy = opportunity.strategy as "FLIP" | "GRADE";

  const [totalAcquisitionCost, setTotalAcquisitionCost] = useState(String(opportunity.total_acquisition_cost));
  const [qsv, setQsv] = useState(opportunity.qsv !== null ? String(opportunity.qsv) : "");
  const [totalGradedBasis, setTotalGradedBasis] = useState(
    opportunity.total_graded_basis !== null ? String(opportunity.total_graded_basis) : "",
  );
  const [narrate, setNarrate] = useState(false);
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "loaded"; result: FlipScenarioApiResult | GradeScenarioApiResult }
  >({ status: "idle" });

  // Neither strategy has a baseline this panel can build a scenario for —
  // same guard the worker route itself enforces (a 400 either way), caught
  // here too so the panel can explain why instead of showing a form that
  // can only ever fail.
  if (strategy === "FLIP" && opportunity.qsv === null) {
    return (
      <section className="panel">
        <h2>What if?</h2>
        <p className="hint-tag">This opportunity has no QSV recorded — a scenario needs a baseline reference sale price.</p>
      </section>
    );
  }
  if (strategy === "GRADE" && opportunity.total_graded_basis === null) {
    return (
      <section className="panel">
        <h2>What if?</h2>
        <p className="hint-tag">This opportunity has no graded basis recorded — a scenario needs a baseline.</p>
      </section>
    );
  }

  async function run() {
    setState({ status: "loading" });
    try {
      const overrides: ScenarioOverrides = { narrate };
      if (strategy === "FLIP") {
        const cost = Number(totalAcquisitionCost);
        const q = Number(qsv);
        if (Number.isFinite(cost) && cost >= 0) overrides.totalAcquisitionCost = cost;
        if (Number.isFinite(q) && q >= 0) overrides.qsv = q;
      } else {
        const basis = Number(totalGradedBasis);
        if (Number.isFinite(basis) && basis >= 0) overrides.totalGradedBasis = basis;
      }
      const result = await runOpportunityScenario(opportunity.id, overrides);
      setState({ status: "loaded", result });
    } catch (err) {
      setState({ status: "error", message: String(err) });
    }
  }

  return (
    <section className="panel">
      <h2>What if?</h2>
      <p className="result-count">
        Recomputed by this app's own deterministic pricing engine, not a separate estimate — try a different acquisition
        cost, sale price, or grade outcome to see the real effect on profit.
      </p>

      {strategy === "FLIP" ? (
        <div className="scenario-inputs">
          <label>
            Total acquisition cost (£)
            <input type="number" value={totalAcquisitionCost} onChange={(e) => setTotalAcquisitionCost(e.target.value)} />
          </label>
          <label>
            QSV (£)
            <input type="number" value={qsv} onChange={(e) => setQsv(e.target.value)} />
          </label>
        </div>
      ) : (
        <div className="scenario-inputs">
          <label>
            Total graded basis (£)
            <input type="number" value={totalGradedBasis} onChange={(e) => setTotalGradedBasis(e.target.value)} />
          </label>
          <p className="result-count">
            Per-grade slab-value overrides aren't editable here yet — adjust the total graded basis to see the ladder
            shift.
          </p>
        </div>
      )}

      <label className="scenario-narrate-toggle">
        <input type="checkbox" checked={narrate} onChange={(e) => setNarrate(e.target.checked)} />
        Ask AI to narrate this scenario (optional, uses your daily AI spend cap)
      </label>

      <button onClick={run} disabled={state.status === "loading"}>
        {state.status === "loading" ? "Computing…" : "Run scenario"}
      </button>

      {state.status === "error" && <p className="error-banner">{state.message}</p>}
      {state.status === "loaded" && <ScenarioResultView result={state.result} />}
    </section>
  );
}

function ScenarioResultView({ result }: { result: FlipScenarioApiResult | GradeScenarioApiResult }) {
  return (
    <div className="scenario-result">
      {result.strategy === "FLIP" ? (
        <table className="ladder-table">
          <thead>
            <tr>
              <th></th>
              <th>Baseline</th>
              <th>Scenario</th>
              <th>Delta</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Net profit</td>
              <td>{currency.format(result.scenario.baseline.netProfit)}</td>
              <td>{currency.format(result.scenario.scenario.netProfit)}</td>
              <td className={result.scenario.delta.netProfit >= 0 ? "profit-positive" : "profit-negative"}>
                {result.scenario.delta.netProfit >= 0 ? "+" : ""}
                {currency.format(result.scenario.delta.netProfit)}
              </td>
            </tr>
            <tr>
              <td>Return on capital</td>
              <td>{(result.scenario.baseline.returnOnCapital * 100).toFixed(0)}%</td>
              <td>{(result.scenario.scenario.returnOnCapital * 100).toFixed(0)}%</td>
              <td className={result.scenario.delta.returnOnCapital >= 0 ? "profit-positive" : "profit-negative"}>
                {result.scenario.delta.returnOnCapital >= 0 ? "+" : ""}
                {(result.scenario.delta.returnOnCapital * 100).toFixed(0)}pp
              </td>
            </tr>
            <tr>
              <td>Profit margin</td>
              <td>{(result.scenario.baseline.profitMargin * 100).toFixed(0)}%</td>
              <td>{(result.scenario.scenario.profitMargin * 100).toFixed(0)}%</td>
              <td className={result.scenario.delta.profitMargin >= 0 ? "profit-positive" : "profit-negative"}>
                {result.scenario.delta.profitMargin >= 0 ? "+" : ""}
                {(result.scenario.delta.profitMargin * 100).toFixed(0)}pp
              </td>
            </tr>
          </tbody>
        </table>
      ) : (
        <>
          <table className="ladder-table">
            <thead>
              <tr>
                <th>Grade</th>
                <th>Baseline profit</th>
                <th>Scenario profit</th>
                <th>Delta</th>
              </tr>
            </thead>
            <tbody>
              {result.scenario.rungDeltas.map((d) => {
                const baseRung = result.scenario.baseline.rungs.find((r) => r.grade === d.grade)!;
                const scenarioRung = result.scenario.scenario.rungs.find((r) => r.grade === d.grade)!;
                return (
                  <tr key={d.grade}>
                    <td>PSA {d.grade}</td>
                    <td>{baseRung.profit !== null ? currency.format(baseRung.profit) : "no market data"}</td>
                    <td>{scenarioRung.profit !== null ? currency.format(scenarioRung.profit) : "no market data"}</td>
                    <td className={d.profitDelta !== null ? (d.profitDelta >= 0 ? "profit-positive" : "profit-negative") : ""}>
                      {d.profitDelta !== null ? `${d.profitDelta >= 0 ? "+" : ""}${currency.format(d.profitDelta)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {result.scenario.breakEvenGradeChanged && (
            <p className="warn-tag">
              Break-even grade shifts from{" "}
              {result.scenario.baseline.breakEvenGrade ? `PSA ${result.scenario.baseline.breakEvenGrade}` : "none"} to{" "}
              {result.scenario.scenario.breakEvenGrade ? `PSA ${result.scenario.scenario.breakEvenGrade}` : "none"}.
            </p>
          )}
        </>
      )}

      {result.narration && (
        <div className="scenario-narration">
          {result.narration.available ? (
            <p>{result.narration.summary}</p>
          ) : (
            <p className="hint-tag">AI narration unavailable right now — see below for why.</p>
          )}
          {result.narration.caveats.map((c, i) => (
            <p key={i} className="result-count">
              {c}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

const REVIEW_STATUS_OPTIONS: { value: ReviewStatus; label: string }[] = [
  { value: "UNREVIEWED", label: "Unreviewed" },
  { value: "CHECKED", label: "Checked" },
  { value: "INTERESTED", label: "Interested" },
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
 * SOURCING WORKFLOW item 15 built this on-demand-only (nothing is fetched
 * until the user clicks the button, so viewing a detail page never pays a
 * network call for a feature that used to always answer "not connected").
 * AI INTELLIGENCE spec Phase 2, Workstream J wired a real provider (the AI
 * Listing Analyst — packages/providers/src/advisory/AiListingAnalystProvider.ts,
 * behind Workstream I's hallucination guardrail) into the same worker
 * route (GET /api/opportunities/:id/advisory) with NO change needed here —
 * exactly the "drop-in swap on the worker side" this was built for.
 * `advisory.available` genuinely reflects whether OPENAI_API_KEY is
 * configured, today's spend cap hasn't been hit, and the guardrail didn't
 * reject the response — never assume either way from this component.
 */
/** AI INTELLIGENCE gap 2: the eight structured, evidence-backed
 *  assessments, in the order this app's own analysts would naturally check
 *  them (identity first, cost-relevant "why is this cheap" read last). A
 *  fixed order rather than however JSON happened to serialize, and only
 *  rendered when the model actually populated it — an assessment field
 *  that's undefined is never rendered as an empty/placeholder row. */
const ASSESSMENT_LABELS: { key: keyof NonNullable<Awaited<ReturnType<typeof fetchOpportunityAdvisory>>["advisory"]>; label: string }[] = [
  { key: "identity", label: "Identity" },
  { key: "itemType", label: "Item type (raw / slab / lot)" },
  { key: "variant", label: "Variant" },
  { key: "language", label: "Language" },
  { key: "condition", label: "Condition (AI read)" },
  { key: "visibleDamage", label: "Visible damage" },
  { key: "photoQuality", label: "Photo quality" },
  { key: "reasonCheap", label: "Why might this be cheap?" },
];

function AiAdvisoryPanel({ opportunityId }: { opportunityId: string }) {
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "loaded"; advisory: Awaited<ReturnType<typeof fetchOpportunityAdvisory>>["advisory"] }
  >({ status: "idle" });

  async function check() {
    setState({ status: "loading" });
    try {
      const result = await fetchOpportunityAdvisory(opportunityId);
      setState({ status: "loaded", advisory: result.advisory });
    } catch (err) {
      setState({ status: "error", message: String(err) });
    }
  }

  return (
    <section className="panel">
      <h2>AI advisory</h2>
      {state.status === "idle" && (
        <>
          <p className="result-count">Optional, on-demand only — nothing is fetched until you ask.</p>
          <button onClick={check}>Check AI advisory</button>
        </>
      )}
      {state.status === "loading" && <p className="empty-state">Checking…</p>}
      {state.status === "error" && <p className="error-banner">{state.message}</p>}
      {state.status === "loaded" && (
        <>
          {state.advisory.available ? (
            <p>{state.advisory.summary}</p>
          ) : (
            <p className="hint-tag">AI advisory unavailable right now — see below for why.</p>
          )}
          {state.advisory.caveats.map((c, i) => (
            <p key={i} className="result-count">
              {c}
            </p>
          ))}
          {state.advisory.available && (
            <dl className="advisory-assessments">
              {ASSESSMENT_LABELS.map(({ key, label }) => {
                const assessment = state.advisory[key] as { value: string; confidence: number; evidence: string } | undefined;
                if (!assessment) return null;
                return (
                  <div key={key}>
                    <dt title={`AI-reported confidence: ${Math.round(assessment.confidence * 100)}%`}>
                      {label} ({Math.round(assessment.confidence * 100)}% confidence)
                    </dt>
                    <dd>
                      {assessment.value}
                      <span className="hint-tag" title="What this assessment is based on"> — {assessment.evidence}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

/**
 * SOURCING WORKFLOW item 10 ("why is this cheap?" panel): synthesizes
 * signals this app ALREADY computes and stores — QSV/raw-market-value
 * discount, comp-sample liquidity, seller feedback, listing freshness,
 * auction/condition caveats — into one place, rather than a causal claim.
 * Deliberately framed as "things to verify," not "here is why it's cheap":
 * this app has no way to know the seller's actual reason for pricing a
 * card the way they did, and claiming otherwise would be a fabrication.
 * No new economics are computed here beyond `computePriceContext` (a pure,
 * tested function in packages/core) — everything else is data this page
 * (or the list feed) already fetches, just not previously surfaced together.
 */
/**
 * SOURCING WORKFLOW item 11 (market price-spread display): the 7-day vs
 * 30-day sold-median gap (`computeMedianPriceSpread`, packages/core) — a
 * real signal that already fed into QSV's own calculation but was never
 * shown on its own. For GRADE rows, also lists the raw PSA6-10 market
 * values side by side — genuinely different from the existing "Grade
 * ladder" table below, which shows PROFIT per grade, not the underlying
 * market VALUE per grade. Deliberately kept to the (per-opportunity, cheap)
 * detail page rather than added to the dashboard TABLE — putting it there
 * would mean the normal paginated list fetch (75 rows) always paying the
 * market_snapshots JOIN cost it's currently gated behind (`includeMarketRef`),
 * which item 19's performance goal argues against.
 */
function MarketPriceSpreadLine({ strategy, marketSnapshot }: { strategy: string; marketSnapshot: any }) {
  const spread = computeMedianPriceSpread({
    median7d: marketSnapshot.raw_median_7d,
    median30d: marketSnapshot.raw_median_30d,
  });

  const psaLadder = [
    ["Raw", marketSnapshot.raw_market_price],
    ["PSA 6", marketSnapshot.psa6],
    ["PSA 7", marketSnapshot.psa7],
    ["PSA 8", marketSnapshot.psa8],
    ["PSA 9", marketSnapshot.psa9],
    ["PSA 10", marketSnapshot.psa10],
  ].filter(([, v]) => v !== null && v !== undefined) as [string, number][];

  return (
    <p className="result-count">
      {spread.direction === null ? (
        <>7-day/30-day sold-median spread not available.</>
      ) : (
        <>
          7-day median {currency.format(marketSnapshot.raw_median_7d)} vs 30-day median{" "}
          {currency.format(marketSnapshot.raw_median_30d)} — {spread.direction}
          {spread.direction !== "STABLE" && ` (${spread.deltaFraction! > 0 ? "+" : ""}${(spread.deltaFraction! * 100).toFixed(1)}%)`}.
        </>
      )}
      {strategy === "GRADE" && psaLadder.length > 0 && (
        <>
          {" "}
          Market value by grade: {psaLadder.map(([label, v]) => `${label} ${currency.format(v)}`).join(" · ")}.
        </>
      )}
    </p>
  );
}

function WhyThisPricePanel({
  opportunity: o,
  listing,
  marketSnapshot,
}: {
  opportunity: any;
  listing: any;
  marketSnapshot: any;
}) {
  const context = computePriceContext({
    strategy: o.strategy,
    totalAcquisitionCost: o.total_acquisition_cost,
    qsv: o.qsv,
    rawMarketPrice: marketSnapshot?.raw_market_price ?? null,
  });

  const sellerQuality =
    listing?.seller_feedback_score !== undefined || listing?.seller_feedback_pct !== undefined
      ? listingQualityFromSeller(listing?.seller_feedback_score ?? undefined, listing?.seller_feedback_pct ?? undefined)
      : null;

  return (
    <section className="panel">
      <h2>Why is this priced the way it is?</h2>
      <p className="result-count">
        {context.referenceValue === null ? (
          <>No {context.referenceLabel} reference is available for this listing yet — the discount below can't be computed.</>
        ) : context.discountFraction !== null && context.discountFraction >= 0 ? (
          <>
            Delivered cost <strong>{currency.format(o.total_acquisition_cost)}</strong> is{" "}
            <strong>{(context.discountFraction * 100).toFixed(0)}% below</strong> the {currency.format(context.referenceValue)}{" "}
            {context.referenceLabel} reference.
          </>
        ) : (
          <>
            Delivered cost <strong>{currency.format(o.total_acquisition_cost)}</strong> is{" "}
            <strong>{Math.abs((context.discountFraction ?? 0) * 100).toFixed(0)}% ABOVE</strong> the{" "}
            {currency.format(context.referenceValue)} {context.referenceLabel} reference — this is not actually
            underpriced against the numbers this tool has.
          </>
        )}
      </p>
      {marketSnapshot && (
        <MarketPriceSpreadLine strategy={o.strategy} marketSnapshot={marketSnapshot} />
      )}
      <p className="result-count">Things to verify before relying on this, not reasons in themselves:</p>
      <ul className="reasoning-list">
        {marketSnapshot ? (
          <li>
            Priced against {marketSnapshot.sample_size ?? "an unknown number of"} sold comp(s) in the pricing window
            (liquidity: {marketSnapshot.liquidity}
            {o.qsv_basis ? `, QSV basis: ${o.qsv_basis}` : ""}
            {marketSnapshot.liquidity === "LOW" ? " — a thin comp set makes the reference price itself less certain" : ""}
            ).
          </li>
        ) : (
          <li>No market snapshot is linked to this opportunity — the reference above (if any) may be stale.</li>
        )}
        {sellerQuality !== null && (
          <li>
            Seller track-record signal: {sellerQuality.toFixed(2)} of 1.00 (feedback score {listing?.seller_feedback_score ?? "—"}
            , {listing?.seller_feedback_pct ?? "—"}% positive) — a heuristic blend, not a fraud check.
          </li>
        )}
        {listing?.created_at && <li>First seen in a search {formatFetchedAt(listing.created_at)}.</li>}
        {listing?.listing_type === "AUCTION" && (
          <li>This is an AUCTION — the price above is the current bid, which can rise before it ends.</li>
        )}
        {listing?.item_condition === "Graded" && (
          <li>eBay lists this item's condition as Graded — the economics on this row still assume a raw card.</li>
        )}
      </ul>
    </section>
  );
}

/**
 * SOURCING WORKFLOW item 8 (condition truth layer) — the LAST item in this
 * spec, deliberately built only after a real PokeTrace smoke test
 * (apps/worker/scripts/poketrace-smoke-test.ts, run against live data
 * 2026-09-02) confirmed what condition data PokeTrace actually returns.
 * See extractConditionTierPrices's doc comment in @mwmc/core (market/
 * conditionTiers.ts) for the full story: PokeTrace prices FIVE separate
 * raw-card condition tiers (DAMAGED/HEAVILY_PLAYED/MODERATELY_PLAYED/
 * LIGHTLY_PLAYED/NEAR_MINT), but this app's economics have only ever used
 * NEAR_MINT — silently assuming every raw listing is near-mint condition.
 * That's the gap flagged since the STABILISATION final report and pinned
 * down by the release test's case 3 (a graded slab gets the exact same
 * profit ladder as a mint raw card) and by the project doc's own
 * "Assumptions that still need live validation" notes.
 *
 * This panel is deliberately INFORMATIONAL ONLY — it never changes any
 * economics, same discipline as item 10's "why is this cheap?" panel.
 * `detectListingConditionSignal` only fires on an EXPLICIT, spelled-out
 * condition phrase in the title (see its own doc comment for why bare
 * abbreviations like "HP" are deliberately never matched on Pokémon
 * cards specifically), so a false positive here can only ever ADD a
 * caution for a human to verify, never silently suppress or re-price a
 * real opportunity.
 */
function ConditionTruthPanel({
  listing,
  marketSnapshot,
  conditionTierPrices,
}: {
  listing: any;
  marketSnapshot: any;
  conditionTierPrices: ConditionTierPrices | null;
}) {
  if (!listing) return null;

  if (listing.item_condition === "Graded") {
    return (
      <section className="panel">
        <h2>Condition truth</h2>
        <p className="result-count">
          eBay lists this item's condition as <strong>Graded</strong> — this app's economics on this row still run as
          if it were a raw card (a known, unfixed gap — see the project's own notes). Verify the slab's actual grade
          and certification number on the listing photos before relying on any number above.
        </p>
      </section>
    );
  }

  const signal = detectListingConditionSignal(listing.title);
  const assumedReference: number | null = marketSnapshot?.raw_market_price ?? null;

  const tierValueByLabel: Record<string, number | null> = {
    DAMAGED: conditionTierPrices?.damaged ?? null,
    HEAVILY_PLAYED: conditionTierPrices?.heavilyPlayed ?? null,
    MODERATELY_PLAYED: conditionTierPrices?.moderatelyPlayed ?? null,
    LIGHTLY_PLAYED: conditionTierPrices?.lightlyPlayed ?? null,
    NEAR_MINT: conditionTierPrices?.nearMint ?? null,
  };
  const detectedReference: number | null = signal.tier ? (tierValueByLabel[signal.tier] ?? null) : null;
  const tierLabel = (tier: string) => tier.replace(/_/g, " ").toLowerCase();

  return (
    <section className="panel">
      <h2>Condition truth</h2>
      {signal.tier === null && (
        <p className="result-count">
          No explicit condition claim found in the listing title. This app's economics assume the market's near-mint
          reference price ({assumedReference !== null ? currency.format(assumedReference) : "not available"}) — most
          sellers simply don't state condition in the title at all, so this is not a confirmation, just an absence of
          a red flag. Check the listing photos and description yourself before relying on it.
        </p>
      )}
      {signal.tier === "NEAR_MINT" && (
        <p className="result-count">
          The listing title itself says "{signal.matchedText}" — consistent with the near-mint reference price this
          app's economics already assume ({assumedReference !== null ? currency.format(assumedReference) : "not available"}
          ).
        </p>
      )}
      {signal.tier !== null && signal.tier !== "NEAR_MINT" && (
        <p className="result-count">
          <strong>Mismatch:</strong> the listing title says "{signal.matchedText}" ({tierLabel(signal.tier)}), but this
          app's economics above are priced against the market's near-mint reference (
          {assumedReference !== null ? currency.format(assumedReference) : "not available"}).
          {detectedReference !== null ? (
            <>
              {" "}
              PokeTrace's own {tierLabel(signal.tier)} reference for this card is{" "}
              <strong>{currency.format(detectedReference)}</strong>
              {assumedReference !== null && detectedReference < assumedReference
                ? " — a materially more honest benchmark for THIS specific listing than the near-mint number the economics above actually use."
                : "."}
            </>
          ) : (
            " PokeTrace doesn't have a separate price for this condition tier on this card, so there's no direct comparison available — verify against the photos yourself."
          )}
        </p>
      )}
      {conditionTierPrices?.source && (
        <p className="hint-tag" title="Which PokeTrace price source the condition-tier prices above came from.">
          Condition prices sourced from PokeTrace's {conditionTierPrices.source} data.
        </p>
      )}
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

/** REQUIRED hit rate — explicitly not a prediction. */
function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined) return "not computable";
  if (rate === 0) return "0% — already breaks even at the fallback grade";
  return `${(rate * 100).toFixed(1)}%`;
}
