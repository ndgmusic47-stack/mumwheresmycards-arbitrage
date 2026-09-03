import { describe, expect, it } from "vitest";
import { NullAiAdvisoryProvider, type AiAdvisoryRequest } from "../src/advisory/AiAdvisoryProvider.js";

const SAMPLE_REQUEST: AiAdvisoryRequest = {
  opportunityId: "opp-1",
  cardName: "Charizard ex 199/197",
  strategy: "FLIP",
  listingTitle: "Charizard ex 199/197 PSA 10",
  listingPrice: 120,
  totalAcquisitionCost: 135,
  reasoning: ["QSV covers acquisition cost with margin to spare"],
};

describe("NullAiAdvisoryProvider (SOURCING WORKFLOW item 15)", () => {
  it("reports itself as unavailable, never fabricating a summary", async () => {
    const provider = new NullAiAdvisoryProvider();
    const result = await provider.getAdvisory(SAMPLE_REQUEST);
    expect(result.available).toBe(false);
    expect(result.summary).toBeNull();
  });

  it("explains why via a caveat rather than failing silently", async () => {
    const provider = new NullAiAdvisoryProvider();
    const result = await provider.getAdvisory(SAMPLE_REQUEST);
    expect(result.caveats.length).toBeGreaterThan(0);
    expect(result.caveats[0]).toMatch(/not connected/i);
  });

  it("is deterministic and stateless — identical output regardless of input", async () => {
    const provider = new NullAiAdvisoryProvider();
    const first = await provider.getAdvisory(SAMPLE_REQUEST);
    const second = await provider.getAdvisory({ ...SAMPLE_REQUEST, opportunityId: "opp-2", strategy: "GRADE" });
    expect(first).toEqual(second);
  });

  it("exposes a stable provider name for future logging/telemetry", () => {
    const provider = new NullAiAdvisoryProvider();
    expect(provider.name).toBe("none");
  });
});
