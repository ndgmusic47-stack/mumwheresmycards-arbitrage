import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  fetchOpportunities,
  fetchOpportunitiesForExport,
  triggerScan,
  updateOpportunityReview,
  type OpportunityListItem,
  type OpportunityQueryParams,
  type OpportunitySortKey,
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

/** SOURCING WORKFLOW item 3, rebuilt 2026-09-08: sessionStorage key for
 *  "where was I", scoped per strategy tab since each tab is really a
 *  separate sourcing session. URL query params (page/sort/f) carry the rest
 *  of the state and are restored automatically by the browser's own
 *  back-navigation, since they're part of the URL. */
function sessionKey(strategyTab: string) {
  return `mwmc-sourcing-session-${strategyTab}`;
}

interface StoredSession {
  /** `searchParams.toString()` at save time. A stored position is only ever
   *  replayed onto the SAME view — otherwise changing a filter and coming
   *  back would drop you at an offset that meant something else entirely. */
  search: string;
  /** Page-level offset. */
  scrollY: number;
  /**
   * Offset inside each `.table-scroll` container, in document order.
   *
   * THIS is the fix (2026-09-08). `.table-scroll` is `overflow: auto` with
   * `max-height: 65vh` (see styles.css — it was bounded deliberately to make
   * the sticky header work), so the table owns its own scrollbar and a user
   * scrolling down a table barely moves `window.scrollY` at all. The old
   * code saved only `window.scrollY`, so it faithfully restored a number
   * that was always ~0 and dumped you back at the top of the table every
   * time. An array because the ALL view renders more than one table.
   */
  tableScrollTops: number[];
  /** The row whose eBay page was opened last, so it can be highlighted on
   *  return. Optional: a session written before this existed is still valid. */
  lastViewedId?: string | null;
}

function readSession(strategyTab: string): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(strategyTab));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    // Tolerate a session written by the pre-fix build (no `search`, no
    // `tableScrollTops`) rather than throwing on it.
    if (typeof parsed.search !== "string" || !Array.isArray(parsed.tableScrollTops)) return null;
    return {
      search: parsed.search,
      scrollY: parsed.scrollY ?? 0,
      tableScrollTops: parsed.tableScrollTops,
      lastViewedId: parsed.lastViewedId ?? null,
    };
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

function tableScrollContainers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".table-scroll"));
}

export function Dashboard({ strategyTab }: { strategyTab: "ALL" | "FLIP" | "GRADE" }) {
  const [searchParams, setSearchParams] = useSearchParams();

  const [opportunities, setOpportunities] = useState<OpportunityListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  /** One short line confirming the last manual scan. Replaces the former
   *  multi-paragraph diagnostic panels — see the comment in the render. */
  const [scanNotice, setScanNotice] = useState<string | null>(null);
  /** Ids with a Save/Pass request in flight, so a button can't be double-fired. */
  const [decidingIds, setDecidingIds] = useState<Set<string>>(new Set());

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

  // ---- Position preservation (rebuilt 2026-09-08) ----------------------
  //
  // Two halves, both of which the previous version got wrong:
  //
  // 1. SAVING happens CONTINUOUSLY, on every scroll, not only when a row is
  //    clicked. Before, the position was captured solely in the row-link's
  //    onClick, so leaving the page ANY other way — the browser back button,
  //    a nav link, an eBay link, the browser's own restore — saved nothing
  //    and you came back to the top.
  // 2. RESTORING replays the TABLE's own scrollTop, not just the window's
  //    (see StoredSession.tableScrollTops for why that was the core bug),
  //    and retries across a few frames because the rows are not necessarily
  //    in the DOM on the first frame after `loading` flips.
  //
  // Deliberately NOT reinstated: the old `row-last-viewed` highlight. Being
  // put back exactly where you were is the whole feature; tinting the row
  // you last opened is a consolation prize for a restore that didn't work.
  const currentSearch = searchParams.toString();
  const searchRef = useRef(currentSearch);
  searchRef.current = currentSearch;
  const lastViewedRef = useRef<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const capture = () => {
      frame = 0;
      writeSession(strategyTab, {
        search: searchRef.current,
        scrollY: window.scrollY,
        tableScrollTops: tableScrollContainers().map((el) => el.scrollTop),
        lastViewedId: lastViewedRef.current,
      });
    };
    // rAF-throttled: a scroll fires far more often than we need to persist.
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(capture);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    const containers = tableScrollContainers();
    containers.forEach((el) => el.addEventListener("scroll", onScroll, { passive: true }));
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      containers.forEach((el) => el.removeEventListener("scroll", onScroll));
      // Capture one last time on unmount — this is the navigation-away case
      // (clicking into a row, or any other route change).
      capture();
    };
    // Re-bind whenever the rendered tables change identity: a category or
    // page change swaps the container elements out from under the listeners.
    // eslint-disable-next-line
  }, [strategyTab, loading, filters.category, page]);

  /** The row whose eBay page was opened last, highlighted on return so the
   *  user can see exactly where they were. */
  const [lastViewedId, setLastViewedId] = useState<string | null>(null);

  /** Called by the table just before it navigates away — the eBay "View" link
   *  and the in-tool detail link both fire it. Captures the position AND which
   *  row it was, immediately (not on unmount), because opening eBay in a new
   *  tab never unmounts this page. */
  function handleOpen(id: string) {
    setLastViewedId(id);
    lastViewedRef.current = id;
    writeSession(strategyTab, {
      search: searchRef.current,
      scrollY: window.scrollY,
      tableScrollTops: tableScrollContainers().map((el) => el.scrollTop),
      lastViewedId: id,
    });
  }

  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || loading) return;
    const stored = readSession(strategyTab);
    // Only replay a position saved for THIS exact view. A filter change
    // should land at the top like any normal navigation.
    if (!stored || stored.search !== currentSearch) {
      restoredRef.current = true;
      return;
    }
    restoredRef.current = true;
    setLastViewedId(stored.lastViewedId ?? null);
    lastViewedRef.current = stored.lastViewedId ?? null;

    // The rows may not be painted on the first frame after `loading` flips,
    // and a `.table-scroll` cannot be scrolled to an offset taller than it
    // currently is — so retry over a short, bounded window until the content
    // is tall enough to accept the offset (or we run out of patience and
    // take whatever we can get).
    let attempts = 0;
    const apply = () => {
      const containers = tableScrollContainers();
      let satisfied = containers.length >= stored.tableScrollTops.length;
      containers.forEach((el, i) => {
        const target = stored.tableScrollTops[i] ?? 0;
        el.scrollTop = target;
        if (Math.abs(el.scrollTop - target) > 1) satisfied = false;
      });
      window.scrollTo({ top: stored.scrollY, behavior: "auto" });
      if (!satisfied && attempts++ < 20) requestAnimationFrame(apply);
    };
    requestAnimationFrame(apply);
    // eslint-disable-next-line
  }, [loading]);

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
      const { scanRun } = await triggerScan();
      // Deliberately one line. The full picture (backlog, provider budget,
      // per-step counts, rejection reasons) is still on this response and on
      // GET /trade/api/scan-runs — it just isn't the first thing in the way
      // every time the page loads.
      setScanNotice(
        `Scan finished — ${scanRun.opportunities_created} new, ${scanRun.opportunities_updated} updated.` +
          (scanRun.status === "SUCCESS" ? "" : ` (${scanRun.status})`),
      );
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setScanning(false);
    }
  }

  /**
   * Save / Pass, straight from the table row.
   *
   * Save  -> INTERESTED. The listing shows up in Pipeline under "Saved".
   * Pass  -> PASS. It leaves the working feed immediately AND stays gone:
   *          buildServerFilterParams sends excludeReviewStatus=PASS whenever
   *          the decision filter is "All", and upsertOpportunity never
   *          rewrites review_status on a re-scan, so a later scan touching
   *          the same listing cannot resurrect it.
   *
   * Clicking the same button again clears the decision back to UNREVIEWED, so
   * a mis-click is one click to undo rather than a trip to the detail page.
   */
  async function handleDecide(id: string, status: "INTERESTED" | "PASS") {
    const current = opportunities.find((o) => o.id === id);
    const next = current?.review_status === status ? "UNREVIEWED" : status;
    setDecidingIds((prev) => new Set(prev).add(id));
    try {
      await updateOpportunityReview(id, { reviewStatus: next });
      // Only drop the row from view when the CURRENT view is one that hides
      // passed listings. While deliberately looking at "Passed", the row must
      // stay put — otherwise un-passing something would make it vanish from
      // the only view that shows it.
      const viewHidesPassed = filters.reviewStatus === "ALL";
      if (next === "PASS" && viewHidesPassed) {
        setOpportunities((prev) => prev.filter((o) => o.id !== id));
        setTotal((t) => Math.max(0, t - 1));
      } else {
        setOpportunities((prev) => prev.map((o) => (o.id === id ? { ...o, review_status: next } : o)));
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setDecidingIds((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(id);
        return nextSet;
      });
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

      {/*
        2026-09-09: the three diagnostic panels that used to sit here — the
        market-data backlog / provider-call line, the full last-scan
        statistics, and the total-candidate breakdown with its always-zero
        footnote — are gone from the normal workflow. They answered questions
        about whether the SCANNER is healthy, not about whether a CARD is
        worth buying, and they were the first thing on screen every time.

        Nothing was deleted, only unpinned from this page: the same figures
        are still returned by the API and can be read whenever they're
        actually needed for diagnosis —
          - last scan + backlog + provider budget: POST /trade/api/scan-runs
            returns `scanRun` and `profiling`, and GET /trade/api/scan-runs
            lists recent runs with their status and errors;
          - coverage: GET /trade/api/market/coverage;
          - candidate counts by state: the `counts` object on
            GET /trade/api/opportunities (still fetched below, still used to
            drive the category tabs).
        `wrangler tail` remains the live view. See the project doc.
      */}
      {scanNotice && <p className="result-count">{scanNotice}</p>}

      <FilterBar filters={filters} onChange={setFilters} />

      {error && <p className="error-banner">{error}</p>}
      {loading ? (
        <p className="empty-state">Loading…</p>
      ) : (
        <>
          <p className="result-count">
            {total.toLocaleString()} matching {total === 1 ? "listing" : "listings"} · page {page} of {pageCount}{" "}
            <button className="export-xlsx-button" onClick={handleExport} disabled={exporting}>
              {exporting ? "Exporting…" : "Export to XLSX"}
            </button>
          </p>
          {exportNotice && <p className="result-count export-notice">{exportNotice}</p>}
          {showReasonsTable ? (
            <ReasonsTable
              opportunities={filtered}
              emptyMessage={filters.category === "REJECTED" ? "Always empty — rejected candidates are never stored." : undefined}
              sort={sort}
              dir={dir}
              onSort={setSort}
              lastViewedId={lastViewedId}
              onOpen={handleOpen}
              onDecide={handleDecide}
              decidingIds={decidingIds}
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
              onDecide={handleDecide}
              decidingIds={decidingIds}
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
