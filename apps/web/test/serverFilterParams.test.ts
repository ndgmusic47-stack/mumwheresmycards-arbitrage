import { describe, it, expect } from "vitest";
import {
  DEFAULT_DASHBOARD_FILTERS,
  buildServerFilterParams,
  listingKindAllows,
  type DashboardFilters,
} from "../src/state/filters";

/**
 * REGRESSION GUARD for the 2026-09-08 "make the grade filters actually
 * filter" change, on the CLIENT half.
 *
 * The server half is covered by apps/worker/test/gradeServerFilters.test.ts.
 * This file guards the rule that decides whether those conditions are sent
 * AT ALL, and it is the more dangerous half of the two:
 *
 * every GRADE column (economic_class, total_graded_basis, psa*_profit,
 * break_even_grade, required_psa10_rate_vs_psa9, grader_id, ...) is NULL on
 * a FLIP row. So sending a single grade condition while the user is on the
 * mixed "All" strategy view would make every flip fail it and vanish — the
 * exact shape of bug this codebase has hit before at a different layer (see
 * the project doc's tenth/eleventh lessons). Hence: grade params under
 * GRADE only, flip params under FLIP only, and neither under ALL.
 *
 * The second rule these tests pin down is that an UNTOUCHED control must put
 * nothing on the wire. The "no minimum" defaults are 0 / 1 / ±Infinity /
 * null, and naively sending those would start excluding rows whose column is
 * merely NULL — turning a filter the user never touched into a silent one.
 */
function filters(overrides: Partial<DashboardFilters> = {}): DashboardFilters {
  return { ...DEFAULT_DASHBOARD_FILTERS, ...overrides };
}

describe("buildServerFilterParams — strategy isolation", () => {
  it("sends NO strategy-specific filter under the mixed ALL view", () => {
    const params = buildServerFilterParams(filters({ strategy: "ALL", category: "ACTIONABLE" }));

    // A grade column under ALL would delete every flip; a flip column would
    // delete every grade. Neither may appear.
    expect(params.economicClass).toBeUndefined();
    expect(params.maxTotalGradedBasis).toBeUndefined();
    expect(params.minPsa10Value).toBeUndefined();
    expect(params.maxBreakEvenGrade).toBeUndefined();
    expect(params.graderId).toBeUndefined();
    expect(params.minNetProfit).toBeUndefined();
    expect(params.minRoc).toBeUndefined();
    expect(params.maxDeliveredCost).toBeUndefined();

    // The two every row genuinely has are still safe to send.
    expect(params.minConfidence).toBe(DEFAULT_DASHBOARD_FILTERS.minConfidence);
    expect(params.liquidity).toBe("MEDIUM,HIGH,VERY_HIGH");
  });

  it("sends no grade filter under FLIP", () => {
    const params = buildServerFilterParams(filters({ strategy: "FLIP", maxBreakEvenGrade: 9, graderId: "psa" }));
    expect(params.maxBreakEvenGrade).toBeUndefined();
    expect(params.graderId).toBeUndefined();
    expect(params.minNetProfit).toBe(DEFAULT_DASHBOARD_FILTERS.minNetProfit);
  });
});

describe("buildServerFilterParams — grade levers actually leave the browser", () => {
  it("sends every tightened grade lever", () => {
    const params = buildServerFilterParams(
      filters({
        strategy: "GRADE",
        maxTotalGradedBasis: 900,
        minPsa10Value: 120,
        minPsa10Profit: 50,
        minPsa10GrossMultiple: 4,
        minPsa9Profit: 0,
        maxPsa8LossPctOfBasis: 0.25,
        maxBreakEvenGrade: 9,
        maxRequiredPsa10Rate: 0.4,
        graderId: "psa",
        gradingServiceId: "psa-value",
      }),
    );

    expect(params.maxTotalGradedBasis).toBe(900);
    expect(params.minPsa10Value).toBe(120);
    expect(params.minPsa10Profit).toBe(50);
    expect(params.minPsa10GrossMultiple).toBe(4);
    expect(params.minPsa9Profit).toBe(0);
    expect(params.maxPsa8LossPctOfBasis).toBe(0.25);
    expect(params.maxBreakEvenGrade).toBe(9);
    expect(params.maxRequiredPsa10Rate).toBe(0.4);
    expect(params.graderId).toBe("psa");
    expect(params.gradingServiceId).toBe("psa-value");
  });

  it("appends the __NULL__ sentinel so an unclassified row survives, matching applyDashboardFilters", () => {
    const params = buildServerFilterParams(filters({ strategy: "GRADE", economicClasses: ["BALANCED"] }));
    expect(params.economicClass).toBe("BALANCED,__NULL__");
  });

  it("stays silent on every lever left at its no-op default", () => {
    const params = buildServerFilterParams(filters({ strategy: "GRADE" }));

    // Defaults are 0 / 1 / -Infinity / "ANY" / null — "no minimum", not
    // "exclude everything with a NULL here".
    expect(params.minPsa10Profit).toBeUndefined(); // 0
    expect(params.minPsa10GrossMultiple).toBeUndefined(); // 0
    expect(params.minPsa9Profit).toBeUndefined(); // -Infinity
    expect(params.maxPsa8LossPctOfBasis).toBeUndefined(); // 1
    expect(params.maxBreakEvenGrade).toBeUndefined(); // null
    expect(params.maxRequiredPsa10Rate).toBeUndefined(); // 1
    expect(params.graderId).toBeUndefined(); // "ANY"
    expect(params.gradingServiceId).toBeUndefined(); // "ANY"
  });

  it("never sends -Infinity, which would serialise into the URL as a string", () => {
    const params = buildServerFilterParams(filters({ strategy: "GRADE", minPsa9Profit: -Infinity }));
    expect(params.minPsa9Profit).toBeUndefined();
  });
});

describe("buildServerFilterParams — cross-cutting filters", () => {
  it("sends reviewStatus under any strategy, but not when it is ALL", () => {
    expect(buildServerFilterParams(filters({ strategy: "ALL", reviewStatus: "INTERESTED" })).reviewStatus).toBe("INTERESTED");
    expect(buildServerFilterParams(filters({ strategy: "GRADE", reviewStatus: "BOUGHT" })).reviewStatus).toBe("BOUGHT");
    expect(buildServerFilterParams(filters({ strategy: "ALL", reviewStatus: "ALL" })).reviewStatus).toBeUndefined();
  });

  it("still sends reviewStatus and auctionsOnly in a category with no economics pass", () => {
    // REJECTED/ALL return early before the economics block — the two
    // cross-cutting tags must survive that early return.
    const params = buildServerFilterParams(filters({ category: "REJECTED", reviewStatus: "PASS", auctionsOnly: true }));
    expect(params.reviewStatus).toBe("PASS");
    expect(params.listingType).toBe("AUCTION");
    expect(params.minConfidence).toBeUndefined();
  });
});

describe("Pass is hidden from the working feed by default (2026-09-09)", () => {
  it("sends excludeReviewStatus=PASS whenever the decision filter is 'All'", () => {
    const params = buildServerFilterParams(filters({ reviewStatus: "ALL" }));
    expect(params.excludeReviewStatus).toBe("PASS");
    expect(params.reviewStatus).toBeUndefined();
  });

  it("does NOT exclude anything when the user explicitly asks to see Passed", () => {
    // Otherwise the one view that exists to recover a dismissed listing would
    // filter out every row it is supposed to show.
    const params = buildServerFilterParams(filters({ reviewStatus: "PASS" }));
    expect(params.reviewStatus).toBe("PASS");
    expect(params.excludeReviewStatus).toBeUndefined();
  });

  it("hides passed listings in every category, including ones with no economics pass", () => {
    for (const category of ["ACTIONABLE", "REVIEW", "NEAR_MISS", "REJECTED", "ALL"] as const) {
      const params = buildServerFilterParams(filters({ category, reviewStatus: "ALL" }));
      expect(params.excludeReviewStatus).toBe("PASS");
    }
  });
});

describe("controls removed in the 2026-09-09 audit still honour a saved URL", () => {
  // The widgets are gone, but the FIELDS remain, so an existing bookmark or a
  // natural-language query that carries one must keep behaving identically.
  it("still sends maxRequiredPsa10Rate and graderId when a stored filter set carries them", () => {
    const params = buildServerFilterParams(
      filters({ strategy: "GRADE", maxRequiredPsa10Rate: 0.3, graderId: "PSA" }),
    );
    expect(params.maxRequiredPsa10Rate).toBe(0.3);
    expect(params.graderId).toBe("PSA");
  });

  it("still sends maxCapitalLock from a stored filter set", () => {
    const params = buildServerFilterParams(filters({ strategy: "GRADE", maxEstimatedCapitalLockDays: 120 }));
    expect(params.maxCapitalLock).toBe(120);
  });
});

describe("sold and ended listings never reach the working feed (2026-09-09)", () => {
  it("always requests ACTIVE listings only", () => {
    for (const category of ["ACTIONABLE", "REVIEW", "NEAR_MISS", "REJECTED", "ALL"] as const) {
      expect(buildServerFilterParams(filters({ category })).listingStatus).toBe("ACTIVE");
    }
  });

  it("does so regardless of strategy, since listing state has nothing to do with flip vs grade", () => {
    for (const strategy of ["ALL", "FLIP", "GRADE"] as const) {
      expect(buildServerFilterParams(filters({ strategy })).listingStatus).toBe("ACTIVE");
    }
  });
});

describe("listing type — Buy It Now finally exists (2026-09-10)", () => {
  /**
   * Before this, the ONLY listing-type control was an "Auctions only" tick
   * box: you could have auctions, or everything. There was no way to ask for
   * Buy It Now, and Best Offer listings — stored by the scanner, filterable
   * by the server since forever — could not be reached from the UI at all.
   *
   * BEST_OFFER is the one that matters: those rows are costed at the ASKING
   * price, which is an opening position rather than a price anyone pays, so
   * the single category where a below-market deal gets agreed privately was
   * both mis-costed and unreachable.
   */
  it("sends nothing at all for 'All listings', so nothing is narrowed", () => {
    expect(buildServerFilterParams(filters({ listingKind: "ALL" })).listingType).toBeUndefined();
  });

  it("'Buy it now' means anything purchasable without bidding — fixed AND best offer", () => {
    expect(buildServerFilterParams(filters({ listingKind: "BIN" })).listingType).toBe("FIXED,BEST_OFFER");
  });

  it("'offers accepted' isolates BEST_OFFER, the previously unreachable category", () => {
    expect(buildServerFilterParams(filters({ listingKind: "BEST_OFFER" })).listingType).toBe("BEST_OFFER");
  });

  it("'Auctions' still means AUCTION", () => {
    expect(buildServerFilterParams(filters({ listingKind: "AUCTION" })).listingType).toBe("AUCTION");
  });

  it("applies under every strategy — listing type has nothing to do with flip vs grade", () => {
    for (const strategy of ["ALL", "FLIP", "GRADE"] as const) {
      expect(buildServerFilterParams(filters({ strategy, listingKind: "BIN" })).listingType).toBe("FIXED,BEST_OFFER");
    }
  });

  it("applies in categories that skip the economics block", () => {
    expect(buildServerFilterParams(filters({ category: "REJECTED", listingKind: "BEST_OFFER" })).listingType).toBe("BEST_OFFER");
  });
});

describe("the old auctionsOnly flag still works for saved URLs", () => {
  it("an existing bookmark carrying auctionsOnly=true still gets auctions", () => {
    expect(buildServerFilterParams(filters({ auctionsOnly: true })).listingType).toBe("AUCTION");
  });

  it("an explicit listingKind wins over the legacy flag rather than fighting it", () => {
    const params = buildServerFilterParams(filters({ auctionsOnly: true, listingKind: "BIN" }));
    expect(params.listingType).toBe("FIXED,BEST_OFFER");
  });

  it("the default sends no listing-type clause at all", () => {
    expect(buildServerFilterParams(filters()).listingType).toBeUndefined();
  });
});

describe("the client-side mirror agrees with what was sent", () => {
  it("keeps only the types the server was asked for", () => {
    const binOnly = filters({ listingKind: "BIN" });
    expect(listingKindAllows(binOnly, "FIXED")).toBe(true);
    expect(listingKindAllows(binOnly, "BEST_OFFER")).toBe(true);
    expect(listingKindAllows(binOnly, "AUCTION")).toBe(false);
  });

  it("lets everything through when nothing was narrowed", () => {
    for (const type of ["FIXED", "BEST_OFFER", "AUCTION", null]) {
      expect(listingKindAllows(filters(), type)).toBe(true);
    }
  });

  it("never contradicts buildServerFilterParams", () => {
    for (const listingKind of ["ALL", "BIN", "BEST_OFFER", "AUCTION"] as const) {
      const f = filters({ listingKind });
      const sent = buildServerFilterParams(f).listingType;
      for (const type of ["FIXED", "BEST_OFFER", "AUCTION"]) {
        const serverWouldKeep = sent === undefined || sent.split(",").includes(type);
        expect(listingKindAllows(f, type)).toBe(serverWouldKeep);
      }
    }
  });
});
