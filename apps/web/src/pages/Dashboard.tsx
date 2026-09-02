import { useEffect, useMemo, useState } from "react";
import {
  fetchOpportunities,
  triggerScan,
  type OpportunityCounts,
  type OpportunityListItem,
  type ScanRunSummary,
} from "../api/client";
import { OpportunityTable } from "../components/OpportunityTable";
import { FilterBar } from "../components/FilterBar";
import { SummaryStats } from "../components/SummaryStats";
import { DEFAULT_DASHBOARD_FILTERS, applyDashboardFilters, type DashboardFilters } from "../state/filters";

/** How many rows we pull from the server per page. This is a network/paging
 *  page size, unrelated to the FilterBar's "qualifying only" filter, which
 *  is applied client-side against whatever's currently loaded. */
const PAGE_SIZE = 200;

export function Dashboard({ strategyTab }: { strategyTab: "ALL" | "FLIP" | "GRADE" }) {
  const [opportunities, setOpportunities] = useState<OpportunityListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<OpportunityCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<ScanRunSummary | null>(null);
  const [filters, setFilters] = useState<DashboardFilters>({ ...DEFAULT_DASHBOARD_FILTERS, strategy: strategyTab });

  useEffect(() => {
    setFilters((f) => ({ ...f, strategy: strategyTab }));
  }, [strategyTab]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchOpportunities({ strategy: strategyTab, limit: PAGE_SIZE, offset: 0 });
      setOpportunities(result.opportunities);
      setTotal(result.total);
      setCounts(result.counts);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    setLoadingMore(true);
    try {
      const result = await fetchOpportunities({ strategy: strategyTab, limit: PAGE_SIZE, offset: opportunities.length });
      setOpportunities((prev) => [...prev, ...result.opportunities]);
      setTotal(result.total);
      setCounts(result.counts);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line
  }, [strategyTab]);

  const filtered = useMemo(() => applyDashboardFilters(opportunities, filters), [opportunities, filters]);
  const remaining = total - opportunities.length;

  async function handleScanNow() {
    setScanning(true);
    try {
      const { scanRun } = await triggerScan();
      setLastScan(scanRun);
      await load();
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

      {lastScan && <ScanResultPanel scan={lastScan} />}

      {counts && <OpportunityCountsPanel counts={counts} />}

      <FilterBar filters={filters} onChange={setFilters} />

      {error && <p className="error-banner">{error}</p>}
      {loading ? (
        <p className="empty-state">Loading…</p>
      ) : (
        <>
          <p className="result-count">
            {filtered.length} of {opportunities.length} loaded ({total} total for this strategy) match your filters.
          </p>
          <OpportunityTable opportunities={filtered} />
          {remaining > 0 && (
            <button className="load-more-button" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : `Load ${Math.min(PAGE_SIZE, remaining)} more (${remaining} not yet loaded)`}
            </button>
          )}
        </>
      )}
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
      uncertain, {fmt.format(counts.computationError)} rejected — invalid listing data.
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
function ScanResultPanel({ scan }: { scan: ScanRunSummary }) {
  const errors: string[] = scan.errors ? safeParseErrors(scan.errors) : [];
  return (
    <div className="sync-report">
      <p className="result-count">
        Last scan: <strong>{scan.status}</strong> — {scan.listings_fetched} eBay listing(s) fetched,{" "}
        {scan.market_snapshots_fetched} market snapshot(s) fetched, {scan.opportunities_created} opportunity(ies)
        created, {scan.opportunities_updated} updated ({scan.api_calls_made} provider API call(s) total).
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
