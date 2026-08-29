#!/usr/bin/env node
/**
 * Generates a SQL file to seed `watchlist_cards` from a JSON list, so the
 * ~31 researched grading-arbitrage cards can be imported without ever
 * being hardcoded into engine business logic (see ARCHITECTURE.md).
 *
 * Usage:
 *   npx tsx scripts/import-watchlist.ts seed/watchlist.json > seed/watchlist.generated.sql
 *   wrangler d1 execute mwmc-db --local --file=seed/watchlist.generated.sql
 *   wrangler d1 execute mwmc-db --remote --file=seed/watchlist.generated.sql
 *
 * Input JSON shape (see seed/watchlist.example.json):
 *   [{ "label": string, "cardId"?: string, "strategy"?: "FLIP"|"GRADE"|"BOTH",
 *      "source"?: string, "priority"?: number, "notes"?: string }, ...]
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

interface WatchlistSeedEntry {
  label: string;
  cardId?: string;
  strategy?: "FLIP" | "GRADE" | "BOTH";
  source?: string;
  priority?: number;
  notes?: string;
}

function sqlString(value: string | null | undefined): string {
  if (value === null || value === undefined) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: import-watchlist.ts <path-to-watchlist.json>");
    process.exit(1);
  }

  const entries: WatchlistSeedEntry[] = JSON.parse(readFileSync(inputPath, "utf-8"));
  const statements = entries.map((entry) => {
    const id = randomUUID();
    return `INSERT INTO watchlist_cards (id, card_id, label, strategy, source, priority, notes)
VALUES (${sqlString(id)}, ${sqlString(entry.cardId)}, ${sqlString(entry.label)}, ${sqlString(entry.strategy ?? "GRADE")}, ${sqlString(entry.source)}, ${entry.priority ?? 0}, ${sqlString(entry.notes)});`;
  });

  console.log(statements.join("\n"));
}

main();
