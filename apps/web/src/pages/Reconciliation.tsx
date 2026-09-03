import { useEffect, useState } from "react";
import { fetchReconciliation } from "../api/client";
import type { ReconciliationRecord, ReconciliationSummary, FinancialAudit } from "../api/client";

const currency = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

/**
 * AI INTELLIGENCE spec Phase 2, Workstream N: the realised-vs-predicted
 * reconciliation page. Every number here comes back from the worker's own
 * deterministic engine (`compareForecastVsRealised`/
 * `summarizeForecastVariance`, `@mwmc/core`) — this page never computes
 * economics itself. The AI financial auditor's narrative is fetched
 * on-demand only (same discipline as `AiAdvisoryPanel`/`ScenarioPanel`'s
 * "Ask AI" checkbox) since it costs real money; the deterministic table and
 * summary load unconditionally and for free.
 */
export function Reconciliation() {
  const [records, setRecords] = useState<ReconciliationRecord[] | null>(null);
  const [summary, setSummary] = useState<ReconciliationSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [auditState, setAuditState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "loaded"; audit: FinancialAudit }
  >({ status: "idle" });

  useEffect(() => {
    fetchReconciliation()
      .then((r) => {
        setRecords(r.records);
        setSummary(r.summary);
      })
      .catch((err) => setError(String(err)));
  }, []);

  async function runAudit() {
    setAuditState({ status: "loading" });
    try {
      const r = await fetchReconciliation({ audit: true });
      if (r.audit) setAuditState({ status: "loaded", audit: r.audit });
      else setAuditState({ status: "error", message: "No audit was returned." });
    } catch (err) {
      setAuditState({ status: "error", message: String(err) });
    }
  }

  if (error) return <p className="error-banner">{error}</p>;

  return (
    <div>
      <div className="page-header">
        <h1>Reconciliation</h1>
      </div>
      <p className="result-count">
        Realised performance on completed (sold) trades, compared against the forecast frozen at purchase — never a
        forecast recomputed with hindsight. A trade added without a linked opportunity has nothing to compare against
        and is shown as realised-only.
      </p>

      {records === null || summary === null ? (
        <p className="empty-state">Loading…</p>
      ) : records.length === 0 ? (
        <p className="empty-state">No completed trades recorded yet.</p>
      ) : (
        <>
          <section className="panel">
            <h2>Summary</h2>
            <table className="ladder-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Sample</th>
                  <th>Outperformed</th>
                  <th>Mean profit variance</th>
                  <th>Median profit variance</th>
                  <th>Mean ROC variance</th>
                </tr>
              </thead>
              <tbody>
                <SummaryRow label="Overall" summary={summary.overall} />
                <SummaryRow label="FLIP" summary={summary.flip} />
                <SummaryRow label="GRADE" summary={summary.grade} />
              </tbody>
            </table>
          </section>

          <section className="panel">
            <h2>AI financial auditor</h2>
            {auditState.status === "idle" && (
              <>
                <p className="result-count">Optional, on-demand only — nothing is fetched until you ask.</p>
                <button onClick={runAudit}>Run AI audit</button>
              </>
            )}
            {auditState.status === "loading" && <p className="empty-state">Auditing…</p>}
            {auditState.status === "error" && <p className="error-banner">{auditState.message}</p>}
            {auditState.status === "loaded" && (
              <>
                {auditState.audit.available ? (
                  <p>{auditState.audit.summary}</p>
                ) : (
                  <p className="hint-tag">AI audit unavailable right now — see below for why.</p>
                )}
                {auditState.audit.caveats.map((c, i) => (
                  <p key={i} className="result-count">
                    {c}
                  </p>
                ))}
              </>
            )}
          </section>

          <section className="panel">
            <h2>Trades</h2>
            <table className="opp-table">
              <thead>
                <tr>
                  <th>Card</th>
                  <th>Strategy</th>
                  <th>Sold</th>
                  <th>Forecast profit</th>
                  <th>Real profit</th>
                  <th>Variance</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.inventoryId}>
                    <td>
                      {r.cardName}
                      {r.strategy === "GRADE" && r.actualGrade !== null && ` (PSA ${r.actualGrade})`}
                    </td>
                    <td>{r.strategy}</td>
                    <td>{new Date(r.soldAt).toLocaleDateString()}</td>
                    <td>{r.hasForecast && r.forecastNetProfit !== null ? currency.format(r.forecastNetProfit) : "no forecast"}</td>
                    <td>{currency.format(r.realNetProfit)}</td>
                    <td className={varianceClass(r.profitVariance)}>
                      {r.profitVariance !== null ? `${r.profitVariance >= 0 ? "+" : ""}${currency.format(r.profitVariance)}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function varianceClass(variance: number | null): string {
  if (variance === null) return "";
  return variance >= 0 ? "profit-positive" : "profit-negative";
}

function SummaryRow({ label, summary }: { label: string; summary: ReconciliationSummary["overall"] }) {
  if (summary.sampleSize === 0) {
    return (
      <tr>
        <td>{label}</td>
        <td colSpan={5}>No realised trades with a forecast yet.</td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{label}</td>
      <td>{summary.sampleSize}</td>
      <td>
        {summary.outperformedCount}/{summary.sampleSize}
        {summary.outperformedRate !== null && ` (${(summary.outperformedRate * 100).toFixed(0)}%)`}
      </td>
      <td className={varianceClass(summary.meanProfitVariance)}>
        {summary.meanProfitVariance !== null
          ? `${summary.meanProfitVariance >= 0 ? "+" : ""}${currency.format(summary.meanProfitVariance)}`
          : "—"}
      </td>
      <td className={varianceClass(summary.medianProfitVariance)}>
        {summary.medianProfitVariance !== null
          ? `${summary.medianProfitVariance >= 0 ? "+" : ""}${currency.format(summary.medianProfitVariance)}`
          : "—"}
      </td>
      <td>{summary.meanRocVariance !== null ? `${(summary.meanRocVariance * 100).toFixed(0)}pp` : "—"}</td>
    </tr>
  );
}
