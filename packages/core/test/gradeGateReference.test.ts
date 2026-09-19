import { describe, it, expect } from "vitest";
import { computeGradeProfile } from "../src/market/gradeProfile.js";
import type { ProfileSnapshotInput } from "../src/market/types.js";

/**
 * WHAT PRICE A CARD IS JUDGED AT BEFORE eBay IS EVER ASKED ABOUT IT.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GATE THIS PINS. Every catalogued card is tested once, cheaply, to
 * decide whether it enters the eBay search universe at all. Until
 * 2026-09-19 that test priced the hypothetical purchase at
 * `rawMarketPrice` — the provider's raw AVERAGE.
 *
 * That average is a figure this codebase distrusts everywhere else.
 * pricePlausibility.ts records it reading £1,655 on a card whose true market
 * value was nearer £1,025: it is the statistic a mis-listed bundle distorts,
 * and it runs high. A card failed the gate because it could not pay back
 * grading at a price nobody would actually pay.
 *
 * The failure mode is what makes it worth a test file. A card rejected here
 * is never searched for on eBay, so no listing for it is ever priced, and
 * nothing anywhere reports a near miss. It does not appear as a rejected
 * opportunity. It simply is not there. On the live database 3,214 cards were
 * excluded this way — the second-largest exclusion reason after the £5
 * floor, and the largest one that is arguable.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT MUST NOT DRIFT. The fix is to judge the card against its
 * CONSERVATIVE sold-median value (QSV), the same reference the opportunity
 * engine uses on real listings. It is emphatically NOT a discount invented
 * to pass more cards, and the last test here is the one that holds that
 * line: a card that only works if bought far below what it sells for must
 * still fail.
 */
function snapshot(over: Partial<ProfileSnapshotInput> = {}): ProfileSnapshotInput {
  return {
    rawMarketPrice: 200,
    rawMedian7d: 150,
    rawMedian30d: 155,
    rawQsv: 140,
    psa6: 260,
    psa7: 300,
    psa8: 380,
    psa9: 620,
    psa10: 1400,
    confidence: 0.85,
    liquidity: "HIGH",
    sampleSize: 40,
    ...over,
  };
}

describe("the catalogue gate judges a card at its conservative value", () => {
  it("uses QSV, not the raw average — provable by moving only the average", () => {
    // Same card, same slab ladder, same QSV. Only the average moves, and it
    // moves absurdly. If the gate still read the average, this would change
    // the verdict; it must not.
    const honest = computeGradeProfile(snapshot({ rawMarketPrice: 200 }));
    const inflated = computeGradeProfile(snapshot({ rawMarketPrice: 5000 }));

    expect(inflated.eligible).toBe(honest.eligible);
    expect(inflated.breakEvenGrade).toBe(honest.breakEvenGrade);
    expect(inflated.referenceGradedBasis).toBe(honest.referenceGradedBasis);
  });

  it("moves the verdict when the CONSERVATIVE value moves, because that is what it reads", () => {
    const cheap = computeGradeProfile(snapshot({ rawQsv: 140 }));
    const dear = computeGradeProfile(snapshot({ rawQsv: 900 }));

    // The same slab ladder cannot pay back a £900 acquisition the way it pays
    // back a £140 one.
    expect(cheap.referenceGradedBasis).not.toBe(dear.referenceGradedBasis);
    expect(dear.referenceGradedBasis!).toBeGreaterThan(cheap.referenceGradedBasis!);
  });

  it("falls back to the average only when no conservative value exists", () => {
    // A snapshot with no sold medians behind it has no QSV. The average is
    // then the only figure there is, and using it is honest — using nothing
    // would drop the card for want of a number we never had.
    const result = computeGradeProfile(snapshot({ rawQsv: null, rawMarketPrice: 140 }));
    const withQsv = computeGradeProfile(snapshot({ rawQsv: 140, rawMarketPrice: 9999 }));

    expect(result.referenceGradedBasis).toBe(withQsv.referenceGradedBasis);
  });

  it("names the figure it actually used when it refuses a card", () => {
    // A ladder that cannot pay back even a modest basis.
    const result = computeGradeProfile(
      snapshot({ rawQsv: 140, rawMarketPrice: 9999, psa6: 30, psa7: 35, psa8: 40, psa9: 45, psa10: 50 }),
    );

    expect(result.eligible).toBe(false);
    // The rejection must quote the conservative figure, not the average it no
    // longer reads. A reason naming £9999 would send anyone reading it to
    // debug the wrong number.
    expect(result.ineligibleReason).toContain("140.00");
    expect(result.ineligibleReason).not.toContain("9999");
  });
});

/**
 * The floor and the confidence bar are separate rules and are deliberately
 * still read against the raw average, because they are about whether the
 * card is worth considering at all rather than about the economics of a
 * purchase. Pinned so the change above does not quietly move them too.
 */
describe("the other gates are untouched", () => {
  it("still refuses a card under the £5 grading floor", () => {
    const result = computeGradeProfile(snapshot({ rawMarketPrice: 3 }));

    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toContain("grading floor");
  });

  it("still refuses a card with no PSA 9 or PSA 10 evidence", () => {
    const result = computeGradeProfile(snapshot({ psa9: null, psa10: null }));

    expect(result.eligible).toBe(false);
    expect(result.ineligibleReason).toContain("PSA9/PSA10");
  });

  it("still reports the raw market value it was given, unchanged", () => {
    // The gate judges on QSV; it must not start REPORTING QSV as the card's
    // market value. Those are different claims and the dashboard shows this
    // one.
    expect(computeGradeProfile(snapshot({ rawMarketPrice: 200 })).rawMarketValue).toBe(200);
  });
});

/**
 * THE LINE THIS CHANGE MUST NOT CROSS. Judging at a conservative value is
 * not the same as assuming a bargain. A card whose slab ladder only works at
 * a fraction of what the card sells for is not an opportunity, it is a
 * fantasy, and it must still be refused.
 */
describe("it does not become a licence to assume a discount", () => {
  it("refuses a card that only pays if bought far below its sold value", () => {
    // Sells for £400 conservatively; the whole slab ladder tops out at £300.
    // No amount of conservatism makes that a trade at anything like £400.
    const result = computeGradeProfile(
      snapshot({ rawQsv: 400, rawMarketPrice: 420, psa6: 120, psa7: 150, psa8: 190, psa9: 240, psa10: 300 }),
    );

    expect(result.eligible).toBe(false);
  });
});
