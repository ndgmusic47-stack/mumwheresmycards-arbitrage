import { useEffect, useMemo, useState } from "react";
import { fetchOpportunities, triggerScan, type OpportunityListItem } from "../api/client";
import { OpportunityTable } from "../components/OpportunityTable";
import { FilterBar } from "../components/FilterBar";
import { SummaryStats } from "../components/SummaryStats";
import { DEFAULT_DASHBOARD_FILTERS, applyDashboardFilters, type DashboardFilters } from "../state/filters";

export function Dashboard({ strategyTab }: { strategyTab: "ALL" | "FLIP" | "GRADE" }) {
  const [opportunities, setOpportunities] = useState<OpportunityListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
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
      await triggerScan();
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
