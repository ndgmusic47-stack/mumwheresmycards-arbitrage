import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { fetchOpportunityDetail } from "../api/client";
import { StateBadge, ScoreBadge } from "../components/ScoreBadge";

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
                <ScoreBadge score={o.grade_score} />
              </dd>
              <dt>Total graded basis</dt>
              <dd>{o.total_graded_basis !== null ? currency.format(o.total_graded_basis) : "—"}</dd>
              <dt>Break-even grade</dt>
              <dd>{o.break_even_grade ? `PSA ${o.break_even_grade}` : "None"}</dd>
              <dt>PSA10 upside multiple</dt>
              <dd>{o.psa10_upside_multiple !== null ? `${o.psa10_upside_multiple.toFixed(1)}x` : "—"}</dd>
            </dl>
          )}
        </section>

        {o.strategy === "GRADE" && (
          <section className="panel">
            <h2>Grade ladder</h2>
            <table className="ladder-table">
              <thead>
                <tr>
                  <th>Grade</th>
                  <th>Profit</th>
                </tr>
              </thead>
              <tbody>
                {[6, 7, 8, 9, 10].map((g) => {
                  const key = `psa${g}_profit` as keyof typeof o;
                  const profit = o[key] as number | null;
                  return (
                    <tr key={g}>
                      <td>PSA {g}</td>
                      <td className={profit !== null && profit >= 0 ? "profit-positive" : "profit-negative"}>
                        {profit !== null ? currency.format(profit) : "no market data"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
