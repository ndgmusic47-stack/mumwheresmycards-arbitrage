import { useEffect, useState } from "react";

export function Watchlist() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/trade/api/watchlist")
      .then((r) => r.json())
      .then((r) => setRows(r.watchlist ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>Grading Watchlist</h1>
      </div>
      <p className="result-count">
        Seed research list — imported via <code>scripts/import-watchlist.ts</code>, never hardcoded into the opportunity engine.
      </p>
      {loading ? (
        <p className="empty-state">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty-state">No watchlist entries yet. Run the seed import to load your researched cards.</p>
      ) : (
        <ul className="reasoning-list">
          {rows.map((r) => (
            <li key={r.id}>
              <strong>{r.label}</strong> — {r.strategy} (priority {r.priority})
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
