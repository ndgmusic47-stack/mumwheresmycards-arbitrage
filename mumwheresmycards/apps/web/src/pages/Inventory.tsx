import { useEffect, useState } from "react";
import { fetchInventory } from "../api/client";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

export function Inventory() {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchInventory()
      .then((r) => setRows(r.inventory))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="page-header">
        <h1>Inventory</h1>
      </div>
      {loading ? (
        <p className="empty-state">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty-state">
          Nothing purchased yet — inventory rows are created from an opportunity via POST /api/inventory once you act on it.
        </p>
      ) : (
        <div className="table-scroll">
          <table className="opp-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Strategy</th>
                <th>Actual acquisition cost</th>
                <th>Purchased</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.status}</td>
                  <td>{r.strategy}</td>
                  <td>{currency.format(r.actual_total_acquisition_cost)}</td>
                  <td>{new Date(r.purchased_at).toLocaleDateString()}</td>
                  <td>{r.notes ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
