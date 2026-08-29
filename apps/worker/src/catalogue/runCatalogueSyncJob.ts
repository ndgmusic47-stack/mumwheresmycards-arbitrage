import { Db, type CatalogueSyncRunRow } from "@mwmc/db";
import type { CatalogueProvider } from "@mwmc/providers";
import { runCatalogueSync } from "./catalogueSync.js";
import { createD1CatalogueSyncRepo } from "../repo/catalogueSyncRepo.js";

export interface CatalogueSyncJobSettings {
  pageSize: number;
  maxPagesPerRun: number;
}

/**
 * D1-wired wrapper around the pure `runCatalogueSync` algorithm: records a
 * `catalogue_sync_runs` row for observability (pages fetched, cards
 * inserted/updated/skipped, API calls, errors) the same way `scanRunner.ts`
 * records `scan_runs`. Called at the start of every scan (see
 * scanRunner.ts) so the application keeps bootstrapping/refreshing its own
 * catalogue automatically — no manual seeding required.
 */
export async function runCatalogueSyncJob(
  db: Db,
  provider: CatalogueProvider,
  settings: CatalogueSyncJobSettings,
): Promise<CatalogueSyncRunRow> {
  const runId = crypto.randomUUID();
  const repo = createD1CatalogueSyncRepo(db);
  const existingCheckpoint = await repo.getCheckpoint(provider.name);

  await db.exec(
    `INSERT INTO catalogue_sync_runs (id, provider, cursor_start) VALUES (?, ?, ?)`,
    runId,
    provider.name,
    existingCheckpoint?.cursor ?? null,
  );

  const result = await runCatalogueSync(provider, repo, settings);

  await db.exec(
    `UPDATE catalogue_sync_runs SET
       status = ?, cursor_end = ?, pages_fetched = ?, cards_inserted = ?, cards_updated = ?,
       cards_skipped = ?, api_calls_made = ?, reached_end = ?, errors = ?, finished_at = datetime('now')
     WHERE id = ?`,
    result.status,
    result.cursorEnd,
    result.pagesFetched,
    result.cardsInserted,
    result.cardsUpdated,
    result.cardsSkipped,
    result.apiCallsMade,
    result.reachedEnd ? 1 : 0,
    result.errors.length ? JSON.stringify(result.errors) : null,
    runId,
  );

  return (await db.queryFirst<CatalogueSyncRunRow>(`SELECT * FROM catalogue_sync_runs WHERE id = ?`, runId))!;
}
