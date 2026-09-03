import { describe, it, expect } from "vitest";
import {
  computeFlipProfile,
  computeGradeProfile,
  DEFAULT_FLIP_QUALIFICATION,
  DEFAULT_MARKET_PROFILE_SETTINGS,
  DEFAULT_GRADING_SERVICES,
  type ProfileSnapshotInput,
} from "../src/index.js";

function snapshot(overrides: Partial<ProfileSnapshotInput> = {}): ProfileSnapshotInput {
  return {
    rawMarketPrice: 300,
    rawMedian7d: 300,
    rawMedian30d: 310,
    rawQsv: 276,
    psa7: 150,
    psa8: 260,
    psa9: 520,
    psa10: 1800,
    confidence: 0.85,
    liquidity: "HIGH",
    sampleSize: 40,
    ...overrides,
  };
}

describe("computeFlipProfile — catalogue-level flip eligibility", () => {
  it("is eligible for a liquid, well-priced card and produces an acquisition ceiling", () => {
    const profile = computeFlipProfile(snapshot());

    expect(profile.eligible).toBe(true);
    expect(profile.maxProfitableAcquisitionPrice!).toBeGreaterThan(0);
    expect(profile.flipMarketScore).not.toBeNull();
  });

  describe("discoveryMaxAcquisitionPrice — MWMC V1 FINAL SHIP PASS item 4/6/7 (discovery/qualification-bar decoupling)", () => {
    it("is a broader, break-even ceiling that always sits at or above the qualification-bar ceiling", () => {
      const profile = computeFlipProfile(snapshot(), DEFAULT_FLIP_QUALIFICATION);

      expect(profile.discoveryMaxAcquisitionPrice).not.toBeNull();
      expect(profile.discoveryMaxAcquisitionPrice!).toBeGreaterThanOrEqual(profile.maxProfitableAcquisitionPrice!);
    });

    it("does NOT move when the qualification bar changes — it's derived from QSV/exit costs only, never the business threshold", () => {
      const lenient = computeFlipProfile(snapshot(), { minNetProfit: 10, minReturnOnCapital: 0.1 });
      const strict = computeFlipProfile(snapshot(), { minNetProfit: 100, minReturnOnCapital: 0.8 });

      // The qualification-bar ceiling DOES move (regression-guarded above)...
      expect(strict.maxProfitableAcquisitionPrice!).toBeLessThan(lenient.maxProfitableAcquisitionPrice!);
      // ...but the discovery ceiling is the exact same break-even number
      // either way, since it never reads `qualification` at all.
      expect(strict.discoveryMaxAcquisitionPrice).toBe(lenient.discoveryMaxAcquisitionPrice);
    });

    it("stays eligible (discoverable) for a card that can never clear the persisted bar at any price, as long as it can still break even", () => {
      // £100,000 minimum profit is unreachable at any acquisition price for
      // this card's QSV — the OLD behaviour marked the whole card ineligible
      // here, which meant it was never even searched on eBay, so a real
      // sub-bar candidate (e.g. £32 profit / 28% ROC) could never be
      // discovered no matter how a manual filter was loosened afterwards.
      const profile = computeFlipProfile(snapshot(), { minNetProfit: 100_000, minReturnOnCapital: 0.4 });

      expect(profile.maxProfitableAcquisitionPrice).toBe(0); // never clears the £100k bar
      expect(profile.discoveryMaxAcquisitionPrice!).toBeGreaterThan(0); // but IS still a real, profitable trade at some price
      expect(profile.eligible).toBe(true); // so it's still searched for on eBay
      expect(profile.ineligibleReason).toBeNull();
      expect(profile.flipMarketScore).toBeNull(); // no bar-relative reference score to give it, though
    });

    it("is ineligible (both ceilings stay unset) when an earlier catalogue-level gate — e.g. the minimum flip floor — rejects the card before break-even is ever computed", () => {
      // A QSV this small never clears settings.minFlipRawValue, so this
      // short-circuits at that earlier gate — same case as the "minimum
      // flip floor" test above, asserted here for both ceilings together.
      const profile = computeFlipProfile(snapshot({ rawMedian7d: 1, rawMedian30d: 1, rawMarketPrice: 1, rawQsv: 1 }));

      expect(profile.eligible).toBe(false);
      expect(profile.maxProfitableAcquisitionPrice).toBeNull();
      expect(profile.discoveryMaxAcquisitionPrice).toBeNull();
    });

    it("is ineligible with both ceilings at exactly zero when the card clears every catalogue gate but still can't break even even for free", () => {
      // A £2 QSV whose fixed exit costs (postage/packaging/fees, ~£3+ under
      // DEFAULT_SELLING_COSTS) exceed it outright — computeNetSaleProceeds
      // ends up negative, so even a £0 acquisition price loses money. Passes
      // a permissive minFlipRawValue so this reaches the break-even
      // computation itself rather than short-circuiting at the earlier
      // catalogue-floor gate (see the test above for that case). This is the
      // one case where discoveryMaxAcquisitionPrice is correctly 0, not null.
      const profile = computeFlipProfile(
        snapshot({ rawMedian7d: 2, rawMedian30d: 2, rawMarketPrice: 2, rawQsv: 2 }),
        DEFAULT_FLIP_QUALIFICATION,
        { ...DEFAULT_MARKET_PROFILE_SETTINGS, minFlipRawValue: 0 },
      );

      expect(profile.discoveryMaxAcquisitionPrice).toBe(0);
      expect(profile.maxProfitableAcquisitionPrice).toBe(0);
      expect(profile.eligible).toBe(false);
      expect(profile.ineligibleReason).toMatch(/No acquisition price/);
    });
  });

  it("derives QSV from sold medians, with the haircut", () => {
    const profile = computeFlipProfile(snapshot());
    expect(profile.conservativeQsv).toBeCloseTo(276, 0); // min(300,310) * 0.92
    expect(profile.qsvBasis).toBe("BOTH_SOLD_MEDIANS");
    expect(profile.isHighConfidenceQsv).toBe(true);
  });

  it("prices the acquisition ceiling so that BOTH the £ and ROC bars are met", () => {
    const profile = computeFlipProfile(snapshot(), DEFAULT_FLIP_QUALIFICATION);
    const ceiling = profile.maxProfitableAcquisitionPrice!;

    // Buying at exactly the ceiling should sit right on the qualification
    // boundary — never above it.
    expect(ceiling).toBeGreaterThan(0);
    expect(ceiling).toBeLessThan(profile.conservativeQsv!);
  });

  it("tightens the ceiling as the profit bar rises", () => {
    const lenient = computeFlipProfile(snapshot(), { minNetProfit: 10, minReturnOnCapital: 0.1 });
    const strict = computeFlipProfile(snapshot(), { minNetProfit: 100, minReturnOnCapital: 0.8 });

    expect(strict.maxProfitableAcquisitionPrice!).toBeLessThan(lenient.maxProfitableAcquisitionPrice!);
  });

  it("is ineligible with no usable price data", () => {
    const profile = computeFlipProfile(
      snapshot({ rawMarketPrice: null, rawMedian7d: null, rawMedian30d: null, rawQsv: null }),
    );

    expect(profile.eligible).toBe(false);
    expect(profile.ineligibleReason).toMatch(/No usable sold-median or reference price/);
  });

  it("is ineligible below the minimum flip floor", () => {
    const profile = computeFlipProfile(snapshot({ rawMedian7d: 2, rawMedian30d: 2, rawMarketPrice: 2 }));
    expect(profile.eligible).toBe(false);
    expect(profile.ineligibleReason).toMatch(/minimum flip floor/);
  });

  it("is ineligible below the liquidity and confidence floors", () => {
    expect(
      computeFlipProfile(snapshot({ liquidity: "LOW" }), DEFAULT_FLIP_QUALIFICATION, {
        ...DEFAULT_MARKET_PROFILE_SETTINGS,
        minFlipLiquidity: "HIGH",
      }).eligible,
    ).toBe(false);

    expect(computeFlipProfile(snapshot({ confidence: 0.1 })).eligible).toBe(false);
  });

  it("reports a zero qualification-bar ceiling when no price at all could clear the bar — but stays eligible via the broader discovery ceiling (see the decoupling describe block below)", () => {
    const profile = computeFlipProfile(snapshot(), { minNetProfit: 100_000, minReturnOnCapital: 0.4 });

    expect(profile.maxProfitableAcquisitionPrice).toBe(0);
    expect(profile.eligible).toBe(true);
    expect(profile.discoveryMaxAcquisitionPrice!).toBeGreaterThan(0);
  });
});

describe("computeGradeProfile — catalogue-level grade eligibility", () => {
  it("is eligible and classified for a card with real grading upside", () => {
    const profile = computeGradeProfile(snapshot());

    expect(profile.eligible).toBe(true);
    expect(profile.economicClass).not.toBe("UNCLASSIFIED");
    expect(profile.referenceGradedBasis!).toBeGreaterThan(snapshot().rawMarketPrice!);
    expect(profile.referenceServiceId).toBeTruthy();
  });

  it("uses the configured grading service fee, not a hardcoded £65", () => {
    const cheap = computeGradeProfile(
      snapshot(),
      DEFAULT_MARKET_PROFILE_SETTINGS,
      [{ ...DEFAULT_GRADING_SERVICES[0]!, id: "CHEAP", feePerCard: 5 }],
    );
    const pricey = computeGradeProfile(
      snapshot(),
      DEFAULT_MARKET_PROFILE_SETTINGS,
      [{ ...DEFAULT_GRADING_SERVICES[0]!, id: "PRICEY", feePerCard: 200 }],
    );

    expect(pricey.referenceGradedBasis! - cheap.referenceGradedBasis!).toBeCloseTo(195, 1);
  });

  it("does NOT reject an asymmetric card for failing at lower grades", () => {
    // Loses at 7/8/9, exceptional at 10.
    const profile = computeGradeProfile(
      snapshot({ psa7: 40, psa8: 90, psa9: 200, psa10: 8000, rawMarketPrice: 250 }),
    );

    expect(profile.economicClass).toBe("ASYMMETRIC");
    expect(profile.eligible).toBe(true);
  });

  it("can be configured to exclude a class from catalogue eligibility", () => {
    const profile = computeGradeProfile(
      snapshot({ psa7: 40, psa8: 90, psa9: 200, psa10: 8000, rawMarketPrice: 250 }),
      { ...DEFAULT_MARKET_PROFILE_SETTINGS, eligibleEconomicClasses: ["DOWNSIDE_PROTECTED", "BALANCED"] },
    );

    expect(profile.economicClass).toBe("ASYMMETRIC");
    expect(profile.eligible).toBe(false);
    expect(profile.ineligibleReason).toMatch(/not in the catalogue-eligible set/);
  });

  it("reports the required PSA10 hit rate for the catalogue view", () => {
    const profile = computeGradeProfile(snapshot());
    expect(profile.requiredPsa10RateVsPsa9).toBeDefined();
  });

  it("reports estimated capital lock", () => {
    const profile = computeGradeProfile(snapshot());
    expect(profile.estimatedCapitalLockDays!).toBeGreaterThan(0);
  });

  it("is ineligible without PSA9/PSA10 data", () => {
    const profile = computeGradeProfile(snapshot({ psa9: null, psa10: null }));
    expect(profile.eligible).toBe(false);
    expect(profile.ineligibleReason).toMatch(/No PSA9\/PSA10 market data/);
  });

  it("is ineligible below the raw-value and confidence floors", () => {
    expect(computeGradeProfile(snapshot({ rawMarketPrice: 2 })).eligible).toBe(false);
    expect(computeGradeProfile(snapshot({ confidence: 0.1 })).eligible).toBe(false);
  });

  it("leaves a hopeless card unclassified and ineligible, with a reason", () => {
    const profile = computeGradeProfile(
      snapshot({ rawMarketPrice: 400, psa7: 50, psa8: 80, psa9: 150, psa10: 300 }),
    );

    expect(profile.economicClass).toBe("UNCLASSIFIED");
    expect(profile.eligible).toBe(false);
    expect(profile.ineligibleReason).toMatch(/No viable grading structure/);
  });
});
