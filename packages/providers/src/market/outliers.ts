/**
 * IQR-based outlier trimming for raw comp/sold-price arrays. Used by market
 * provider adapters BEFORE a snapshot is persisted, so a single wildly
 * over/under priced sold listing (mis-titled, damaged, mis-graded-cert,
 * bundle sale, etc.) never distorts `rawMarketPrice`/`rawQsv`/PSA prices.
 *
 * See ARCHITECTURE.md section 4 — active eBay asking prices are excluded
 * from valuation entirely; this handles outliers *within* the sold-comp
 * data that IS used for valuation.
 */
export interface OutlierTrimResult {
  trimmed: number[];
  excluded: number[];
  excludedCount: number;
}

export function trimOutliersIQR(values: number[], k = 1.5): OutlierTrimResult {
  if (values.length < 4) {
    // Too few samples for a meaningful quartile split — trust the data as-is
    // rather than risk discarding a legitimate comp from a thin market.
    return { trimmed: [...values], excluded: [], excludedCount: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerBound = q1 - k * iqr;
  const upperBound = q3 + k * iqr;

  const trimmed: number[] = [];
  const excluded: number[] = [];

  for (const v of values) {
    if (v < lowerBound || v > upperBound) {
      excluded.push(v);
    } else {
      trimmed.push(v);
    }
  }

  // Safety net: never trim away everything (e.g. degenerate all-identical-
  // except-one-outlier arrays where IQR collapses to 0) — fall back to the
  // untrimmed set rather than return an empty market signal.
  if (trimmed.length === 0) {
    return { trimmed: [...values], excluded: [], excludedCount: 0 };
  }

  return { trimmed, excluded, excludedCount: excluded.length };
}

function quantile(sortedValues: number[], q: number): number {
  const pos = (sortedValues.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const baseValue = sortedValues[base] ?? 0;
  const nextValue = sortedValues[base + 1];
  if (nextValue !== undefined) {
    return baseValue + rest * (nextValue - baseValue);
  }
  return baseValue;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}
