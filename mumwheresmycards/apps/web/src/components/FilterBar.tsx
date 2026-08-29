import type { DashboardFilters } from "../state/filters";

export function FilterBar({
  filters,
  onChange,
}: {
  filters: DashboardFilters;
  onChange: (next: DashboardFilters) => void;
}) {
  function set<K extends keyof DashboardFilters>(key: K, value: DashboardFilters[K]) {
    onChange({ ...filters, [key]: value });
  }

  return (
    <div className="filter-bar">
      <label>
        Strategy
        <select value={filters.strategy} onChange={(e) => set("strategy", e.target.value as DashboardFilters["strategy"])}>
          <option value="ALL">All</option>
          <option value="FLIP">Flip</option>
          <option value="GRADE">Grade</option>
        </select>
      </label>

      <label>
        Min net profit (£)
        <input
          type="number"
          value={filters.minNetProfit}
          onChange={(e) => set("minNetProfit", Number(e.target.value))}
        />
      </label>

      <label>
        Min ROC (%)
        <input
          type="number"
          value={Math.round(filters.minReturnOnCapital * 100)}
          onChange={(e) => set("minReturnOnCapital", Number(e.target.value) / 100)}
        />
      </label>

      <label>
        Min margin (%)
        <input
          type="number"
          value={Math.round(filters.minProfitMargin * 100)}
          onChange={(e) => set("minProfitMargin", Number(e.target.value) / 100)}
        />
      </label>

      <label>
        Max acquisition (£)
        <input
          type="number"
          value={filters.maxAcquisitionPrice}
          onChange={(e) => set("maxAcquisitionPrice", Number(e.target.value))}
        />
      </label>

      <label>
        Min liquidity
        <select value={filters.minLiquidity} onChange={(e) => set("minLiquidity", e.target.value as DashboardFilters["minLiquidity"])}>
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
          <option value="VERY_HIGH">Very high</option>
        </select>
      </label>

      <label>
        Min confidence (%)
        <input
          type="number"
          value={Math.round(filters.minConfidence * 100)}
          onChange={(e) => set("minConfidence", Number(e.target.value) / 100)}
        />
      </label>

      {filters.strategy !== "GRADE" && (
        <label>
          Min QSV (£)
          <input type="number" value={filters.minQsv} onChange={(e) => set("minQsv", Number(e.target.value))} />
        </label>
      )}

      {filters.strategy !== "FLIP" && (
        <label className="checkbox-label">
          <input type="checkbox" checked={filters.safeZoneOnly} onChange={(e) => set("safeZoneOnly", e.target.checked)} />
          Safe zone only (break-even ≤ PSA 7)
        </label>
      )}
    </div>
  );
}
