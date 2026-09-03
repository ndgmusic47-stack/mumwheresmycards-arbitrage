/**
 * SOURCING WORKFLOW item 12 (same-card grouping without over-suppression):
 * a manual sourcer scanning the opportunity table sees one row per LISTING,
 * not per card — the same physical printing routinely shows up two or
 * three times (different sellers, different prices) and reads as
 * unrelated repeats of "Charizard — Base Set #4" rather than what it is:
 * several ways to buy the same card, worth comparing side by side.
 *
 * This groups rows by an already-sorted list's own key, PURELY for
 * display — it never drops or reorders a row. `primary` is whichever row
 * came first for that key (i.e. whatever the caller's own sort/rank
 * already decided was best), `others` holds every remaining row for that
 * key in the same relative order they arrived in. Every row the caller
 * passed in is present in exactly one group, in `primary` or `others` —
 * "without over-suppression" means literally that: nothing is ever
 * filtered out here, this only changes how rows are grouped for rendering.
 */
export interface GroupedRows<T> {
  key: string;
  primary: T;
  others: T[];
}

export function groupRowsByKey<T>(rows: T[], keyOf: (row: T) => string): GroupedRows<T>[] {
  const groups = new Map<string, GroupedRows<T>>();
  const order: string[] = [];

  for (const row of rows) {
    const key = keyOf(row);
    const existing = groups.get(key);
    if (existing) {
      existing.others.push(row);
    } else {
      groups.set(key, { key, primary: row, others: [] });
      order.push(key);
    }
  }

  return order.map((key) => groups.get(key)!);
}
