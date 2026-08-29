import { Link } from "react-router-dom";
import type { OpportunityListItem } from "../api/client";
import { ScoreBadge, StateBadge } from "./ScoreBadge";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });
const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(0)}%`);

export function OpportunityTable({ opportunities }: { opportunities: OpportunityListItem[] }) {
  if (opportunities.length === 0) {
    return <p className="empty-state">No opportunities match the current filters.</p>;
  }

  const hasGrade = opportunities.some((o) => o.strategy === "GRADE");

  return (
    <div className="table-scroll">
      <table className="opp-table">
        <thead>
          <tr>
            <th>Score</th>
            <th>Card</th>
            <th>Strategy</th>
            <th>State</th>
            <th>Listing</th>
            <th>Acquisition</th>
            <th>QSV</th>
            <th>Profit</th>
            <th>ROC</th>
            <th>Liquidity</th>
            <th>Confidence</th>
            {hasGrade && (
              <>
                <th>Graded basis</th>
                <th>PSA8</th>
                <th>PSA9</th>
                <th>PSA10</th>
                <th>Break-even</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {opportunities.map((o) => (
            <tr key={o.id}>
              <td>
                <ScoreBadge score={o.strategy === "FLIP" ? o.flip_score : o.grade_score} />
              </td>
              <td>
                <Link to={`/opportunity/${o.id}`}>
                  {o.card_name} — {o.card_set_name} #{o.card_number}
                  <div className="card-variant-tag">
                    {o.card_edition !== "na" ? o.card_edition + " " : ""}
                    {o.card_finish !== "na" ? o.card_finish + " " : ""}
                    {o.card_variant}
                  </div>
                </Link>
              </td>
              <td>{o.strategy}</td>
              <td>
                <StateBadge state={o.state} />
              </td>
              <td>{currency.format(o.listing_price)}</td>
              <td>{currency.format(o.total_acquisition_cost)}</td>
              <td>{o.qsv !== null ? currency.format(o.qsv) : "—"}</td>
              <td className={((o.expected_net_profit ?? o.psa9_profit ?? 0) >= 0 ? "profit-positive" : "profit-negative")}>
                {o.expected_net_profit !== null
                  ? currency.format(o.expected_net_profit)
                  : o.psa9_profit !== null
                    ? currency.format(o.psa9_profit) + " (PSA9)"
                    : "—"}
              </td>
              <td>{pct(o.return_on_capital)}</td>
              <td>{o.liquidity}</td>
              <td>{pct(o.confidence)}</td>
              {hasGrade && (
                <>
                  <td>{o.total_graded_basis !== null ? currency.format(o.total_graded_basis) : "—"}</td>
                  <td>{o.psa8_profit !== null ? currency.format(o.psa8_profit) : "—"}</td>
                  <td>{o.psa9_profit !== null ? currency.format(o.psa9_profit) : "—"}</td>
                  <td>{o.psa10_profit !== null ? currency.format(o.psa10_profit) : "—"}</td>
                  <td>{o.break_even_grade ? `PSA ${o.break_even_grade}` : "None"}</td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
