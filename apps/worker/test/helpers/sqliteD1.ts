import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { D1Like, D1PreparedStatementLike, D1ResultLike } from "@mwmc/db";

/**
 * A REAL SQLite database behind the D1 interface, with the repo's actual
 * migrations applied.
 *
 * Every other persistence test in this suite uses a fake D1 that records the
 * SQL it was handed. That is the right tool for pinning down a guarantee that
 * lives in a WHERE clause — but it can only ever prove what the code MEANT to
 * ask. It cannot catch a column that does not exist, a NOT NULL that is never
 * satisfied, a UNIQUE index that does not actually fire, or a route that
 * writes a row no migration ever created.
 *
 * D1 is SQLite, so those are exactly the failures this harness can catch,
 * and they are the ones that only show up in production otherwise. `node:sqlite`
 * is used rather than Miniflare because it is already in the runtime and adds
 * no dependency.
 *
 * WHAT THIS IS NOT: it is not Cloudflare. It does not reproduce D1's network
 * behaviour, its request limits, its `meta` fields beyond `changes`, or its
 * batch semantics. A test passing here is evidence the SQL and schema agree,
 * not that the deployed Worker behaves identically.
 */

/**
 * `node:sqlite` is loaded through createRequire rather than a static import:
 * Vite's dependency scanner resolves the bare specifier `sqlite` and fails,
 * because this is a Node built-in with no package behind it. A runtime
 * require keeps it out of the module graph without needing build config.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => DatabaseSyncLike;
};

/** The slice of node:sqlite's API this harness uses. */
export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: (null | number | bigint | string | Uint8Array)[]): unknown;
    all(...params: (null | number | bigint | string | Uint8Array)[]): unknown[];
    run(...params: (null | number | bigint | string | Uint8Array)[]): { changes: number | bigint };
  };
  close(): void;
}

/*
 * `fileURLToPath`, NOT `.pathname`.
 *
 * This was `new URL("../../migrations/", import.meta.url).pathname`, which is
 * correct on POSIX and BROKEN ON WINDOWS: there the URL is
 * `file:///C:/Users/...` and `.pathname` hands back `/C:/Users/...` with a
 * leading slash, which readdirSync cannot open. It failed with a path
 * missing its drive letter and took 30 tests with it — every test in this
 * suite that touches a real database.
 *
 * It passed CI-style checks on Linux and failed on the only machine that
 * matters, which is the whole lesson: `fileURLToPath` is the only correct
 * way to turn a file URL into a native path.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/**
 * Statement splitter. Deliberately tracks single quotes: several migrations
 * contain semicolons inside string literals (CHECK constraints listing
 * statuses, default JSON payloads), and a naive `split(";")` corrupts them
 * into unparseable fragments.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      current += char;
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (!inString && char === "-" && next === "-") {
      inLineComment = true;
      current += char;
      continue;
    }
    if (char === "'") {
      inString = !inString;
      current += char;
      continue;
    }
    if (char === ";" && !inString) {
      statements.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) statements.push(current);

  // Drop fragments that are only comments and blank lines. Done line by line
  // rather than with a nested-quantifier regex, which backtracks
  // catastrophically on the long comment blocks these migrations carry.
  const isExecutable = (statement: string) =>
    statement.split("\n").some((line) => {
      const trimmed = line.trim();
      return trimmed.length > 0 && !trimmed.startsWith("--");
    });

  return statements.map((s) => s.trim()).filter((s) => s.length > 0 && isExecutable(s));
}

export interface SqliteHarness {
  d1: D1Like;
  raw: DatabaseSyncLike;
  migrationsApplied: string[];
  close(): void;
}

/** Opens an in-memory database with every migration applied in order. */
export function createSqliteD1(): SqliteHarness {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    for (const statement of splitStatements(sql)) {
      try {
        raw.exec(statement);
      } catch (err) {
        throw new Error(`Migration ${file} failed on:\n${statement}\n\n${String(err)}`);
      }
    }
  }

  const d1: D1Like = {
    prepare(query: string): D1PreparedStatementLike {
      let params: unknown[] = [];
      const normalise = (values: unknown[]) =>
        values.map((v) => {
          if (v === undefined) return null;
          if (typeof v === "boolean") return v ? 1 : 0;
          return v as null | number | bigint | string | Uint8Array;
        });

      const self: D1PreparedStatementLike = {
        bind(...values: unknown[]) {
          params = values;
          return self;
        },
        async first<T>(colName?: string) {
          const row = raw.prepare(query).get(...normalise(params)) as Record<string, unknown> | undefined;
          if (row === undefined) return null as T | null;
          return (colName ? (row[colName] as T) : (row as T)) ?? (null as T | null);
        },
        async all<T>() {
          const rows = raw.prepare(query).all(...normalise(params)) as T[];
          return { results: rows, success: true, meta: {} } satisfies D1ResultLike<T>;
        },
        async run() {
          const result = raw.prepare(query).run(...normalise(params));
          // `changes` is the one meta field this codebase reads (see
          // dealsRepo.resolveOffer), so it is reported faithfully.
          return { success: true, meta: { changes: Number(result.changes) } } satisfies D1ResultLike<unknown>;
        },
      };
      return self;
    },
    async batch<T>(statements: D1PreparedStatementLike[]) {
      const results: D1ResultLike<T>[] = [];
      for (const statement of statements) results.push((await statement.run()) as D1ResultLike<T>);
      return results;
    },
  };

  return { d1, raw, migrationsApplied: files, close: () => raw.close() };
}

/**
 * Minimal referential scaffolding: a card, an eBay listing and an
 * opportunity, so a deal has something real to hang off. Foreign keys are ON,
 * so this is not optional — which is itself part of what the harness proves.
 */
export function seedOpportunity(
  raw: DatabaseSyncLike,
  ids: { cardId: string; listingId: string; opportunityId: string; strategy?: string },
): void {
  const columns = (table: string) =>
    (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: unknown; pk: number }[]);

  const required = (table: string) =>
    columns(table).filter((c) => c.notnull === 1 && c.dflt_value === null);

  const fill = (table: string, values: Record<string, unknown>) => {
    const known = new Set(columns(table).map((c) => c.name));
    // Only keep keys the table actually has, so this helper does not have to
    // track schema drift across 24 migrations to stay usable.
    const row: Record<string, unknown> = Object.fromEntries(
      Object.entries(values).filter(([key]) => known.has(key)),
    );
    for (const col of required(table)) {
      if (!(col.name in row)) {
        // A required column this seed does not care about gets a harmless
        // placeholder, chosen by declared type so the insert is valid.
        const declared = columns(table).find((c) => c.name === col.name)!;
        row[col.name] = /INT|REAL|NUM/i.test(String((declared as unknown as { type: string }).type)) ? 0 : "seed";
      }
    }
    const keys = Object.keys(row);
    raw
      .prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...(keys.map((k) => row[k]) as (null | number | string)[]));
  };

  fill("cards", { id: ids.cardId, name: "Charizard", set_name: "Base Set", number: "4", variant: "holo" });
  fill("ebay_listings", { id: ids.listingId, card_id: ids.cardId, title: "Charizard Base Set holo", price: 40 });
  fill("opportunities", {
    id: ids.opportunityId,
    card_id: ids.cardId,
    listing_id: ids.listingId,
    strategy: ids.strategy ?? "GRADE",
  });
}
