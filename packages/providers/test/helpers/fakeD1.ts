import type { D1Like, D1PreparedStatementLike, D1ResultLike } from "@mwmc/db";

/**
 * Minimal in-memory D1 test double. Does NOT implement general SQL — it
 * recognizes the small set of statement shapes this codebase actually
 * issues (by SQL prefix) and stores rows in a plain array. Good enough to
 * unit test cache/persistence logic without spinning up Miniflare.
 */
export class FakeD1 implements D1Like {
  public marketSnapshots: Record<string, unknown>[] = [];
  public apiUsage: Record<string, unknown>[] = [];

  prepare(query: string): D1PreparedStatementLike {
    return new FakeStatement(query, this);
  }

  async batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const results: D1ResultLike<T>[] = [];
    for (const s of statements) results.push((await s.run()) as D1ResultLike<T>);
    return results;
  }
}

class FakeStatement implements D1PreparedStatementLike {
  private params: unknown[] = [];

  constructor(private readonly sql: string, private readonly db: FakeD1) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.params = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    const result = await this.all<T>();
    return result.results?.[0] ?? null;
  }

  async all<T = unknown>(): Promise<D1ResultLike<T>> {
    const sql = this.sql.trim().toUpperCase();

    if (sql.startsWith("SELECT * FROM MARKET_SNAPSHOTS")) {
      const cardId = this.params[0];
      const rows = this.db.marketSnapshots
        .filter((r) => r.card_id === cardId)
        .sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)));
      return { results: rows as T[], success: true, meta: {} };
    }

    return { results: [], success: true, meta: {} };
  }

  async run(): Promise<D1ResultLike<unknown>> {
    const sql = this.sql.trim().toUpperCase();

    if (sql.startsWith("INSERT INTO MARKET_SNAPSHOTS")) {
      const [
        card_id,
        source_provider,
        price_timestamp,
        raw_market_price,
        raw_qsv,
        psa7,
        psa8,
        psa9,
        psa10,
        confidence,
        liquidity,
        sample_size,
        psa_population_7,
        psa_population_8,
        psa_population_9,
        psa_population_10,
        historical_gem_rate,
        outliers_excluded,
        raw_payload,
      ] = this.params;

      this.db.marketSnapshots.push({
        id: this.db.marketSnapshots.length + 1,
        card_id,
        source_provider,
        captured_at: new Date().toISOString(),
        price_timestamp,
        raw_market_price,
        raw_qsv,
        psa7,
        psa8,
        psa9,
        psa10,
        confidence,
        liquidity,
        sample_size,
        psa_population_7,
        psa_population_8,
        psa_population_9,
        psa_population_10,
        historical_gem_rate,
        outliers_excluded,
        raw_payload,
      });
      return { success: true, meta: {} };
    }

    if (sql.startsWith("INSERT INTO API_USAGE")) {
      const [provider, endpoint, scan_run_id, cache_hit, cost_weight] = this.params;
      this.db.apiUsage.push({ provider, endpoint, scan_run_id, cache_hit, cost_weight, called_at: new Date().toISOString() });
      return { success: true, meta: {} };
    }

    return { success: true, meta: {} };
  }
}
