export function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="badge badge-muted">—</span>;
  const tier = score >= 70 ? "high" : score >= 45 ? "mid" : "low";
  return (
    <span className={`badge badge-${tier}`} title="Ranking score only — it orders qualifying opportunities and never decides whether one qualifies.">
      {score.toFixed(0)}
    </span>
  );
}

export function StateBadge({ state }: { state: string }) {
  const label = state.replace(/_/g, " ");
  const tone = state.startsWith("REJECTED")
    ? "reject"
    : state === "QUALIFIED_FLIP" || state === "QUALIFIED_GRADE"
      ? "high"
      : state === "INSPECT_PHOTOS"
        ? "inspect"
        : state === "WATCH"
          ? "watch"
          : "muted";
  return <span className={`state-pill state-${tone}`}>{label}</span>;
}

/**
 * The economic structure of a grading trade, stated plainly. Never a vague
 * label like "good grading opportunity" — the class names mean specific,
 * checkable things, and the economics sit right beside them in the row.
 */
const CLASS_LABELS: Record<string, { label: string; tone: string; title: string }> = {
  DOWNSIDE_PROTECTED: {
    label: "DOWNSIDE PROTECTED",
    tone: "protected",
    title: "PSA 7 already breaks even — the floor is covered, and every grade above it is upside on a trade that doesn't lose.",
  },
  BALANCED: {
    label: "BALANCED",
    tone: "balanced",
    title: "PSA 8 is around break-even and PSA 9 makes real money — the realistic middle of the distribution pays.",
  },
  ASYMMETRIC: {
    label: "ASYMMETRIC",
    tone: "asymmetric",
    title: "Lower grades lose money, but the PSA 10 spread is exceptional. A discovery candidate, NOT a buy recommendation — check the required PSA 10 hit rate.",
  },
  UNCLASSIFIED: {
    label: "UNCLASSIFIED",
    tone: "muted",
    title: "Does not meet any defined economic opportunity structure.",
  },
};

export function EconomicClassBadge({ economicClass }: { economicClass: string | null }) {
  if (!economicClass) return <span className="badge badge-muted">—</span>;
  const meta = CLASS_LABELS[economicClass] ?? {
    label: economicClass.replace(/_/g, " "),
    tone: "muted",
    title: "",
  };
  return (
    <span className={`class-pill class-${meta.tone}`} title={meta.title}>
      {meta.label}
    </span>
  );
}
