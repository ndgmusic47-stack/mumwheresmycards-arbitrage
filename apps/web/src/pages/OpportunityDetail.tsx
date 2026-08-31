import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchOpportunityDetail, type GradeRung } from "../api/client";
import { StateBadge, ScoreBadge, EconomicClassBadge } from "../components/ScoreBadge";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

export function OpportunityDetail() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchOpportunityDetail>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchOpportunityDetail(id)
      .then(setData)
      .catch((err) => setError(String(err)));
  }, [id]);

  if (error) return <p className="error-banner">{error}</p>;
  if (!data) return <p className="empty-state">Loading…</p>;

  const { opportunity: o, card, listing, reasoning } = data;

  return (
    <div>
      <Link to="/" className="back-link">
        ← Back to opportunities
      </Link>

      <div className="page-header">
        <h1>
          {card?.name} — {card?.set_name} #{card?.card_number}
        </h1>
        <StateBadge state={o.state} />
      </div>

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
                Seller: {listing.seller_username} ({listing.seller_feedback_score} feedback, {listing.seller_feedback_pct}%)
              </p>
              <p>
                Price: {currency.format(listing.price)} + {currency.format(listing.shipping_cost)} postage
              </p>
              <a href={listing.item_url} target="_blank" rel="noreferrer">
                View on eBay ↗
              </a>
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
      </div>
    </div>
  );
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
