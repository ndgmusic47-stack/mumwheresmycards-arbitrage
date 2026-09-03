import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchMarketCards,
  triggerSyncAndProfile,
  type MarketCardFilters,
  type MarketCardItem,
  type MarketSortKey,
  type SyncAndProfileReport,
} from "../api/client";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

const EMPTY_FILTERS: MarketCardFilters = {};

/** SOURCING WORKFLOW task #53: the backend (routes/market.ts) has supported
 *  real page-based pagination (`page`/`pageCount`) and server-side sorting
 *  (`sort`/`dir`, via buildMarketSortClause) since item 4/5's own batch —
 *  this page just never called with those params, and instead accumulated
 *  an ever-growing "Load more" list capped at whatever fit in the browser.
 *  Switched to the same Previous/Next paging pattern Dashboard.tsx already
 *  uses (item 4), same 75-row page size, and the same URL-persisted
 *  filters/sort/page (item 3) so a bookmark or a browser refresh lands on
 *  the same view. */
const PAGE_SIZE = 75;

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
  const [searchParams, setSearchParams] = useSearchParams();

  const filters: MarketCardFilters = useMemo(() => {
    const raw = searchParams.get("f");
    if (!raw) return EMPTY_FILTERS;
    try {
      return JSON.parse(raw) as MarketCardFilters;
    } catch {
      return EMPTY_FILTERS;
    }
    // eslint-disable-next-line
  }, [searchParams]);

  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const sort = (searchParams.get("sort") as MarketSortKey | null) ?? undefined;
  const dir = (searchParams.get("dir") as "asc" | "desc" | null) ?? "desc";

  function updateUrl(next: { f?: MarketCardFilters; page?: number; sort?: MarketSortKey; dir?: "asc" | "desc" }) {
    const params = new URLSearchParams(searchParams);
    if (next.f !== undefined) params.set("f", JSON.stringify(next.f));
    if (next.page !== undefined) params.set("page", String(next.page));
    if (next.sort !== undefined) params.set("sort", next.sort);
    if (next.dir !== undefined) params.set("dir", next.dir);
    setSearchParams(params, { replace: true });
  }

  function set<K extends keyof MarketCardFilters>(key: K, value: MarketCardFilters[K]) {
    updateUrl({ f: { ...filters, [key]: value } });
  }

  function setSort(key: MarketSortKey) {
    if (sort === key) {
      updateUrl({ dir: dir === "asc" ? "desc" : "asc", page: 1 });
    } else {
      // "Best first" reads as descending for every column here except a
      // plain alphabetical name sort, which naturally starts A→Z.
      updateUrl({ sort: key, dir: key === "name" ? "asc" : "desc", page: 1 });
    }
  }

  const [cards, setCards] = useState<MarketCardItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncReport, setSyncReport] = useState<SyncAndProfileReport | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchMarketCards({ ...filters, limit: PAGE_SIZE, page, sort, dir });
      setCards(result.cards);
      setTotal(result.total);
      setPageCount(result.pageCount);
      setSearched(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  // Runs on the initial "Search catalogue" click (via runSearch below) and
  // again automatically whenever the page, sort, or filters change — same
  // pattern as Dashboard.tsx, so clicking a column header or Previous/Next
  // doesn't need its own separate handler wired up to fetchMarketCards.
  useEffect(() => {
    if (!searched) return;
    load();
    // eslint-disable-next-line
  }, [page, sort, dir, JSON.stringify(filters)]);

  function runSearch() {
    // A fresh search always starts at page 1 — staying on, say, page 6 of a
    // now-much-smaller result set would just show "no results" for no
    // visible reason (same reasoning as Dashboard's setFilters).
    if (page !== 1) {
      updateUrl({ page: 1 });
    }
    setSearched(true);
    load();
  }

  function setPage(next: number) {
    updateUrl({ page: Math.max(1, Math.min(pageCount, next)) });
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
            Page {page} of {pageCount} — {total} matching card(s) total.
          </p>
          <MarketTable cards={cards} sort={sort} dir={dir} onSort={setSort} />
          <PaginationBar page={page} pageCount={pageCount} onChange={setPage} />
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

/** Same click-to-sort header used by Dashboard's opportunity tables
 *  (OpportunityTable.tsx's SortableTh) — reuses the same `.sortable-th`/
 *  `.sort-arrow` CSS rather than introducing a parallel style, but kept as
 *  its own small component here since the two tables sort by genuinely
 *  different key types (MarketSortKey vs OpportunitySortKey). */
function SortableMarketTh({
  label,
  sortKey,
  sort,
  dir,
  onSort,
}: {
  label: string;
  sortKey: MarketSortKey;
  sort: MarketSortKey | undefined;
  dir: "asc" | "desc";
  onSort: (key: MarketSortKey) => void;
}) {
  const active = sort === sortKey;
  const arrow = active ? (dir === "asc" ? "▲" : "▼") : "";
  return (
    <th title="Click to sort" className="sortable-th" onClick={() => onSort(sortKey)}>
      {label}
      {arrow && <span className="sort-arrow">{arrow}</span>}
    </th>
  );
}

/** SOURCING WORKFLOW item 4's Previous / Page X of Y / Next control,
 *  duplicated here rather than imported from Dashboard.tsx — that
 *  component isn't exported, and this page's page/pageCount live in local
 *  state rather than Dashboard's. Same markup/CSS classes either way. */
function PaginationBar({ page, pageCount, onChange }: { page: number; pageCount: number; onChange: (page: number) => void }) {
  if (pageCount <= 1) return null;
  return (
    <div className="pagination-bar">
      <button onClick={() => onChange(page - 1)} disabled={page <= 1}>
        ← Previous
      </button>
      <span className="page-indicator">
        Page {page} of {pageCount}
      </span>
      <button onClick={() => onChange(page + 1)} disabled={page >= pageCount}>
        Next →
      </button>
    </div>
  );
}

function MarketTable({
  cards,
  sort,
  dir,
  onSort,
}: {
  cards: MarketCardItem[];
  sort: MarketSortKey | undefined;
  dir: "asc" | "desc";
  onSort: (key: MarketSortKey) => void;
}) {
  if (cards.length === 0) return <p className="empty-state">No catalogued cards match these filters.</p>;

  return (
    <div className="table-scroll">
      <table className="opp-table">
        <thead>
          <tr>
            <SortableMarketTh label="Card" sortKey="name" sort={sort} dir={dir} onSort={onSort} />
            <SortableMarketTh label="Raw" sortKey="raw_market_value" sort={sort} dir={dir} onSort={onSort} />
            <SortableMarketTh label="QSV" sortKey="qsv" sort={sort} dir={dir} onSort={onSort} />
            <SortableMarketTh label="PSA8" sortKey="psa8" sort={sort} dir={dir} onSort={onSort} />
            <SortableMarketTh label="PSA9" sortKey="psa9" sort={sort} dir={dir} onSort={onSort} />
            <SortableMarketTh label="PSA10" sortKey="psa10" sort={sort} dir={dir} onSort={onSort} />
            <SortableMarketTh label="Break-even" sortKey="break_even_grade" sort={sort} dir={dir} onSort={onSort} />
            <SortableMarketTh label="Flip score" sortKey="flip_score" sort={sort} dir={dir} onSort={onSort} />
            <SortableMarketTh label="Grade score" sortKey="grade_score" sort={sort} dir={dir} onSort={onSort} />
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
