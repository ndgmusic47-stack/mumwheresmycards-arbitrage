import { useState, type FormEvent } from "react";
import { interpretQuery, type InterpretedOpportunityFilters, type QueryInterpretation } from "../api/client";
import type { DashboardFilters } from "../state/filters";

/**
 * AI INTELLIGENCE spec Phase 2, Workstream L: a natural-language search
 * box that translates a typed sentence (e.g. "grade opportunities under
 * £200 with PSA10 profit over £150") into `DashboardFilters`' own fixed
 * field set (see `InterpretedOpportunityFilters`, and the worker-side
 * `AiQueryInterpreterProvider` this ultimately calls), then merges ONLY
 * the fields the AI actually returned onto whatever filters the user
 * already had — exactly as if they'd adjusted the matching slider/dropdown
 * by hand. Never applies anything silently: the plain-English restatement
 * (and any caveats) stays visible right under the input so the user can
 * see and correct what was understood, and "Clear" always dismisses the
 * result panel without needing to touch every control by hand — the
 * filters it already applied stay applied (same as any other filter
 * change) until the user changes them again.
 */
function mergeInterpretedFilters(base: DashboardFilters, interpreted: InterpretedOpportunityFilters): DashboardFilters {
  const defined = Object.fromEntries(Object.entries(interpreted).filter(([, value]) => value !== undefined));
  return { ...base, ...defined } as DashboardFilters;
}

export function NaturalLanguageQueryBox({
  filters,
  onChange,
}: {
  filters: DashboardFilters;
  onChange: (next: DashboardFilters) => void;
}) {
  const [queryText, setQueryText] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryInterpretation | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = queryText.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    try {
      const { interpretation } = await interpretQuery(trimmed);
      setResult(interpretation);
      if (interpretation.available && interpretation.filters) {
        onChange(mergeInterpretedFilters(filters, interpretation.filters));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Query interpretation failed.");
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setQueryText("");
    setResult(null);
    setError(null);
  }

  return (
    <div className="nl-query-box">
      <form onSubmit={handleSubmit} className="nl-query-form">
        <input
          type="text"
          value={queryText}
          onChange={(e) => setQueryText(e.target.value)}
          placeholder='Try "grade opportunities under £200 with PSA10 profit over £150"'
          aria-label="Describe the opportunities you're looking for, in plain English"
        />
        <button type="submit" disabled={loading || queryText.trim().length === 0}>
          {loading ? "Thinking…" : "Ask"}
        </button>
        {(result || error) && (
          <button type="button" onClick={handleClear} className="nl-query-clear">
            Dismiss
          </button>
        )}
      </form>

      {error && <p className="nl-query-caveat nl-query-error">{error}</p>}

      {result && !result.available && (
        <p className="nl-query-caveat">
          AI query interpretation isn't available right now — {result.caveats[0] ?? "unknown reason"}. Your filters were left
          unchanged; use the controls below instead.
        </p>
      )}

      {result && result.available && !result.filters && (
        <p className="nl-query-caveat">
          {result.explanation ?? "That didn't look like a request about filtering sourcing opportunities."} Your filters were
          left unchanged.
        </p>
      )}

      {result && result.available && result.filters && (
        <div className="nl-query-result">
          <p className="nl-query-explanation">
            <strong>Applied:</strong> {result.explanation}
          </p>
          {result.caveats.length > 0 && (
            <ul className="nl-query-caveats">
              {result.caveats.map((caveat, i) => (
                <li key={i}>{caveat}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
