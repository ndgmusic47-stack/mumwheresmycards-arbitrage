import { useState } from "react";
import { fetchMarketCards, type MarketCardFilters, type MarketCardItem } from "../api/client";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

const EMPTY_FILTERS: MarketCardFilters = {};

/**
 * MARKET tab: browses the ENTIRE auto-synced card database (CARD MARKET
 * layer), independent of any current eBay listing — "is this card
 * economically interesting?" rather than "can I buy it right now?". Filter
 * set matches the realignment brief exactly: raw price range, PSA8/9/10
 * minimums, break-even grade ceiling, grade/flip score minimums, liquidity
 * and confidence minimums, raw sales (sold-comp count) minimum, plus
 * set/name/variant text filters.
 */
export function Market() {
  const [filters, setFilters] = useState<MarketCardFilters>(EMPTY_FILTERS);
  const [cards, setCards] = useState<MarketCardItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  function set<K extends keyof MarketCardFilters>(key: K, value: MarketCardFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  async function runSearch() {
    setLoading(true);
    setError(null);
    try {
      const { cards } = await fetchMarketCards(filters);
      setCards(cards);
      setSearched(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Market</h1>
        <button onClick={runSearch} disabled={loading}>
          {loading ? "Searching…" : "Search catalogue"}
        </button>
      </div>

      <div className="filter-bar">
        <label>
          Raw price min (£)
          <input type="number" value={filters.rawMin ?? ""} onChange={(e) => set("rawMin", numOrUndefined(e.target.value))} />
        </label>
        <label>
          Raw price max (£)
          <input type="number" value={filters.rawMax ?? ""} onChange={(e) => set("rawMax", numOrUndefined(e.target.value))} />
        </label>
        <label>
          PSA8 min (£)
          <input type="number" value={filters.psa8Min ?? ""} onChange={(e) => set("psa8Min", numOrUndefined(e.target.value))} />
        </label>
        <label>
          PSA9 min (£)
          <input type="number" value={filters.psa9Min ?? ""} onChange={(e) => set("psa9Min", numOrUndefined(e.target.value))} />
        </label>
        <label>
          PSA10 min (£)
          <input type="number" value={filters.psa10Min ?? ""} onChange={(e) => set("psa10Min", numOrUndefined(e.target.value))} />
        </label>
        <label>
          Break-even ≤ PSA
          <input
            type="number"
            min={6}
            max={10}
            value={filters.breakEvenMax ?? ""}
            onChange={(e) => set("breakEvenMax", numOrUndefined(e.target.value))}
          />
        </label>
        <label>
          Grade score min
          <input type="number" value={filters.gradeScoreMin ?? ""} onChange={(e) => set("gradeScoreMin", numOrUndefined(e.target.value))} />
        </label>
        <label>
          Flip score min
          <input type="number" value={filters.flipScoreMin ?? ""} onChange={(e) => set("flipScoreMin", numOrUndefined(e.target.value))} />
        </label>
        <label>
          Liquidity ≥
          <select value={filters.liquidityMin ?? ""} onChange={(e) => set("liquidityMin", e.target.value || undefined)}>
            <option value="">Any</option>
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="VERY_HIGH">Very high</option>
          </select>
        </label>
        <label>
          Confidence min (%)
          <input
            type="number"
            value={filters.confidenceMin !== undefined ? Math.round(filters.confidenceMin * 100) : ""}
            onChange={(e) => set("confidenceMin", e.target.value ? Number(e.target.value) / 100 : undefined)}
          />
        </label>
        <label>
          Raw sales min
          <input type="number" value={filters.rawSalesMin ?? ""} onChange={(e) => set("rawSalesMin", numOrUndefined(e.target.value))} />
        </label>
        <label>
          Set
          <input type="text" value={filters.set ?? ""} onChange={(e) => set("set", e.target.value || undefined)} />
        </label>
        <label>
          Name
          <input type="text" value={filters.name ?? ""} onChange={(e) => set("name", e.target.value || undefined)} />
        </label>
        <label>
          Strategy
          <select value={filters.strategy ?? ""} onChange={(e) => set("strategy", (e.target.value || undefined) as MarketCardFilters["strategy"])}>
            <option value="">Any</option>
            <option value="FLIP">Flip-eligible</option>
            <option value="GRADE">Grade-eligible</option>
          </select>
        </label>
      </div>

      {error && <p className="error-banner">{error}</p>}

      {!searched && !loading && (
        <p className="empty-state">Set your filters and search the full catalogue — e.g. Raw £5–£50, PSA10 ≥ £1,000, Break-even ≤ PSA 9, Liquidity ≥ Medium.</p>
      )}

      {searched && !loading && (
        <>
          <p className="result-count">{cards.length} cards match.</p>
          <MarketTable cards={cards} />
        </>
      )}
    </div>
  );
}

function MarketTable({ cards }: { cards: MarketCardItem[] }) {
  if (cards.length === 0) return <p className="empty-state">No catalogued cards match these filters.</p>;

  return (
    <div className="table-scroll">
      <table className="opp-table">
        <thead>
          <tr>
            <th>Card</th>
            <th>Raw</th>
            <th>QSV</th>
            <th>PSA8</th>
            <th>PSA9</th>
            <th>PSA10</th>
            <th>Break-even</th>
            <th>Flip score</th>
            <th>Grade score</th>
            <th>Flip eligible</th>
            <th>Grade eligible</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => (
            <tr key={c.id}>
              <td>
                {c.name} — {c.set_name} #{c.card_number}
                <div className="card-variant-tag">
                  {c.edition !== "na" ? c.edition + " " : ""}
                  {c.finish !== "na" ? c.finish + " " : ""}
                  {c.variant}
                </div>
              </td>
              <td>{money(c.raw_market_value)}</td>
              <td>{money(c.conservative_qsv)}</td>
              <td>{money(c.psa8)}</td>
              <td>{money(c.psa9)}</td>
              <td>{money(c.psa10)}</td>
              <td>{c.break_even_grade ? `PSA ${c.break_even_grade}` : "—"}</td>
              <td>{c.flip_market_score ?? "—"}</td>
              <td>{c.grade_market_score ?? "—"}</td>
              <td>{c.flip_eligible ? "Yes" : "—"}</td>
              <td>{c.grade_eligible ? "Yes" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function money(n: number | null): string {
  return n === null ? "—" : currency.format(n);
}

function numOrUndefined(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}
