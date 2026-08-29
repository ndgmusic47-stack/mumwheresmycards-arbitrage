export function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="badge badge-muted">—</span>;
  const tier = score >= 70 ? "high" : score >= 45 ? "mid" : "low";
  return <span className={`badge badge-${tier}`}>{score.toFixed(0)}</span>;
}

export function StateBadge({ state }: { state: string }) {
  const label = state.replace(/_/g, " ");
  const tone = state.startsWith("REJECTED")
    ? "reject"
    : state === "HIGH_CONFIDENCE_FLIP" || state === "GRADE_CANDIDATE"
      ? "high"
      : state === "INSPECT_PHOTOS"
        ? "inspect"
        : state === "WATCH"
          ? "watch"
          : "muted";
  return <span className={`state-pill state-${tone}`}>{label}</span>;
}
