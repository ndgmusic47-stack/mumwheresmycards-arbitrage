import { round2, round4 } from "../calc/fees.js";

/**
 * QSV — QUICK SALE VALUE.
 *
 * QSV is a CONSERVATIVE EXECUTABLE SALE VALUE: what we could actually get
 * out of this card reasonably quickly. It is explicitly NOT an asking-price
 * estimate and NOT a headline "market value".
 *
 *     QSV = min(7-day sold median, 30-day sold median) * (1 - haircut)
 *
 * Two rules make this conservative on purpose:
 *
 * 1. SOLD MEDIANS ONLY. Active eBay asking prices NEVER influence QSV.
 *    Asking prices are what sellers hope for, including the ones that never
 *    sell; using them systematically overstates what we can realise. Only
 *    completed sold comps count.
 *
 * 2. LOWER OF TWO WINDOWS, THEN A HAIRCUT. Taking the lower of the 7-day
 *    and 30-day medians means a card that has just spiked doesn't get
 *    valued at the spike, and the quick-sale haircut reflects that
 *    liquidating promptly means pricing below the median, not at it.
 *
 * Medians, not averages: a single outlier sale (a graded card mis-listed as
 * raw, a bundle, a mis-priced auction) moves an average and barely moves a
 * median.
 *
 * When only one median exists we still produce a QSV but reduce confidence.
 * When neither exists we may fall back to a broader market reference, but
 * that result is NEVER labelled a high-confidence QSV — `isHighConfidenceQsv`
 * is false and the caller is expected to treat it accordingly.
 */

export interface QsvSettings {
  /** Quick-sale haircut applied to the lower median. 0.08 = 8%. */
  quickSaleHaircutPct: number;
  /** Confidence multiplier when only one of the two medians is available. */
  singleMedianConfidenceMultiplier: number;
  /** Hard ceiling on confidence when no sold median exists at all. */
  fallbackConfidenceCeiling: number;
}

export const DEFAULT_QSV_SETTINGS: QsvSettings = {
  quickSaleHaircutPct: 0.08,
  singleMedianConfidenceMultiplier: 0.75,
  fallbackConfidenceCeiling: 0.35,
};

export type QsvBasis =
  /** Both sold medians present — the intended, strongest case. */
  | "BOTH_SOLD_MEDIANS"
  | "SEVEN_DAY_SOLD_MEDIAN_ONLY"
  | "THIRTY_DAY_SOLD_MEDIAN_ONLY"
  /** No sold median available — a broader market reference was used instead. */
  | "FALLBACK_MARKET_REFERENCE"
  | "NO_DATA";

export interface QsvResult {
  qsv: number | null;
  basis: QsvBasis;
  /** The median actually used, before the haircut. */
  medianUsed: number | null;
  median7d: number | null;
  median30d: number | null;
  haircutPct: number;
  /** Confidence after any penalty for missing windows. */
  confidence: number;
  /**
   * TRUE only when QSV came from at least one real SOLD median. A fallback
   * reference is never high-confidence QSV, however plausible the number.
   */
  isHighConfidenceQsv: boolean;
  notes: string[];
}

export function computeQsv(
  input: {
    median7d: number | null;
    median30d: number | null;
    /** Broader market reference (e.g. provider average) — last resort only. */
    fallbackReference?: number | null;
    /** Provider's own confidence in its pricing for this card, 0..1. */
    baseConfidence: number;
  },
  settings: QsvSettings = DEFAULT_QSV_SETTINGS,
): QsvResult {
  const median7d = positiveOrNull(input.median7d);
  const median30d = positiveOrNull(input.median30d);
  const fallback = positiveOrNull(input.fallbackReference ?? null);
  const haircutPct = settings.quickSaleHaircutPct;
  const notes: string[] = [];

  const applyHaircut = (value: number): number => round2(value * (1 - haircutPct));

  if (median7d !== null && median30d !== null) {
    const medianUsed = Math.min(median7d, median30d);
    notes.push(
      `QSV from the lower of the 7-day (£${median7d}) and 30-day (£${median30d}) sold medians, less a ${(haircutPct * 100).toFixed(0)}% quick-sale haircut.`,
    );
    return {
      qsv: applyHaircut(medianUsed),
      basis: "BOTH_SOLD_MEDIANS",
      medianUsed,
      median7d,
      median30d,
      haircutPct,
      confidence: clamp01(input.baseConfidence),
      isHighConfidenceQsv: true,
      notes,
    };
  }

  const singleMedian = median7d ?? median30d;
  if (singleMedian !== null) {
    const which = median7d !== null ? "7-day" : "30-day";
    notes.push(
      `Only the ${which} sold median (£${singleMedian}) was available — QSV computed from it with reduced confidence.`,
    );
    return {
      qsv: applyHaircut(singleMedian),
      basis: median7d !== null ? "SEVEN_DAY_SOLD_MEDIAN_ONLY" : "THIRTY_DAY_SOLD_MEDIAN_ONLY",
      medianUsed: singleMedian,
      median7d,
      median30d,
      haircutPct,
      confidence: round4(clamp01(input.baseConfidence) * settings.singleMedianConfidenceMultiplier),
      isHighConfidenceQsv: true,
      notes,
    };
  }

  if (fallback !== null) {
    notes.push(
      `NO sold median available. Fell back to a broader market reference (£${fallback}) — this is NOT a high-confidence QSV and should not be treated as an executable sale value.`,
    );
    return {
      qsv: applyHaircut(fallback),
      basis: "FALLBACK_MARKET_REFERENCE",
      medianUsed: null,
      median7d,
      median30d,
      haircutPct,
      confidence: Math.min(clamp01(input.baseConfidence), settings.fallbackConfidenceCeiling),
      isHighConfidenceQsv: false,
      notes,
    };
  }

  notes.push("No sold medians and no market reference available — no QSV can be computed.");
  return {
    qsv: null,
    basis: "NO_DATA",
    medianUsed: null,
    median7d,
    median30d,
    haircutPct,
    confidence: 0,
    isHighConfidenceQsv: false,
    notes,
  };
}

function positiveOrNull(v: number | null | undefined): number | null {
  return v === null || v === undefined || !Number.isFinite(v) || v <= 0 ? null : v;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
