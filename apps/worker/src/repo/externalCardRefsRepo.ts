import { Db, type ExternalCardRefRow } from "@mwmc/db";

/**
 * Persists the mapping between a market-data provider's OWN card id and
 * our internal card (printing_hash) — see migration 0006 and the
 * realignment note "Store the provider's own card ID. Do not rely only on
 * printingHash for external provider mapping." Populated by the catalogue
 * sync (apps/worker/src/catalogue/catalogueSync.ts) and read by market
 * profiling to know which provider id to fetch pricing for.
 */
export async function upsertExternalCardRef(
  db: Db,
  provider: string,
  providerCardId: string,
  internalCardId: string,
  providerUpdatedAt: string | null,
): Promise<void> {
  await db.exec(
    `INSERT INTO external_card_refs (provider, provider_card_id, internal_card_id, provider_updated_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider, provider_card_id) DO UPDATE SET
       internal_card_id = excluded.internal_card_id,
       provider_updated_at = excluded.provider_updated_at,
       updated_at = datetime('now')`,
    provider,
    providerCardId,
    internalCardId,
    providerUpdatedAt,
  );
}

export async function findExternalRefForCard(db: Db, provider: string, internalCardId: string): Promise<ExternalCardRefRow | null> {
  return db.queryFirst<ExternalCardRefRow>(
    `SELECT * FROM external_card_refs WHERE provider = ? AND internal_card_id = ? LIMIT 1`,
    provider,
    internalCardId,
  );
}

export async function findInternalCardIdByProviderRef(db: Db, provider: string, providerCardId: string): Promise<string | null> {
  const row = await db.queryFirst<Pick<ExternalCardRefRow, "internal_card_id">>(
    `SELECT internal_card_id FROM external_card_refs WHERE provider = ? AND provider_card_id = ? LIMIT 1`,
    provider,
    providerCardId,
  );
  return row?.internal_card_id ?? null;
}
