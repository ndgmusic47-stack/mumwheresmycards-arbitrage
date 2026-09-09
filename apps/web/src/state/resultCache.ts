import type { OpportunityListItem, OpportunityQueryParams } from "../api/client";

/**
 * 2026-09-09: RESULTS CACHE — "I clicked into a card and coming back
 * reloaded the whole table."
 *
 * Filters, sort and position were already preserved. What was NOT preserved
 * was the DATA: every return trip re-ran the query, showed "Loading…", threw
 * the rows away and rebuilt them. Three costs, in increasing order of
 * annoyance:
 *
 *   1. A spinner between you and the row you were reading.
 *   2. The scroll restore has nothing to scroll until the rows repaint, so
 *      "put me back where I was" became a race it sometimes lost — which is
 *      why the position fix could look broken even though it worked.
 *   3. A pointless round trip. Nothing about the underlying data changed in
 *      the ninety seconds you spent reading one card.
 *
 * So a view already fetched is rendered from memory INSTANTLY — no spinner,
 * rows in the DOM on the first frame, position restored against real content
 * — and then quietly refetched in the background to pick up anything that
 * did change. Stale-while-revalidate, in other words.
 *
 * Deliberately module-level and in-memory: it must outlive the Dashboard
 * component (that is the entire point — the component unmounts when you open
 * a card) but must NOT outlive the browser tab, because a scan run every 30
 * minutes makes yesterday's rows genuinely wrong. A hard refresh clears it.
 *
 * Keyed by the EXACT query, so a filter change is a cache miss and fetches
 * properly rather than showing the previous filter's rows.
 */
export interface CachedResult {
  opportunities: OpportunityListItem[];
  total: number;
  pageCount: number;
}

export const RESULT_CACHE_LIMIT = 20;
export const resultCache = new Map<string, CachedResult>();

export function resultCacheKey(baseParams: Omit<OpportunityQueryParams, "page">, page: number): string {
  return JSON.stringify({ ...baseParams, page });
}

export function writeResultCache(key: string, value: CachedResult) {
  // Refresh insertion order so the LRU eviction below keeps what's in use.
  resultCache.delete(key);
  resultCache.set(key, value);
  while (resultCache.size > RESULT_CACHE_LIMIT) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}
