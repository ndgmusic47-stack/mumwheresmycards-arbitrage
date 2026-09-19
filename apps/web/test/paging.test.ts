import { describe, it, expect } from "vitest";
import { clampPage, isPageOutOfRange, shouldShowPagination } from "../src/state/paging";

/**
 * The live report this exists to prevent, verbatim:
 *
 *   "20 matching listings · page 2 of 1 ... No opportunities match the
 *    current filters."
 *
 * with no paging controls on screen at all.
 */
describe("the page you are standing on when the set shrinks", () => {
  it("snaps page 2 of a set that collapsed to one page", () => {
    expect(isPageOutOfRange(2, 1)).toBe(true);
    expect(clampPage(2, 1)).toBe(1);
  });

  it("keeps your place at the END of a shrunken set, not the start", () => {
    // Page 7 of a set that dropped to 3 pages: page 3 is where the work
    // stopped. Page 1 would throw away a position for no reason.
    expect(clampPage(7, 3)).toBe(3);
  });

  it("leaves a page that is still in range completely alone", () => {
    expect(isPageOutOfRange(2, 5)).toBe(false);
    expect(clampPage(2, 5)).toBe(2);
    expect(clampPage(5, 5)).toBe(5);
  });

  it("treats an empty result set as one page, never zero", () => {
    // The server already reports pageCount as max(1, ...) for no results;
    // this must agree rather than sending anyone to page 0.
    expect(clampPage(3, 0)).toBe(1);
    expect(clampPage(1, 0)).toBe(1);
  });

  it("refuses nonsense page numbers instead of propagating them", () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(-4, 5)).toBe(1);
    expect(clampPage(NaN, 5)).toBe(1);
    expect(clampPage(2.7, 5)).toBe(2);
  });
});

describe("the paging bar has to survive the moment it is needed most", () => {
  it("stays hidden on a genuine single page — there is nothing to page", () => {
    expect(shouldShowPagination(1, 1)).toBe(false);
  });

  it("shows on any real multi-page set", () => {
    expect(shouldShowPagination(1, 2)).toBe(true);
    expect(shouldShowPagination(2, 2)).toBe(true);
  });

  it("SHOWS when stranded past the end, which is the whole point", () => {
    // This is the exact state that was reported: page 2, one page of
    // results, an empty table. Hiding the bar here removed the only way
    // back and left editing the URL as the only escape.
    expect(shouldShowPagination(2, 1)).toBe(true);
    expect(shouldShowPagination(7, 1)).toBe(true);
  });
});
