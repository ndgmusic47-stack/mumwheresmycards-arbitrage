import { describe, expect, it } from "vitest";
import { computeMaxBid } from "../src/calc/maxBid.js";

describe("computeMaxBid", () => {
  it("returns null everywhere when there is no usable sale-side reference", () => {
    const result = computeMaxBid({
      expectedNetSaleProceeds: null,
      totalAcquisitionCost: 50,
      listingPrice: 45,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    expect(result.maxBid).toBeNull();
    expect(result.maxDeliveredCost).toBeNull();
    expect(result.headroomVsCurrentPrice).toBeNull();
    // nonBidCost is still a real, always-computable number (postage/tax/fees
    // are known even when the sale side isn't).
    expect(result.nonBidCost).toBe(5);
  });

  it("matches flipProfile.ts's own derivation: min of the profit floor and the ROC floor", () => {
    // netProceeds=200, minNetProfit=40 => capFromProfit=160
    // netProceeds=200, minROC=0.4 => capFromRoc = 200/1.4 = 142.857... => 142.86
    // ROC floor binds here.
    const result = computeMaxBid({
      expectedNetSaleProceeds: 200,
      totalAcquisitionCost: 100, // current bid 90 + £10 non-bid cost
      listingPrice: 90,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    expect(result.nonBidCost).toBe(10);
    expect(result.maxDeliveredCost).toBe(142.86);
    expect(result.maxBid).toBe(132.86); // 142.86 - 10
    expect(result.headroomVsCurrentPrice).toBe(42.86); // 132.86 - 90 — real room to bid higher
  });

  it("lets the absolute profit floor bind instead of ROC when it's the tighter constraint", () => {
    // netProceeds=60, minNetProfit=40 => capFromProfit=20
    // netProceeds=60, minROC=0.4 => capFromRoc=60/1.4=42.857 => 42.86
    // Profit floor binds here (20 < 42.86).
    const result = computeMaxBid({
      expectedNetSaleProceeds: 60,
      totalAcquisitionCost: 30,
      listingPrice: 25,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    expect(result.maxDeliveredCost).toBe(20);
    expect(result.maxBid).toBe(15); // 20 - 5 non-bid cost
  });

  it("floors at zero rather than going negative when even £0 wouldn't qualify", () => {
    const result = computeMaxBid({
      expectedNetSaleProceeds: 10,
      totalAcquisitionCost: 30,
      listingPrice: 25,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    expect(result.maxDeliveredCost).toBe(0);
    expect(result.maxBid).toBe(0);
    expect(result.headroomVsCurrentPrice).toBe(-25); // current price already well past qualifying
  });

  it("reports negative headroom, never a fabricated positive one, when the current price already exceeds max bid", () => {
    const result = computeMaxBid({
      expectedNetSaleProceeds: 60,
      totalAcquisitionCost: 55,
      listingPrice: 50, // already above where £20 delivered ceiling - £5 non-bid = £15 max bid would allow
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    expect(result.maxBid).toBe(15);
    expect(result.headroomVsCurrentPrice).toBe(-35);
  });

  it("handles zero non-bid cost (no postage captured) without distorting the result", () => {
    const result = computeMaxBid({
      expectedNetSaleProceeds: 200,
      totalAcquisitionCost: 90, // no postage/tax/fees captured for this listing
      listingPrice: 90,
      minNetProfit: 40,
      minReturnOnCapital: 0.4,
    });
    expect(result.nonBidCost).toBe(0);
    expect(result.maxBid).toBe(result.maxDeliveredCost);
  });
});
