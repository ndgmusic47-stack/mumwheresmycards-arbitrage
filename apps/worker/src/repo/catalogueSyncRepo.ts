import { Db, type CatalogueSyncCheckpointRow } from "@mwmc/db";
import type { CardPrinting } from "@mwmc/core";
import type { CatalogueSyncRepo } from "../catalogue/catalogueSync.js";
import { upsertCard } from "./cardsRepo.js";
import { upsertExternalCardRef } from "./externalCardRefsRepo.js";

/** D1-backed implementation of the sync algorithm's persistence
 *  abstraction (apps/worker/src/catalogue/catalogueSync.ts) — the only
 *  place that algorithm touches D1 directly. */
export function createD1CatalogueSyncRepo(db: Db): CatalogueSyncRepo {
  return {
    async getCheckpoint(providerName: string) {
      const row = await db.queryFirst<CatalogueSyncCheckpointRow>(
        `SELECT * FROM catalogue_sync_checkpoint WHERE provider = ?`,
        providerName,
      );
      return row ? { cursor: row.cursor } : null;
    },

    async saveCheckpoint(providerName: string, cursor: string | null, reachedEnd: boolean) {
      await db.exec(
        `INSERT INTO catalogue_sync_checkpoint (provider, cursor, last_full_sync_completed_at, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(provider) DO UPDATE SET
           cursor = excluded.cursor,
           last_full_sync_completed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE catalogue_sync_checkpoint.last_full_sync_completed_at END,
           updated_at = datetime('now')`,
        providerName,
        cursor,
        reachedEnd ? 1 : 0,
        reachedEnd ? 1 : 0,
      );
    },

    async upsertCard(printing: CardPrinting) {
      return upsertCard(db, printing);
    },

    async upsertExternalRef(providerName: string, providerCardId: string, internalCardId: string, providerUpdatedAt: string | null, market: string | null) {
      await upsertExternalCardRef(db, providerName, providerCardId, internalCardId, providerUpdatedAt, market);
    },
  };
}
