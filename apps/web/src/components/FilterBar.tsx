import type { DashboardFilters, OpportunityCategory } from "../state/filters";

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
  {
    value: "PASSED",
    label: "Passed",
    title:
      "Cards you dismissed. Click Pass again on any row to put it straight back in your feed. Worth a look — " +
      "anything passed before 14 September was judged against slab prices that have since been corrected.",
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
  onClear,
}: {
  filters: DashboardFilters;
  onChange: (next: DashboardFilters) => void;
  /** Wipes the filters AND the tab's remembered view/scroll position.
   *  2026-09-09: needed once each strategy tab started remembering its own
   *  filters across tab switches — without an explicit reset, a narrow filter
   *  set becomes sticky with no obvious way out. */
  onClear?: () => void;
}) {
  function set<K extends keyof DashboardFilters>(key: K, value: DashboardFilters[K]) {
    onChange({ ...filters, [key]: value });
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
      <div className="filter-panel-top">
        {onClear && (
          <button
            type="button"
            className="clear-filters-button"
            onClick={onClear}
            title="Reset every filter on this tab and forget the saved scroll position."
          >
            Clear filters
          </button>
        )}
      </div>

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
        {/* 2026-09-10: was a bare "Auctions only" tick box, which meant the
            feed could be narrowed to auctions or left wide open and nothing
            else — no Buy It Now, and no way to see Best Offer listings at
            all. Same slot, same single control, four real choices.
            `auctionsOnly` is still honoured underneath for saved URLs. */}
        <label>
          Listing type
          <select
            value={filters.listingKind}
            onChange={(e) => {
              const next = e.target.value as DashboardFilters["listingKind"];
              // Clear the legacy flag so the two can never fight.
              onChange({ ...filters, listingKind: next, auctionsOnly: false });
            }}
          >
            <option value="ALL">All listings</option>
            <option value="BIN" title="Anything you can buy without bidding — fixed price and Best Offer.">
              Buy it now
            </option>
            <option
              value="BEST_OFFER"
              title="Sellers accepting offers. The price shown is the ASKING price — what you would actually pay is whatever offer they accept, so treat it as a starting point."
            >
              Buy it now — offers accepted
            </option>
            <option value="AUCTION" title="Live auctions. Sort by the Ends column for the ones closing soonest.">
              Auctions
            </option>
          </select>
        </label>

        {/* 2026-09-13. Both of these describe the LISTING rather than the
            trade, so they sit beside listing type and apply in every
            category — unlike the economics thresholds further down. */}
        <label title="Where the card ships from. This is a money question, not a convenience one: import duty, VAT and handling fees are NOT included in any figure in this tool, so anything from outside the UK costs more than it says.">
          Ships from
          <select
            value={filters.sourceRegion}
            onChange={(e) => set("sourceRegion", e.target.value as DashboardFilters["sourceRegion"])}
          >
            <option value="ANY" title="Everywhere. Most of what you see will be American, and every non-UK row understates what it will actually cost you.">
              Anywhere
            </option>
            <option value="UK_ONLY" title="UK sellers only. The only option where the delivered cost shown is the delivered cost you pay — nothing to add for import.">
              United Kingdom only
            </option>
            <option value="UK_EU" title="UK and Europe. Closer and easier to deal with than the US, but a European seller is still an import since Brexit — VAT and handling still apply and are still not modelled here.">
              UK &amp; Europe
            </option>
          </select>
        </label>

        <label title="eBay's own Graded/Ungraded flag, in every language eBay reports it in. Ungraded raw cards are what this tool is built to buy.">
          Graded?
          <select
            value={filters.ebayCondition}
            onChange={(e) => set("ebayCondition", e.target.value as DashboardFilters["ebayCondition"])}
          >
            <option value="ANY">Either</option>
            <option value="UNGRADED" title="Raw cards — what you send off to be graded.">
              Ungraded only
            </option>
            <option value="GRADED" title="Slabs eBay has flagged as already graded. Raw economics do not apply to these; useful for checking what the tool is filtering out.">
              Already graded
            </option>
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
            <label title="Total you would pay for the raw card including postage, before any grading costs.">
              Max to pay for the card (£)
              <input
                type="number"
                value={filters.maxRawAcquisitionCost}
                onChange={(e) => set("maxRawAcquisitionCost", Number(e.target.value))}
              />
            </label>
            {/*
                2026-09-19: "Max all-in inc. grading (£)" REMOVED at the
                operator's request. It capped card + postage + grading fee +
                batch share at £1,500 and was a second ceiling sitting
                behind "Max raw price", which is the one he actually steers
                with — so its only effect was removing cards from behind a
                limit he had already set elsewhere.

                The underlying rule still exists and still works; it is now
                null by default, meaning no cap, and a null cap is skipped
                rather than recorded as passed. If a ceiling on total
                exposure is ever wanted again, it comes back as a control
                here rather than as a default nobody chose.
            */}
            {/*
                2026-09-13: THESE WERE TWO CONTROLS AND ONE OF THEM DID NOTHING.
                Reported as "Grade I'm buying on — not working and I don't know
                what it means", and both halves of that were correct.

                The grade picker on its own has no effect whatsoever: the rule
                is "profit at grade N must be at least £X", so with £X blank
                there is no rule and changing N changes nothing. Nothing said
                so. Two boxes, one inert until the other is filled in, no
                indication of the dependency — which is exactly the "broken
                messy toggles" problem.

                It is one rule, so it is now one control, written as the
                sentence it actually is, and it says out loud when it is off.

                AND THEN IT ABSORBED TWO MORE. Pointed out immediately after:
                "its the same logic already, seems redundant." Correct, and
                there were THREE controls asking one question:

                  Pays back by grade = PSA 8   ->  profit at PSA 8 >= £0
                  Min PSA10 profit   = £100    ->  profit at PSA 10 >= £100
                  Must make £X at PSA Y        ->  profit at PSA Y >= £X

                The third is the general form of the other two; the first is
                it with the amount fixed at zero, the second with the grade
                fixed at ten. Three widgets, one rule, and every extra one is
                somewhere else for the answer to disagree with itself.

                Both are gone from the UI. The FIELDS stay on DashboardFilters
                and are still honoured by buildServerFilterParams, so a
                bookmark or a saved view that carries either keeps returning
                exactly what it always returned — removing a control must not
                change what an existing link means.

                The break-even grade is still a COLUMN on every row, because
                "what is the lowest grade that pays?" is a genuinely useful
                thing to READ. It just isn't a second way to ask the same
                question.
            */}
            <label
              className="filter-rule"
              title="The heart of the low-grade strategy: show me cards that make real money at a grade I can actually expect to get, instead of ones that only pay at a PSA 10. Type an amount to switch the rule on."
            >
              Must make at least…
              <span className="filter-rule-row">
                <span className="filter-rule-prefix">£</span>
                <input
                  type="number"
                  className="filter-rule-amount"
                  value={Number.isFinite(filters.minBuyGradeProfit) ? filters.minBuyGradeProfit : ""}
                  placeholder="any"
                  aria-label="Minimum profit in pounds at the chosen grade"
                  onChange={(e) => set("minBuyGradeProfit", e.target.value === "" ? -Infinity : Number(e.target.value))}
                />
                <span className="filter-rule-joiner">at</span>
                <select
                  value={String(filters.buyGrade)}
                  aria-label="The grade that profit is measured at"
                  onChange={(e) => set("buyGrade", Number(e.target.value) as DashboardFilters["buyGrade"])}
                >
                  <option value="6">PSA 6</option>
                  <option value="7">PSA 7</option>
                  <option value="8">PSA 8</option>
                  <option value="9">PSA 9</option>
                  <option value="10" title="Only worth asking for if you are deliberately hunting a gem-mint lottery ticket — and the PSA 10 figures are the least reliable on the ladder.">
                    PSA 10
                  </option>
                </select>
              </span>
              <span className="filter-rule-hint">
                {Number.isFinite(filters.minBuyGradeProfit)
                  ? `Hiding anything that doesn't clear £${filters.minBuyGradeProfit} at PSA ${filters.buyGrade}.`
                  : "Off — put an amount in the box to use this."}
              </span>
            </label>
            <label title="What a PSA 10 of this card sells for.">
              Min PSA10 value (£)
              <input
                type="number"
                value={filters.minPsa10Value}
                onChange={(e) => set("minPsa10Value", Number(e.target.value))}
              />
            </label>
          </div>
        </>
      )}
    </div>
  );
}
