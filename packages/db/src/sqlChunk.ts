/**
 * D1 (like SQLite) caps the number of bound parameters a single prepared
 * statement can carry. This app hit that cap for real in production use
 * (2026-09-03): `getAlreadyEnrichedListingIds` in apps/worker's
 * listingsRepo.ts failed live with `SQLITE_ERROR: too many SQL variables`
 * once a single scan run accumulated enough qualified candidates — an
 * `IN (?,?,?...)` clause built from one placeholder per element in an
 * unbounded runtime array is inherently unsafe as that array grows, and
 * this codebase has several such call sites (enrichment lookups, auction
 * expiry, stored market-snapshot hydration), each of which can plausibly
 * grow past a few hundred ids in normal use.
 *
 * This is the one shared place that safe batch size and chunking logic
 * live, so every `IN (...)` call site built from a runtime-sized array
 * uses the same conservative limit rather than each guessing its own (or,
 * as happened here, not guarding at all). MAX_SQL_IN_CLAUSE_SIZE is
 * deliberately well under D1's own actual ceiling rather than tuned to
 * the exact number, since that ceiling isn't part of any stable public
 * contract this app should depend on.
 */
export const MAX_SQL_IN_CLAUSE_SIZE = 100;

/** Splits `items` into chunks no larger than `size` (default
 *  MAX_SQL_IN_CLAUSE_SIZE), preserving order, for building one `IN (...)`
 *  query per chunk. Returns an empty array for an empty input — callers
 *  should treat that as "nothing to query", not iterate a chunk of zero
 *  placeholders. */
export function chunkForSqlIn<T>(items: readonly T[], size: number = MAX_SQL_IN_CLAUSE_SIZE): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
