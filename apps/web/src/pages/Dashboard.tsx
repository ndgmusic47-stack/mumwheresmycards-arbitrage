import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchOpportunities,
  fetchOpportunitiesForExport,
  fetchScanCoverage,
  triggerScan,
  type OpportunityCounts,
  type OpportunityListItem,
  type OpportunityQueryParams,
  type OpportunitySortKey,
  type ScanCoverageStats,
  type ScanRunSummary,
} from "../api/client";
import { OpportunityTable, ReasonsTable, type OpportunityBrowseQueue } from "../components/OpportunityTable";
import { FilterBar } from "../components/FilterBar";
import { SummaryStats } from "../components/SummaryStats";
import { exportOpportunitiesToXlsx } from "../utils/xlsxExport";
import {
  DEFAULT_DASHBOARD_FILTERS,
  applyDashboardFilters,
  buildServerFilterParams,
  CATEGORY_STATES,
  type DashboardFilters,
} from "../state/filters";

/** SOURCING WORKFLOW item 4: real server-side paging, not a growing
 *  "Load N more" list — 75 rows/page sits in the spec's suggested 50-100
 *  range. Item 19 (performance): the browser only ever holds ONE page's
 *  worth of rows, whatever the underlying dataset size. */
const PAGE_SIZE = 75;

/** SOURCING WORKFLOW item 3: sessionStorage key for "where was I" — scroll
 *  position and the last-opened row, scoped per strategy tab since each tab
 *  is really a separate sourcing session. URL query params (page/sort/f)
 *  carry the rest of the state and are restored automatically by the
 *  browser's own back-navigation, since they're part of the URL. */
function sessionKey(strategyTab: string) {
  return `mwmc-sourcing-session-${strategyTab}`;
}

interface StoredSession {
  scrollY: number;
  lastViewedId: string | null;
}

function readSession(strategyTab: string): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(strategyTab));
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

function writeSession(strategyTab: string, session: StoredSession) {
  try {
    sessionStorage.setItem(sessionKey(strategyTab), JSON.stringify(session));
  } catch {
    // sessionStorage can throw in a private-browsing context — this is a
    // convenience, never load-bearing, so fail silently.
  }
}

export function Dashboard({ strategyTab }: { strategyTab: "ALL" | "FLIP" | "GRADE" }) {
  const [searchParams, setSearchParams] = useSearchParams();

  const [opportunities, setOpportunities] = useState<OpportunityListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [counts, setCounts] = useState<OpportunityCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<ScanRunSummary | null>(null);
  const [lastScanCoverage, setLastScanCoverage] = useState<{
    cardsProfiledThisRun: number;
    cardsSearchedThisRun: number;
    ebayApiCallsThisRun: number;
    duplicateListingsThisRun: number;
    enrichedListingsThisRun: number;
  } | null>(null);
  const [coverage, setCoverage] = useState<ScanCoverageStats | null>(null);

  // ---- SOURCING WORKFLOW item 3: filters/sort/page all live in the URL,
  // so a bookmark, a browser refresh, or clicking Back from Opportunity
  // Detail all land on exactly the same view. `f` carries the full
  // DashboardFilters object (every field the FilterBar exposes); `page`,
  // `sort`, `dir` are kept as their own readable params.
  const filters: DashboardFilters = useMemo(() => {
    const raw = searchParams.get("f");
    let parsed: Partial<DashboardFilters> = {};
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {};
      }
    }
    return { ...DEFAULT_DASHBOARD_FILTERS, ...parsed, strategy: strategyTab };
    // eslint-disable-next-line
  }, [searchParams, strategyTab]);

  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  // Item 5's own default: "newest actionable listings first" rather than an
  // arbitrary score-only ordering, unless the user has picked a sort.
  const sort = (searchParams.get("sort") as OpportunitySortKey | null) ?? "newest";
  const dir = (searchParams.get("dir") as "asc" | "desc" | null) ?? "desc";

  function updateUrl(next: { f?: DashboardFilters; page?: number; sort?: OpportunitySortKey; dir?: "asc" | "desc" }) {
    const params = new URLSearchParams(searchParams);
    if (next.f !== undefined) params.set("f", JSON.stringify(next.f));
    if (next.page !== undefined) params.set("page", String(next.page));
    if (next.sort !== undefined) params.set("sort", next.sort);
    if (next.dir !== undefined) params.set("dir", next.dir);
    setSearchParams(params, { replace: true });
  }

  function setFilters(next: DashboardFilters) {
    // Any filter or category change resets to page 1 — staying on, say,
    // page 4 of a now-much-smaller result set would just show "no results"
    // for no visible reason.
    updateUrl({ f: next, page: 1 });
  }

  function setPage(next: number) {
    updateUrl({ page: Math.max(1, Math.min(pageCount, next)) });
  }

  function setSort(key: OpportunitySortKey) {
    // Clicking the already-active column reverses direction; a new column
    // starts descending (the more common "best first" reading for a money
    // column) except for a couple of columns where ascending reads more
    // naturally as "best first" (cheapest, soonest).
    if (sort === key) {
      updateUrl({ dir: dir === "asc" ? "desc" : "asc", page: 1 });
    } else {
      const ascendingByDefault: OpportunitySortKey[] = ["listing_price", "delivered_cost", "time_remaining"];
      updateUrl({ sort: key, dir: ascendingByDefault.includes(key) ? "asc" : "desc", page: 1 });
    }
  }

  useEffect(() => {
    if (strategyTab !== "ALL") return;
    fetchScanCoverage()
      .then(setCoverage)
      .catch(() => undefined); // non-critical — don't block the rest of the dashboard on this
  }, [strategyTab]);

  // The category tab drives the actual server-side `state` filter (see
  // CATEGORY_STATES) so total/remaining below describe the same rows the
  // table shows, rather than a raw unfiltered count with a misleading
  // "not yet loaded" message layered over the top of it.
  const categoryState = CATEGORY_STATES[filters.category]?.join(",");

  // SOURCING WORKFLOW item 16: the exact params (minus `page`) behind the
  // current view — handed to Opportunity Detail via the browse queue below
  // so it can fetch an adjacent PAGE with everything else held constant,
  // and reused by load() itself so the two can never drift apart.
  const baseParams: Omit<OpportunityQueryParams, "page"> = useMemo(
    () => ({
      strategy: strategyTab,
      state: categoryState,
      limit: PAGE_SIZE,
      sort,
      dir,
      ...buildServerFilterParams(filters),
    }),
    // eslint-disable-next-line
    [strategyTab, categoryState, sort, dir, JSON.stringify(filters)],
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchOpportunities({ ...baseParams, page });
      setOpportunities(result.opportunities);
      setTotal(result.total);
      setPageCount(result.pageCount);
      setCounts(result.counts);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line
  }, [strategyTab, filters.category, page, sort, dir, JSON.stringify(filters)]);

  // Restore scroll position once, right after the page this session was on
  // finishes loading — not on every load (a filter change should scroll to
  // the top like any normal navigation, only a RETURN from Opportunity
  // Detail should restore the old position).
  const restoredRef = useRef(false);
  const [lastViewedId, setLastViewedId] = useState<string | null>(null);
  useEffect(() => {
    if (restoredRef.current || loading) return;
    restoredRef.current = true;
    const stored = readSession(strategyTab);
    if (stored) {
      setLastViewedId(stored.lastViewedId);
      // Let the table actually paint first.
      requestAnimationFrame(() => {
        // Find the actual row rather than replaying the raw pixel offset —
        // now that `.table-scroll` regions each own their own scrollbar
        // (the sticky-header fix), the page and every table scroll
        // independently, so a single `window.scrollTo` can no longer land on
        // the right spot. `scrollIntoView` walks up through however many
        // nested scroll containers the row sits in and centres it in each,
        // which is what "put me back where I was" actually needs.
        // Row elements are id={`opp-row-${o.id}`} — see OpportunityTable.tsx.
        const row = stored.lastViewedId ? document.getElementById(`opp-row-${stored.lastViewedId}`) : null;
        if (row) {
          row.scrollIntoView({ block: "center", behavior: "auto" });
        } else {
          // Row not on this page/filtered out (or we have no id at all,
          // e.g. an older saved session) — fall back to the plain page
          // offset we saved, same as before this fix.
          window.scrollTo({ top: stored.scrollY, behavior: "auto" });
        }
      });
    }
    // eslint-disable-next-line
  }, [loading]);

  function handleOpen(id: string) {
    writeSession(strategyTab, { scrollY: window.scrollY, lastViewedId: id });
  }

  const filtered = useMemo(() => applyDashboardFilters(opportunities, filters), [opportunities, filters]);
  const showReasonsTable = filters.category === "REVIEW" || filters.category === "NEAR_MISS" || filters.category === "REJECTED";

  // SOURCING WORKFLOW item 16: "N of M matching opportunities" and Previous/
  // Next on Opportunity Detail both come from this — the ids are exactly
  // what's on screen (post client-side filtering too), in the order shown.
  const browseQueue: OpportunityBrowseQueue = useMemo(
    () => ({
      ids: filtered.map((o) => o.id),
      page,
      pageCount,
      total,
      limit: PAGE_SIZE,
      queryParams: baseParams,
    }),
    // eslint-disable-next-line
    [filtered, page, pageCount, total, baseParams],
  );

  // SOURCING WORKFLOW item 7: exports every row matching the CURRENT filter
  // (server-side filters + the finer client-side ones), not just the one
  // page on screen. Re-fetches with the export ceiling (see
  // fetchOpportunitiesForExport) rather than reusing `opportunities`, which
  // only ever holds the current 75-row page.
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  async function handleExport() {
    setExporting(true);
    setExportNotice(null);
    try {
      const { limit: _pageLimit, ...exportParams } = baseParams;
      const result = await fetchOpportunitiesForExport(exportParams);
      const rowsToExport = applyDashboardFilters(result.opportunities, filters);
      if (rowsToExport.length === 0) {
        setExportNotice("Nothing to export — no rows match the current filters.");
        return;
      }
      await exportOpportunitiesToXlsx(rowsToExport, strategyTab.toLowerCase());
      const truncated = result.total > result.opportunities.length;
      setExportNotice(
        truncated
          ? `Exported ${rowsToExport.length} row(s). Note: ${result.total} rows match this filter but only the first ` +
              `${result.opportunities.length} could be fetched in one export — narrow the filters to capture the rest.`
          : `Exported ${rowsToExport.length} row(s) matching the current filters.`,
      );
    } catch (err) {
      setExportNotice(`Export failed: ${String(err)}`);
    } finally {
      setExporting(false);
    }
  }

  async function handleScanNow() {
    setScanning(true);
    try {
      const {
        scanRun,
        cardsProfiledThisRun,
        cardsSearchedThisRun,
        ebayApiCallsThisRun,
        duplicateListingsThisRun,
        enrichedListingsThisRun,
      } = await triggerScan();
      setLastScan(scanRun);
      setLastScanCoverage({
        cardsProfiledThisRun,
        cardsSearchedThisRun,
        ebayApiCallsThisRun,
        duplicateListingsThisRun,
        enrichedListingsThisRun,
      });
      await load();
      fetchScanCoverage()
        .then(setCoverage)
        .catch(() => undefined);
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
    }
  }

  return (
    <div>
      {strategyTab === "ALL" && <SummaryStats />}

      <div className="page-header">
        <h1>{strategyTab === "ALL" ? "Best Opportunities Now" : strategyTab === "FLIP" ? "Best Flips Today" : "Best Grading Candidates Today"}</h1>
        <button onClick={handleScanNow} disabled={scanning}>
          {scanning ? "Scanning…" : "Scan now"}
        </button>
      </div>

      {lastScan && <ScanResultPanel scan={lastScan} coverage={lastScanCoverage} />}

      {strategyTab === "ALL" && coverage && <ScanCoveragePanel coverage={coverage} />}

      {counts && <OpportunityCountsPanel counts={counts} />}

      <FilterBar filters={filters} onChange={setFilters} />

      {error && <p className="error-banner">{error}</p>}
      {loading ? (
        <p className="empty-state">Loading…</p>
      ) : (
        <>
          <p className="result-count">
            {filtered.length} of {opportunities.length} loaded on this page match your filters ({total} total in this
            category, page {page} of {pageCount}).{" "}
            <button className="export-xlsx-button" onClick={handleExport} disabled={exporting}>
              {exporting ? "Exporting…" : "Export to XLSX"}
            </button>
          </p>
          {exportNotice && <p className="result-count export-notice">{exportNotice}</p>}
          {showReasonsTable ? (
            <ReasonsTable
              opportunities={filtered}
              emptyMessage={
                filters.category === "REJECTED"
                  ? 'Always empty: rejected candidates are intentionally never stored (see the hint above) — check the "Scan now" result message for what was actually rejected on your last scan.'
                  : undefined
              }
              sort={sort}
              dir={dir}
              onSort={setSort}
              lastViewedId={lastViewedId}
              onOpen={handleOpen}
              browseQueue={browseQueue}
            />
          ) : (
            <OpportunityTable
              opportunities={filtered}
              sort={sort}
              dir={dir}
              onSort={setSort}
              lastViewedId={lastViewedId}
              onOpen={handleOpen}
              browseQueue={browseQueue}
            />
          )}
          <PaginationBar page={page} pageCount={pageCount} onChange={setPage} />
        </>
      )}
    </div>
  );
}

/** SOURCING WORKFLOW item 4: Previous / Page X of Y / Next — deterministic,
 *  never an ever-growing in-page list. */
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

/**
 * The honest breakdown behind the single opportunities feed — every
 * category that exists right now, whether or not it's currently visible in
 * the (possibly filtered) table above. STABILISATION item 1/10: never let
 * "no results" or a short list look like "nothing else exists" when there
 * are hundreds of rejected/near-miss/auction rows sitting in the database.
 */
function OpportunityCountsPanel({ counts }: { counts: OpportunityCounts }) {
  const fmt = new Intl.NumberFormat("en-GB");
  return (
    <p className="result-count opportunity-counts-panel">
      <strong>{fmt.format(counts.totalCandidates)}</strong> total candidates stored — {fmt.format(counts.qualifiedFlip)}{" "}
      qualified flip, {fmt.format(counts.qualifiedGrade)} qualified grade, {fmt.format(counts.inspectPhotos)} awaiting
      photo inspection, {fmt.format(counts.auctions)} auctions, {fmt.format(counts.watch)} watch (real economics, below
      the bar), {fmt.format(counts.noMarketData)} no market data, {fmt.format(counts.identityUncertain)} identity
      uncertain, {fmt.format(counts.computationError)} rejected — invalid listing data
      {counts.endedListings > 0 ? `, ${fmt.format(counts.endedListings)} on a listing that has since ended` : ""}.{" "}
      {/* SOURCING WORKFLOW item 18: the last three of those are read straight
          from stored rows, and no-market-data/identity-uncertain/computation-
          error candidates are deliberately never stored (see the Rejected
          tab's own hint) — so those three will always read 0 here regardless
          of how many were actually rejected on the most recent scan. */}
      <span className="counts-footnote">
        "No market data" / "identity uncertain" / "rejected — invalid listing data" above only ever count stored
        rows, and rejected candidates are intentionally never stored — those three will always read 0 here. See the
        "Scan now" result message for real rejection counts from your last scan.
      </span>
    </p>
  );
}

/**
 * The live scan-coverage picture (STABILISATION item 3), independent of
 * any specific run — shows how much of the Dynamic Flip/Grade Universe
 * (the eligible cards prioritised eBay search draws from) has actually
 * been kept fresh, versus never searched or gone stale. Rotation is
 * guaranteed by packages/core/src/market/prioritization.ts (see its own
 * doc comment and regression test) — this panel is what lets that be
 * checked against real numbers instead of taken on faith.
 */
function ScanCoveragePanel({ coverage }: { coverage: ScanCoverageStats }) {
  const fmt = new Intl.NumberFormat("en-GB");
  const pct =
    coverage.eligibleUniverseSize > 0
      ? Math.round((coverage.searchedRecently / coverage.eligibleUniverseSize) * 100)
      : null;
  const oldestDays = coverage.oldestSearchedAgeHours === null ? null : Math.round(coverage.oldestSearchedAgeHours / 24);

  return (
    <p className="result-count opportunity-counts-panel">
      Scan coverage: <strong>{fmt.format(coverage.eligibleUniverseSize)}</strong> cards in the eligible (flip/grade)
      universe — {fmt.format(coverage.neverSearched)} never searched, {fmt.format(coverage.searchedRecently)} searched
      within the last week{pct !== null ? ` (${pct}% of the eligible universe)` : ""}.
      {oldestDays !== null && ` Oldest last search: ${oldestDays} day(s) ago.`}
    </p>
  );
}

/** Shows exactly what the last "Scan now" run actually did — how many
 *  listings/snapshots it pulled, how many opportunities it created or
 *  updated, and any non-fatal errors it logged along the way. Without this,
 *  a scan that completes with zero opportunities looks identical whether
 *  the catalogue was empty, the eBay search found nothing, or every
 *  candidate got filtered out by the scoring thresholds — this panel is
 *  what tells those apart, straight from the browser. */
function ScanResultPanel({
  scan,
  coverage,
}: {
  scan: ScanRunSummary;
  coverage: {
    cardsProfiledThisRun: number;
    cardsSearchedThisRun: number;
    ebayApiCallsThisRun: number;
    duplicateListingsThisRun: number;
    enrichedListingsThisRun: number;
  } | null;
}) {
  const errors: string[] = scan.errors ? safeParseErrors(scan.errors) : [];
  return (
    <div className="sync-report">
      <p className="result-count">
        Last scan: <strong>{scan.status}</strong> — {scan.listings_fetched} eBay listing(s) fetched,{" "}
        {scan.market_snapshots_fetched} market snapshot(s) fetched, {scan.opportunities_created} opportunity(ies)
        created, {scan.opportunities_updated} updated ({scan.api_calls_made} provider API call(s) total).
        {coverage &&
          ` ${coverage.cardsProfiledThisRun} card(s) profiled and ${coverage.cardsSearchedThisRun} card(s) searched on eBay this run via ${coverage.ebayApiCallsThisRun} eBay call(s)${coverage.ebayApiCallsThisRun < coverage.cardsSearchedThisRun ? ` (${coverage.cardsSearchedThisRun - coverage.ebayApiCallsThisRun} card(s) shared a search with another printing)` : ""}.`}
        {coverage && coverage.duplicateListingsThisRun > 0
          ? ` ${coverage.duplicateListingsThisRun} duplicate listing(s) (same eBay item found via more than one card search) collapsed to a single opportunity each.`
          : ""}
        {/* SOURCING WORKFLOW item 9: makes the (deliberately small, budgeted)
            stage-two enrichment pass visible rather than silent — 0 is a
            real, common outcome (nothing new/promising this run) and is
            worth distinguishing from "enrichment isn't wired up at all". */}
        {coverage
          ? ` ${coverage.enrichedListingsThisRun} listing(s) got a deeper eBay condition check this run.`
          : ""}
      </p>
      {scan.listings_fetched === 0 && errors.some((e) => /ebay/i.test(e)) && (
        <p className="result-count">
          Zero listings fetched, and eBay itself returned errors — the problem is the eBay connection, not the
          catalogue. Check the error text below; an OAuth failure usually means the credentials in .dev.vars are
          sandbox keys being used against eBay's production API, or a mismatched App ID / Cert ID pair.
        </p>
      )}
      {scan.listings_fetched === 0 && !errors.some((e) => /ebay/i.test(e)) && (
        <p className="result-count">
          Zero listings fetched and no eBay errors — eBay was never searched, which points to an empty or
          not-yet-eligible catalogue. Try "Sync catalogue (no eBay)" on the Market page first.
        </p>
      )}
      {scan.listings_fetched > 0 && scan.opportunities_created === 0 && scan.opportunities_updated === 0 && (
        <p className="result-count">
          Listings were fetched but no opportunities were created — likely every candidate was filtered out by the
          current scoring thresholds (Settings), or identity matching couldn't confidently link eBay listings back
          to catalogued cards.
        </p>
      )}
      {errors.length > 0 && <p className="error-banner">{errors.join("; ")}</p>}
    </div>
  );
}

function safeParseErrors(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
  } catch {
    return [raw];
  }
}
