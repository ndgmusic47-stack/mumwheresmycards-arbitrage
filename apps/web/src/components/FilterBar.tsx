import { NaturalLanguageQueryBox } from "./NaturalLanguageQueryBox";
import type { DashboardFilters, EconomicClass, OpportunityCategory } from "../state/filters";

/**
 * 2026-09-09 FILTER AUDIT. Every control below was traced from this widget,
 * through `DashboardFilters` and `buildServerFilterParams` (state/filters.ts),
 * into `buildFilterConditions` (apps/worker/src/routes/opportunities.ts), to
 * establish whether it reaches real SQL and therefore narrows the WHOLE
 * result set rather than only the ~75 rows on screen. Four were removed:
 *
 * - **Strategy** (All / Raw flip / Raw → graded): DORMANT on every page.
 *   Dashboard.tsx builds its filter object with `strategy: strategyTab`,
 *   where strategyTab comes from the route (/trade, /trade/flip,
 *   /trade/grade). That assignment happens AFTER the stored `f` param is
 *   spread in, so whatever this dropdown wrote was overwritten on the very
 *   next render. It could never change a result on any page. The page you
 *   are on IS the strategy.
 * - **Grader**: every enabled grader is PSA (BGS and CGC ship disabled — see
 *   DEFAULT_GRADERS in packages/core/src/calc/types.ts), so every stored row
 *   has grader_id = 'PSA'. "Any enabled" and "PSA" therefore selected exactly
 *   the same rows, always.
 * - **Max required 10 rate**: real and working, but it asks the same question
 *   as "Max break-even grade" in a harder way — a card that breaks even at 7
 *   has no meaningful PSA-10 dependency. Break-even grade says it in the
 *   language the user actually thinks in.
 * - **Max capital lock (days)**: real and working; removed at the user's
 *   explicit request. It was largely a proxy for the grading tier anyway
 *   (PSA Value ≈ 160 days vs Regular ≈ 75).
 *
 * The FIELDS for all four remain on DashboardFilters and are still honoured
 * by buildServerFilterParams, so an existing bookmarked URL or a
 * natural-language query that carries one keeps working — only the widgets
 * are gone.
 *
 * Grading service was NOT removed: unlike Grader it is genuinely live, because
 * PSA Regular and PSA Value are both enabled and cost/turnaround differently.
 */

const ECONOMIC_CLASSES: { value: EconomicClass; label: string; title: string }[] = [
  {
    value: "DOWNSIDE_PROTECTED",
    label: "Pays back at PSA 7",
    title:
      "The safest structure: a PSA 7 outcome already returns your money or better, so grades 8, 9 and 10 are upside " +
      "rather than what the trade depends on.",
  },
  {
    value: "BALANCED",
    label: "Small loss at 8, solid at 9",
    title: "A PSA 8 loses only a little, and a PSA 9 makes real money. Needs a 9 to be worth doing.",
  },
  {
    value: "ASYMMETRIC",
    label: "Big payoff, but only at 10",
    title:
      "Large PSA 10 value relative to what you paid, WITHOUT the lower grades being safe. This is the cheap card with " +
      "a huge PSA 10 price — real upside, but you are relying on the top grade.",
  },
];

const CATEGORY_TABS: { value: OpportunityCategory; label: string; title: string }[] = [
  { value: "ACTIONABLE", label: "Actionable", title: "Qualified flips and grading candidates — ready to act on" },
  {
    value: "REVIEW",
    label: "Needs review",
    title:
      "Cleared the economic bar but needs a human to confirm something first — card identity/photo, a possible " +
      "already-graded slab, a possible lot/bundle listing, or condition-dependent pricing",
  },
  { value: "NEAR_MISS", label: "Near misses", title: "Real computed economics, just below the qualifying bar" },
  {
    value: "REJECTED",
    label: "Rejected",
    title: "Always empty by design — rejected candidates are never saved to the database",
  },
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
  // Only worth labelling a section when BOTH are on screen (the Opportunities
  // page). On /trade/flip and /trade/grade the page itself already says which
  // strategy you're looking at, and the heading just repeated it.
  const showSectionHeadings = showFlip && showGrade;
  const economicsApply = filters.category === "ACTIONABLE" || filters.category === "REVIEW" || filters.category === "NEAR_MISS";

  return (
    <div className="filter-panel">
      <NaturalLanguageQueryBox filters={filters} onChange={onChange} />

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
            ? "Always empty — rejected candidates are never stored."
            : "Showing every state at once, so the economics filters below don't apply."}
        </p>
      )}

      <div className="filter-bar">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={filters.auctionsOnly}
            onChange={(e) => set("auctionsOnly", e.target.checked)}
          />
          Auctions only
        </label>

        {filters.category === "ACTIONABLE" && (
          <label
            className="checkbox-label"
            title="AI review can route a qualified candidate to REVIEW or BLOCK — those rows are hidden from this feed by default. Check this to bring them back into the table below, each showing its AI route/confidence/reason, instead of them simply disappearing with no trace."
          >
            <input
              type="checkbox"
              checked={filters.showAiFlagged}
              onChange={(e) => set("showAiFlagged", e.target.checked)}
            />
            Include AI-flagged
          </label>
        )}

        <label title="Your own Save/Pass decision on each listing. 'All' shows everything EXCEPT the ones you have passed — choose 'Passed' to get those back.">
          My decision
          <select
            value={filters.reviewStatus}
            onChange={(e) => set("reviewStatus", e.target.value as DashboardFilters["reviewStatus"])}
          >
            <option value="ALL">All (hides passed)</option>
            <option value="UNREVIEWED">Not yet decided</option>
            <option value="INTERESTED">Saved</option>
            <option value="PASS">Passed</option>
            <option value="CHECKED">Checked</option>
            <option value="BOUGHT">Bought</option>
          </select>
        </label>

        {economicsApply && (
          <>
            <label title="How actively this card actually sells. Low means very few recent sales, so a price is less trustworthy and the card may sit unsold.">
              Min sales activity
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

            <label title="How much to trust the price data behind this row — driven by how many real sold comps it was built from.">
              Min price confidence (%)
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
          {showSectionHeadings && <h3 className="filter-group-heading">Raw flip</h3>}
          <div className="filter-bar">
            <label>
              Min net profit (£)
              <input
                type="number"
                value={filters.minNetProfit}
                onChange={(e) => set("minNetProfit", Number(e.target.value))}
              />
            </label>
            <label title="Return on capital — profit as a percentage of what you put in.">
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
                value={Math.round(filters.minMargin * 100)}
                onChange={(e) => set("minMargin", Number(e.target.value) / 100)}
              />
            </label>
            <label title="Total you would pay including postage, not the headline listing price.">
              Max to pay, delivered (£)
              <input
                type="number"
                value={filters.maxAcquisitionCost}
                onChange={(e) => set("maxAcquisitionCost", Number(e.target.value))}
              />
            </label>
            <label title="Quick Sale Value — the conservative price this should actually sell for, taken from real sold prices.">
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
          {showSectionHeadings && <h3 className="filter-group-heading">Raw → graded</h3>}
          <div className="filter-bar">
            <div className="class-toggles">
              <span className="class-toggle-label" title="The shape of the trade — which grades it needs to work.">
                Trade shape
              </span>
              {ECONOMIC_CLASSES.map((c) => (
                <label key={c.value} className="checkbox-label" title={c.title}>
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
            <label title="Total you would pay for the raw card including postage, before any grading costs.">
              Max to pay for the card (£)
              <input
                type="number"
                value={filters.maxRawAcquisitionCost}
                onChange={(e) => set("maxRawAcquisitionCost", Number(e.target.value))}
              />
            </label>
            <label title="Everything you will have spent per card by the time the slab is back: the card, postage, the grading fee and your share of batch shipping/insurance. This is your real exposure per card.">
              Max all-in inc. grading (£)
              <input
                type="number"
                value={filters.maxTotalGradedBasis}
                onChange={(e) => set("maxTotalGradedBasis", Number(e.target.value))}
              />
            </label>
            <label title="The lowest grade at which this trade already returns your money. Set this to 7 to see only cards that pay back at a PSA 7 or better.">
              Pays back by grade
              <select
                value={filters.maxBreakEvenGrade === null ? "" : String(filters.maxBreakEvenGrade)}
                onChange={(e) => set("maxBreakEvenGrade", e.target.value === "" ? null : Number(e.target.value))}
              >
                <option value="">Any</option>
                <option value="6">PSA 6</option>
                <option value="7">PSA 7</option>
                <option value="8">PSA 8</option>
                <option value="9">PSA 9</option>
                <option value="10">PSA 10</option>
              </select>
            </label>
            <label title="What a PSA 10 of this card sells for.">
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
            <label title="PSA 10 sale price divided by your all-in cost. 5x means a PSA 10 sells for five times what the card costs you.">
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
            <label title="The worst you are willing to lose if the card comes back a PSA 8, as a percentage of your all-in cost.">
              Max PSA8 loss (% of cost)
              <input
                type="number"
                value={filters.maxPsa8LossPctOfBasis >= 1 ? "" : Math.round(filters.maxPsa8LossPctOfBasis * 100)}
                placeholder="any"
                onChange={(e) =>
                  set("maxPsa8LossPctOfBasis", e.target.value === "" ? 1 : Number(e.target.value) / 100)
                }
              />
            </label>
            <label title="PSA Value is cheaper but slower (about 160 days); PSA Regular costs more and comes back sooner (about 75 days). This picks rows by which tier the economics chose.">
              Grading tier
              <select
                value={filters.gradingServiceId}
                onChange={(e) => set("gradingServiceId", e.target.value)}
              >
                <option value="ANY">Any</option>
                <option value="PSA_REGULAR">PSA Regular (faster, dearer)</option>
                <option value="PSA_VALUE">PSA Value (cheaper, slower)</option>
              </select>
            </label>
          </div>
        </>
      )}
    </div>
  );
}
