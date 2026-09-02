import type { DashboardFilters, EconomicClass, OpportunityCategory } from "../state/filters";

const ECONOMIC_CLASSES: { value: EconomicClass; label: string }[] = [
  { value: "DOWNSIDE_PROTECTED", label: "Downside protected" },
  { value: "BALANCED", label: "Balanced" },
  { value: "ASYMMETRIC", label: "Asymmetric" },
];

const CATEGORY_TABS: { value: OpportunityCategory; label: string; title: string }[] = [
  { value: "ACTIONABLE", label: "Actionable", title: "Qualified flips and grading candidates — ready to act on" },
  { value: "REVIEW", label: "Needs photo review", title: "Cleared the economic bar but identity needs a human photo check first" },
  { value: "NEAR_MISS", label: "Near misses", title: "Real computed economics, just below the qualifying bar" },
  { value: "REJECTED", label: "Rejected", title: "No market data, uncertain identity, or a computation error" },
  { value: "ALL", label: "All", title: "Every candidate currently stored, unfiltered by state" },
];

/**
 * Every commercial lever, adjustable here. Nothing in this bar requires a
 * code change to alter — the same fields the engine qualifies on are the
 * fields shown, so what you tune is what actually gates the feed.
 */
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

  function toggleClass(value: EconomicClass) {
    const next = filters.economicClasses.includes(value)
      ? filters.economicClasses.filter((c) => c !== value)
      : [...filters.economicClasses, value];
    set("economicClasses", next);
  }

  const showFlip = filters.strategy !== "GRADE";
  const showGrade = filters.strategy !== "FLIP";
  const economicsApply = filters.category === "ACTIONABLE" || filters.category === "REVIEW" || filters.category === "NEAR_MISS";

  return (
    <div className="filter-panel">
      <div className="category-tabs" role="tablist" aria-label="Opportunity category">
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            role="tab"
            title={tab.title}
            aria-selected={filters.category === tab.value}
            className={filters.category === tab.value ? "category-tab category-tab-active" : "category-tab"}
            onClick={() => set("category", tab.value)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {!economicsApply && (
        <p className="category-hint">
          {filters.category === "REJECTED"
            ? "Rejected rows rarely have computed economics, so the thresholds below don't apply here — every rejected row for the selected strategy is shown."
            : "Showing every state at once, so the economics thresholds below don't apply — use a specific category tab to filter by them."}
        </p>
      )}

      <div className="filter-bar">
        <label>
          Strategy
          <select
            value={filters.strategy}
            onChange={(e) => set("strategy", e.target.value as DashboardFilters["strategy"])}
          >
            <option value="ALL">All</option>
            <option value="FLIP">Raw flip</option>
            <option value="GRADE">Raw → graded</option>
          </select>
        </label>

        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={filters.auctionsOnly}
            onChange={(e) => set("auctionsOnly", e.target.checked)}
          />
          Auctions only
        </label>

        {economicsApply && (
          <>
            <label>
              Min liquidity
              <select
                value={filters.minLiquidity}
                onChange={(e) => set("minLiquidity", e.target.value as DashboardFilters["minLiquidity"])}
              >
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
          </>
        )}
      </div>

      {economicsApply && showFlip && (
        <>
          <h3 className="filter-group-heading">Raw flip</h3>
          <div className="filter-bar">
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
              Max acquisition (£)
              <input
                type="number"
                value={filters.maxAcquisitionCost}
                onChange={(e) => set("maxAcquisitionCost", Number(e.target.value))}
              />
            </label>
            <label>
              Min QSV (£)
              <input type="number" value={filters.minQsv} onChange={(e) => set("minQsv", Number(e.target.value))} />
            </label>
            <label>
              Max days to sale
              <input
                type="number"
                value={filters.maxExpectedDaysToSale}
                onChange={(e) => set("maxExpectedDaysToSale", Number(e.target.value))}
              />
            </label>
          </div>
        </>
      )}

      {economicsApply && showGrade && (
        <>
          <h3 className="filter-group-heading">Raw → graded</h3>
          <div className="filter-bar">
            <div className="class-toggles">
              <span className="class-toggle-label">Economic class</span>
              {ECONOMIC_CLASSES.map((c) => (
                <label key={c.value} className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={filters.economicClasses.includes(c.value)}
                    onChange={() => toggleClass(c.value)}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </div>

          <div className="filter-bar">
            <label>
              Max raw acquisition (£)
              <input
                type="number"
                value={filters.maxRawAcquisitionCost}
                onChange={(e) => set("maxRawAcquisitionCost", Number(e.target.value))}
              />
            </label>
            <label>
              Max graded basis (£)
              <input
                type="number"
                value={filters.maxTotalGradedBasis}
                onChange={(e) => set("maxTotalGradedBasis", Number(e.target.value))}
              />
            </label>
            <label>
              Min PSA10 value (£)
              <input
                type="number"
                value={filters.minPsa10Value}
                onChange={(e) => set("minPsa10Value", Number(e.target.value))}
              />
            </label>
            <label>
              Min PSA10 profit (£)
              <input
                type="number"
                value={filters.minPsa10Profit}
                onChange={(e) => set("minPsa10Profit", Number(e.target.value))}
              />
            </label>
            <label>
              Min PSA10 multiple (x)
              <input
                type="number"
                step="0.1"
                value={filters.minPsa10GrossMultiple}
                onChange={(e) => set("minPsa10GrossMultiple", Number(e.target.value))}
              />
            </label>
            <label>
              Min PSA9 profit (£)
              <input
                type="number"
                value={Number.isFinite(filters.minPsa9Profit) ? filters.minPsa9Profit : ""}
                placeholder="any"
                onChange={(e) => set("minPsa9Profit", e.target.value === "" ? -Infinity : Number(e.target.value))}
              />
            </label>
            <label>
              Max PSA8 loss (% of basis)
              <input
                type="number"
                value={filters.maxPsa8LossPctOfBasis >= 1 ? "" : Math.round(filters.maxPsa8LossPctOfBasis * 100)}
                placeholder="any"
                onChange={(e) =>
                  set("maxPsa8LossPctOfBasis", e.target.value === "" ? 1 : Number(e.target.value) / 100)
                }
              />
            </label>
            <label>
              Max break-even grade
              <select
                value={filters.maxBreakEvenGrade === null ? "" : String(filters.maxBreakEvenGrade)}
                onChange={(e) => set("maxBreakEvenGrade", e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">Any</option>
                <option value="7">PSA 7</option>
                <option value="8">PSA 8</option>
                <option value="9">PSA 9</option>
                <option value="10">PSA 10</option>
              </select>
            </label>
            <label title="How often a card must come back PSA 10 to break even, assuming every other one grades PSA 9. A REQUIRED rate, not a predicted one.">
              Max required 10 rate (%)
              <input
                type="number"
                value={filters.maxRequiredPsa10Rate >= 1 ? "" : Math.round(filters.maxRequiredPsa10Rate * 100)}
                placeholder="any"
                onChange={(e) =>
                  set("maxRequiredPsa10Rate", e.target.value === "" ? 1 : Number(e.target.value) / 100)
                }
              />
            </label>
            <label>
              Grader
              <select value={filters.graderId} onChange={(e) => set("graderId", e.target.value)}>
                <option value="ANY">Any enabled</option>
                <option value="PSA">PSA</option>
              </select>
            </label>
            <label>
              Grading service
              <select
                value={filters.gradingServiceId}
                onChange={(e) => set("gradingServiceId", e.target.value)}
              >
                <option value="ANY">Any enabled</option>
                <option value="PSA_REGULAR">PSA Regular</option>
                <option value="PSA_VALUE">PSA Value</option>
              </select>
            </label>
            <label>
              Max capital lock (days)
              <input
                type="number"
                value={filters.maxEstimatedCapitalLockDays}
                onChange={(e) => set("maxEstimatedCapitalLockDays", Number(e.target.value))}
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}
