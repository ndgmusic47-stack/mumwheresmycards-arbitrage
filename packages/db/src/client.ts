// Thin typed wrapper over the D1 prepared-statement API. Kept intentionally
// minimal (no ORM) — the SQL in apps/worker/migrations is the schema source
// of truth. This just gives call sites typed rows instead of `any`.
//
// D1Database type comes from @cloudflare/workers-types in apps/worker; this
// package stays runtime-agnostic by accepting a structurally-compatible
// interface so it has no hard dependency on Workers types.

export interface D1Like {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1ResultLike<T>>;
  run(): Promise<D1ResultLike<unknown>>;
}

export interface D1ResultLike<T> {
  results?: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export class Db {
  constructor(private readonly d1: D1Like) {}

  async queryAll<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const stmt = params.length ? this.d1.prepare(sql).bind(...params) : this.d1.prepare(sql);
    const result = await stmt.all<T>();
    return result.results ?? [];
  }

  async queryFirst<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    const stmt = params.length ? this.d1.prepare(sql).bind(...params) : this.d1.prepare(sql);
    return stmt.first<T>();
  }

  async exec(sql: string, ...params: unknown[]): Promise<D1ResultLike<unknown>> {
    const stmt = params.length ? this.d1.prepare(sql).bind(...params) : this.d1.prepare(sql);
    return stmt.run();
  }

  async batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    return this.d1.batch<T>(statements);
  }

  prepare(sql: string): D1PreparedStatementLike {
    return this.d1.prepare(sql);
  }
}
