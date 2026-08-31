import { useEffect, useMemo, useState } from "react";
import { fetchOpportunities, triggerScan, type OpportunityListItem, type ScanRunSummary } from "../api/client";
import { OpportunityTable } from "../components/OpportunityTable";
import { FilterBar } from "../components/FilterBar";
import { SummaryStats } from "../components/SummaryStats";
import { DEFAULT_DASHBOARD_FILTERS, applyDashboardFilters, type DashboardFilters } from "../state/filters";

export function Dashboard({ strategyTab }: { strategyTab: "ALL" | "FLIP" | "GRADE" }) {
  const [opportunities, setOpportunities] = useState<OpportunityListItem[]>([]);
  const [loading, setLoading] = useState(true);
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
      const { opportunities } = await fetchOpportunities({ strategy: strategyTab });
      setOpportunities(opportunities);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyTab]);

  const filtered = useMemo(() => applyDashboardFilters(opportunities, filters), [opportunities, filters]);

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

      <FilterBar filters={filters} onChange={setFilters} />

      {error && <p className="error-banner">{error}</p>}
      {loading ? (
        <p className="empty-state">Loading…</p>
      ) : (
        <>
          <p className="result-count">
            {filtered.length} of {opportunities.length} scanned opportunities match your filters.
          </p>
          <OpportunityTable opportunities={filtered} />
        </>
      )}
    </div>
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
      {scan.listings_fetched === 0 && (
        <p className="result-count">
          Zero listings fetched means eBay was never actually searched for any card this run — that points to an
          empty or not-yet-eligible catalogue (try "Sync catalogue (no eBay)" on the Market page first) rather than
          an eBay-specific problem.
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
