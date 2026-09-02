import { Link } from "react-router-dom";
import type { OpportunityListItem } from "../api/client";
import { ScoreBadge, StateBadge, EconomicClassBadge } from "./ScoreBadge";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

const money = (n: number | null | undefined) => (n === null || n === undefined ? "—" : currency.format(n));
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(0)}%`);
const pct1 = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);
const days = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n)}d`);
const profitClass = (n: number | null | undefined) =>
  n === null || n === undefined ? "" : n >= 0 ? "profit-positive" : "profit-negative";

/**
 * FLIP and GRADE are different trades with different economics, so they get
 * different tables rather than one table of mostly-empty shared columns.
 * Each row shows enough to judge the trade in seconds — including the
 * downside, which is never hidden.
 */
export function OpportunityTable({ opportunities }: { opportunities: OpportunityListItem[] }) {
  if (opportunities.length === 0) {
    return <p className="empty-state">No opportunities match the current filters.</p>;
  }

  const flips = opportunities.filter((o) => o.strategy === "FLIP");
  const grades = opportunities.filter((o) => o.strategy === "GRADE");

  return (
    <>
      {flips.length > 0 && <FlipTable opportunities={flips} />}
      {grades.length > 0 && <GradeTable opportunities={grades} />}
    </>
  );
}

function CardCell({ o }: { o: OpportunityListItem }) {
  return (
    <td>
      <Link to={`/opportunity/${o.id}`}>
        {o.card_name} — {o.card_set_name} #{o.card_number}
      </Link>
      <div className="card-variant-tag">
        {o.card_edition !== "na" ? o.card_edition + " " : ""}
        {o.card_finish !== "na" ? o.card_finish + " " : ""}
        {o.card_variant}
      </div>
    </td>
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
 *  here so it's visible without opening the detail page. Item condition is
 *  shown alongside it when eBay reported one.
 *
 *  STABILISATION item 8 (freshness): a non-ACTIVE listing_status (currently
 *  only 'ENDED', for auctions past their end_time — see
 *  expireEndedAuctionListings()) is surfaced as its own tag rather than
 *  hidden — the opportunity stays visible, just honestly labelled. Every
 *  row also carries listing_fetched_at as a tooltip so "how fresh is this,
 *  really" is always one hover away instead of assumed. */
function ListingMeta({ o }: { o: OpportunityListItem }) {
  return (
    <>
      {o.listing_type === "AUCTION" && (
        <div className="warn-tag" title="Price shown is the CURRENT bid — it may rise before the auction ends">
          AUCTION
        </div>
      )}
      {o.listing_status !== "ACTIVE" && (
        <div className="warn-tag" title={`Listing status: ${o.listing_status}`}>
          {o.listing_status}
        </div>
      )}
      {o.listing_item_condition && <div className="hint-tag">{o.listing_item_condition}</div>}
      <div className="hint-tag" title="Last time this exact listing was re-observed in a search">
        seen {formatFetchedAt(o.listing_fetched_at)}
      </div>
    </>
  );
}

/** Renders listing_fetched_at (a D1 `datetime('now')` UTC string) as a
 *  rough relative age. Deliberately coarse (minutes/hours/days) — this is a
 *  freshness hint, not a precise timestamp, and coarseness avoids timezone
 *  edge cases mattering. */
function formatFetchedAt(fetchedAt: string): string {
  const then = new Date(fetchedAt.includes("Z") || fetchedAt.includes("T") ? fetchedAt : `${fetchedAt.replace(" ", "T")}Z`);
  if (Number.isNaN(then.getTime())) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - then.getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function FlipTable({ opportunities }: { opportunities: OpportunityListItem[] }) {
  return (
    <div className="strategy-block">
      <h2 className="strategy-heading">
        RAW FLIP <span className="strategy-count">{opportunities.length}</span>
      </h2>
      <div className="table-scroll">
        <table className="opp-table">
          <thead>
            <tr>
              <th>Score</th>
              <th>Card</th>
              <th>State</th>
              <th>Listing</th>
              <th title="Item price + postage + tax + fees">Delivered cost</th>
              <th title="Quick Sale Value: lower of the 7d/30d sold medians, less an 8% haircut">QSV</th>
              <th title="Net sale cash minus total acquisition — after eBay fees, fee VAT, postage and packaging">
                True net profit
              </th>
              <th title="True net profit / total acquisition">ROC</th>
              <th title="True net profit / buyer payment">Margin</th>
              <th>Liquidity</th>
              <th>Confidence</th>
              <th title="Estimated days from purchase to completed sale">Days to sale</th>
              <th>eBay</th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((o) => (
              <tr key={o.id} className={o.qualifies === 1 ? "row-qualified" : undefined}>
                <td>
                  <ScoreBadge score={o.score ?? o.flip_score} />
                </td>
                <CardCell o={o} />
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
                <td className={profitClass(o.expected_net_profit)}>{money(o.expected_net_profit)}</td>
                <td className={profitClass(o.return_on_capital)}>{pct(o.return_on_capital)}</td>
                <td>{pct(o.profit_margin)}</td>
                <td>{o.liquidity}</td>
                <td>{pct(o.confidence)}</td>
                <td>{days(o.days_to_sale_estimate)}</td>
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

/**
 * STABILISATION item 10: REVIEW / NEAR_MISS / REJECTED rows don't fit the
 * FLIP/GRADE economics tables — many of their economics fields are null by
 * construction (no market data, identity uncertain, a computation error).
 * Forcing them through FlipTable/GradeTable would print a wall of "—".
 * Instead this surfaces the one thing that actually explains each row: the
 * already-fetched-but-previously-unused `qualification_failures` field the
 * engine attaches to every non-qualifying candidate.
 */
export function ReasonsTable({ opportunities }: { opportunities: OpportunityListItem[] }) {
  if (opportunities.length === 0) {
    return <p className="empty-state">No opportunities match the current filters.</p>;
  }

  return (
    <div className="table-scroll">
      <table className="opp-table">
        <thead>
          <tr>
            <th>Card</th>
            <th>State</th>
            <th>Strategy</th>
            <th>Listing price</th>
            <th>Reasons</th>
            <th>eBay</th>
          </tr>
        </thead>
        <tbody>
          {opportunities.map((o) => (
            <tr key={o.id}>
              <CardCell o={o} />
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

function GradeTable({ opportunities }: { opportunities: OpportunityListItem[] }) {
  return (
    <div className="strategy-block">
      <h2 className="strategy-heading">
        RAW → GRADED <span className="strategy-count">{opportunities.length}</span>
      </h2>
      <div className="table-scroll">
        <table className="opp-table">
          <thead>
            <tr>
              <th>Score</th>
              <th>Card</th>
              <th title="The economic structure of this trade — see the rationale on the detail page">Class</th>
              <th>Raw price</th>
              <th title="Item price + postage + tax + fees">Delivered raw</th>
              <th>Service</th>
              <th title="Everything committed to get one saleable slab, including this card's share of batch logistics">
                Graded basis
              </th>
              <th title="Lowest grade at which this trade breaks even">Break-even</th>
              <th>PSA7</th>
              <th>PSA8</th>
              <th>PSA9</th>
              <th>PSA10</th>
              <th title="How often this must come back a PSA 10 to break even, if every other one grades PSA 9. REQUIRED, not predicted.">
                Req. 10 rate
              </th>
              <th title="Grading turnaround plus estimated time to sell — an estimate">Capital lock</th>
              <th>Liquidity</th>
              <th>Confidence</th>
              <th>eBay</th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((o) => (
              <tr key={o.id} className={o.qualifies === 1 ? "row-qualified" : undefined}>
                <td>
                  <ScoreBadge score={o.score ?? o.grade_score} />
                </td>
                <CardCell o={o} />
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
