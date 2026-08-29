import { useEffect, useState } from "react";
import { fetchInventory } from "../api/client";

const STAGES = ["PURCHASED", "AWAITING_GRADING", "GRADED", "LISTED", "SOLD"] as const;

export function Pipeline() {
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    fetchInventory().then((r) => setRows(r.inventory));
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>Pipeline</h1>
      </div>
      <p className="result-count">Cards moving through purchase → grading → listing → sale, grouped by stage.</p>
      <div className="pipeline-columns">
        {STAGES.map((stage) => (
          <div key={stage} className="pipeline-column">
            <h3>{stage.replace(/_/g, " ")}</h3>
            {rows
              .filter((r) => r.status === stage)
              .map((r) => (
                <div key={r.id} className="pipeline-card">
                  {r.strategy} · £{r.actual_total_acquisition_cost}
                </div>
              ))}
            {rows.filter((r) => r.status === stage).length === 0 && <p className="empty-state small">Empty</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
