/**
 * Normalizes seller feedback into a 0..1 "listing quality" signal used by
 * the FLIP SCORE. v1 heuristic: blends feedback score (volume/track record)
 * and feedback percentage (satisfaction rate), 50/50.
 */
export function listingQualityFromSeller(feedbackScore?: number, feedbackPct?: number): number {
  const scoreNorm = feedbackScore !== undefined ? Math.min(1, feedbackScore / 1000) : 0.3; // unknown seller -> mediocre default
  // Feedback % below 90 is treated as poor (0), 90-100 scaled to 0..1.
  const pctNorm = feedbackPct !== undefined ? Math.max(0, Math.min(1, (feedbackPct - 90) / 10)) : 0.3;
  return Math.round((scoreNorm * 0.5 + pctNorm * 0.5) * 100) / 100;
}
