import { describe, it, expect } from "vitest";
import {
  FEED_HIDDEN_REVIEW_STATUSES,
  PIPELINE_REVIEW_STATUSES,
  leavesTheFeed,
} from "../src/state/pipelineStages";
import { buildServerFilterParams, DEFAULT_DASHBOARD_FILTERS } from "../src/state/filters";

/**
 * THE BUG, reported 2026-09-14: "when I moved the card along to under offer
 * stage I see it pop up again in the scan as an option."
 *
 * The feed excluded PASS and nothing else, so a card being actively
 * negotiated — or already bought — kept offering itself as a fresh lead.
 * On a card you have made an offer on, acting twice means bidding against
 * yourself.
 */
describe("a lead that has been acted on does not come back", () => {
  it("hides every stage the board owns, plus the ones dismissed", () => {
    expect(FEED_HIDDEN_REVIEW_STATUSES).toEqual(["INTERESTED", "UNDER_OFFER", "BOUGHT", "PASS"]);
  });

  it.each(["INTERESTED", "UNDER_OFFER", "BOUGHT", "PASS"] as const)("%s leaves the feed", (status) => {
    expect(leavesTheFeed(status)).toBe(true);
  });

  it("sends all of them to the server, not just PASS", () => {
    const params = buildServerFilterParams(DEFAULT_DASHBOARD_FILTERS);
    expect(params.excludeReviewStatus).toBe("INTERESTED,UNDER_OFFER,BOUGHT,PASS");
  });

  /**
   * CHECKED means "I have looked at this", not "I have decided something".
   * There is no board column for it, so it stays in the feed awaiting a real
   * decision — hiding it would lose the card with nowhere to find it again.
   */
  it("keeps a merely-looked-at card in the feed", () => {
    expect(leavesTheFeed("CHECKED")).toBe(false);
    expect(leavesTheFeed("UNREVIEWED")).toBe(false);
    expect(FEED_HIDDEN_REVIEW_STATUSES).not.toContain("CHECKED");
  });
});

/**
 * The two lists were written independently and each was half right, which is
 * how UNDER_OFFER came to be on the board and still in the feed. They are now
 * derived from one another and this holds that line.
 */
describe("the board and the feed cannot disagree", () => {
  it("hides everything the board shows", () => {
    for (const status of PIPELINE_REVIEW_STATUSES) {
      expect(FEED_HIDDEN_REVIEW_STATUSES).toContain(status);
      expect(leavesTheFeed(status)).toBe(true);
    }
  });

  it("adds exactly one thing the board does not show — the dismissed pile", () => {
    const extra = FEED_HIDDEN_REVIEW_STATUSES.filter((s) => !PIPELINE_REVIEW_STATUSES.includes(s));
    expect(extra).toEqual(["PASS"]);
  });
});
