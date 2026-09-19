/**
 * WHAT HAPPENS WHEN THE RESULT SET SHRINKS UNDER YOU.
 *
 * Reported live on 2026-09-13: "20 matching listings · page 2 of 1", an empty
 * table reading "No opportunities match the current filters", and no way back
 * except editing the URL.
 *
 * The page number lives in the URL, which is right — a bookmark or a refresh
 * reproduces the view exactly. But the SIZE of the result set is not fixed.
 * It changes constantly and often sharply: passing rows removes them, a scan
 * re-qualifies half the feed, a newly deployed rule reclassifies thousands at
 * once. `setPage` clamps what you CLICK against the page count it knew at the
 * time; nothing clamped the page you were already standing on when the count
 * moved beneath you.
 *
 * The dead end was the real damage rather than the wrong number. The paging
 * bar hid itself entirely at a single page, so Previous disappeared at the
 * exact moment it was the only control that could have helped.
 *
 * Both rules live here, together and tested, because they are two halves of
 * one behaviour and getting either alone still strands somebody.
 */

/**
 * The page actually worth showing, given how many there turned out to be.
 *
 * Snapping to the LAST page rather than the first is deliberate: someone on
 * page 7 of a set that just shrank to 3 was working through it in order, and
 * page 3 is where they left off. Sending them back to page 1 would discard
 * that position for no reason.
 */
export function clampPage(page: number, pageCount: number): number {
  const pages = Math.max(1, Math.floor(pageCount) || 1);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.min(Math.floor(page), pages);
}

/** True when the current page is past the end and the view needs snapping. */
export function isPageOutOfRange(page: number, pageCount: number): boolean {
  return clampPage(page, pageCount) !== page;
}

/**
 * Whether the paging controls should be on screen at all.
 *
 * One page of results genuinely needs no paging bar. A page number past the
 * end needs one MORE than usual, because it is the only way out — so the bar
 * renders whenever the page is past the first, even if the count says there
 * is nothing to page through.
 */
export function shouldShowPagination(page: number, pageCount: number): boolean {
  return pageCount > 1 || page > 1;
}
