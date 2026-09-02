import { useState } from "react";
import {
  fetchMarketCards,
  triggerSyncAndProfile,
  type MarketCardFilters,
  type MarketCardItem,
  type SyncAndProfileReport,
} from "../api/client";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

const EMPTY_FILTERS: MarketCardFilters = {};

/** Page size for browsing the catalogue. STABILISATION item 2: the old
 *  behaviour capped every search at 500 rows total with no way to see or
 *  reach anything past that over a ~6,000-card catalogue. This is now a
 *  page size with a "Load more" control, not a hard ceiling. */
const PAGE_SIZE = 200;

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
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncReport, setSyncReport] = useState<SyncAndProfileReport | null>(null);

  function set<K extends keyof MarketCardFilters>(key: K, value: MarketCardFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  async function runSearch() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMarketCards({ ...filters, limit: PAGE_SIZE, offset: 0 });
      setCards(result.cards);
      setTotal(result.total);
      setSearched(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    setLoadingMore(true);
    setError(null);
    try {
      const result = await fetchMarketCards({ ...filters, limit: PAGE_SIZE, offset: cards.length });
      setCards((prev) => [...prev, ...result.cards]);
      setTotal(result.total);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  /** Loads real catalogue + market data into the database, straight from the
   *  browser — catalogue sync + market profiling ONLY, never eBay. This is
   *  the button form of the `POST /catalogue/sync-and-profile` endpoint
   *  documented in apps/worker/README.md section 11, so nobody needs curl
   *  just to get data into a fresh local database. */
  async function runSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const report = await triggerSyncAndProfile();
      setSyncReport(report);
    } catch (err) {
      setSyncError(String(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <h1>Market</h1>
        <button onClick={runSync} disabled={syncing} title="Loads real catalogue + pricing data — catalogue sync and market profiling only, never eBay">
          {syncing ? "Syncing catalogue…" : "Sync catalogue (no eBay)"}
        </button>
        <button onClick={runSearch} disabled={loading}>
          {loading ? "Searching…" : "Search catalogue"}
        </button>
      </div>

      {syncError && <p className="error-banner">{syncError}</p>}
      {syncReport && <SyncReportPanel report={syncReport} />}

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
          <p className="result-count">
            {cards.length} of {total} matching cards loaded.
          </p>
          <MarketTable cards={cards} />
          {total - cards.length > 0 && (
            <button className="load-more-button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : `Load ${Math.min(PAGE_SIZE, total - cards.length)} more (${total - cards.length} not yet loaded)`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Summary of a catalogue-sync-and-profile run — the browser-native
 *  replacement for pasting the same JSON from curl. See
 *  apps/worker/README.md section 11 for what each field means and why it
 *  matters (in particular cardsWithNullYear and multiMarketCards, the two
 *  open questions this endpoint exists to answer with real PokeTrace data). */
function SyncReportPanel({ report }: { report: SyncAndProfileReport }) {
  return (
    <div className="sync-report">
      <p className="result-count">
        Synced against <strong>{report.ranAgainst}</strong> — {report.catalogueSync.cards_inserted} new,{" "}
        {report.catalogueSync.cards_updated} updated, {report.catalogueSync.cards_skipped} skipped across{" "}
        {report.catalogueSync.pages_fetched} page(s). Profiled {report.marketProfiling.cardsProfiled} of{" "}
        {report.marketProfiling.cardsConsidered} candidate cards ({report.marketProfiling.snapshotsFetched} new
        market snapshots fetched).
      </p>
      <p className="result-count">
        Catalogue now holds {report.catalogueTotals.cardsIndexed} cards — {report.catalogueTotals.cardsWithNullYear}{" "}
        with no resolvable year, {report.catalogueTotals.cardsWithRawValue} with a raw market value,{" "}
        {report.catalogueTotals.cardsWithAnyPsaGrade} with at least one PSA grade priced.
      </p>
      <p className="result-count">
        <strong>QSV data:</strong> of {report.qsvCoverage.snapshots} snapshot(s),{" "}
        {report.qsvCoverage.withBothMedians} have both sold medians, {report.qsvCoverage.withSevenDayMedian} have
        a 7-day median, {report.qsvCoverage.withThirtyDayMedian} have a 30-day median, and{" "}
        {report.qsvCoverage.withNeitherMedian} have neither.{" "}
        {report.qsvCoverage.highConfidenceQsv} produced a high-confidence QSV.
        {report.qsvCoverage.snapshots > 0 &&
          report.qsvCoverage.highConfidenceQsv === 0 &&
          " No card has a usable sold median — raw flips cannot qualify on this data."}
      </p>
      <p className="result-count">
        Universe: {report.universeEligibility.flipEligible} flip-eligible,{" "}
        {report.universeEligibility.gradeEligible} grade-eligible.
        {report.gradeEconomicClasses.length > 0 && (
          <>
            {" "}
            Grading structures:{" "}
            {report.gradeEconomicClasses
              .map((c) => `${c.economic_class ?? "unclassified"} ${c.n}`)
              .join(", ")}
            .
          </>
        )}
      </p>
      <p className="result-count">
        {report.multiMarketCards.count} card(s) have more than one market's price data (currently preferring{" "}
        {report.multiMarketCards.preferenceCurrentlyUsed.join(" > ")}).
        {report.multiMarketCards.samples.length > 0 && (
          <>
            {" "}
            Examples:{" "}
            {report.multiMarketCards.samples
              .map((s) => `${s.internal_card_id.slice(0, 8)}… (${s.ref_count}: ${s.markets})`)
              .join(", ")}
          </>
        )}
      </p>
      {(report.catalogueSync.errors || report.marketProfiling.errors.length > 0) && (
        <p className="error-banner">
          {report.catalogueSync.errors ? `Catalogue sync errors: ${report.catalogueSync.errors}. ` : ""}
          {report.marketProfiling.errors.length > 0
            ? `Market profiling errors: ${report.marketProfiling.errors.join("; ")}`
            : ""}
        </p>
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
