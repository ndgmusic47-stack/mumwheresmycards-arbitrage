import { Db, type ExternalCardRefRow } from "@mwmc/db";

/** Placeholder default, in preference order (most-preferred first) — see
 *  findExternalRefForCard doc comment for why this can't yet be a
 *  confirmed business rule, and settingsRepo.ts for where a real value
 *  should get wired in going forward. */
export const DEFAULT_EXTERNAL_REF_MARKET_PREFERENCE: readonly string[] = ["EU", "US"];

/**
 * Persists the mapping between a market-data provider's OWN card id and
 * our internal card (printing_hash) — see migration 0006 and the
 * realignment note "Store the provider's own card ID. Do not rely only on
 * printingHash for external provider mapping." Populated by the catalogue
 * sync (apps/worker/src/catalogue/catalogueSync.ts) and read by market
 * profiling to know which provider id to fetch pricing for.
 *
 * `market` (migration 0011) is the provider's own market dimension for
 * THIS catalogue row (PokeTrace: 'US' | 'EU') — stored so a card cataloged
 * under more than one market by the same provider can be told apart later
 * (see findExternalRefForCard).
 */
export async function upsertExternalCardRef(
  db: Db,
  provider: string,
  providerCardId: string,
  internalCardId: string,
  providerUpdatedAt: string | null,
  market: string | null,
): Promise<void> {
  await db.exec(
    `INSERT INTO external_card_refs (provider, provider_card_id, internal_card_id, provider_updated_at, market, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider, provider_card_id) DO UPDATE SET
       internal_card_id = excluded.internal_card_id,
       provider_updated_at = excluded.provider_updated_at,
       market = excluded.market,
       updated_at = datetime('now')`,
    provider,
    providerCardId,
    internalCardId,
    providerUpdatedAt,
    market,
  );
}

/**
 * Pure ranking helper for findExternalRefForCard's ORDER BY — lower is
 * more preferred. A market not present in `preferredMarkets` (including
 * `null`, e.g. a ref written before migration 0011) ranks last, after
 * every named preference, rather than being excluded — an un-marketed or
 * unrecognized ref is still a usable fallback, just the least-preferred
 * one. Exported and unit-tested on its own (apps/worker/test) because the
 * SQL this drives has no D1 test harness in this repo.
 */
export function rankMarket(market: string | null, preferredMarkets: readonly string[]): number {
  if (market === null) return preferredMarkets.length;
  const idx = preferredMarkets.indexOf(market);
  return idx === -1 ? preferredMarkets.length : idx;
}

/**
 * Returns the single external ref D1 should use for this (provider,
 * internal card) pair.
 *
 * BACKGROUND — this used to be `... LIMIT 1` with no ORDER BY. That was
 * silently unsound: card IDENTITY (packages/core) has no market dimension,
 * so if PokeTrace catalogues the same printing under more than one market
 * (e.g. separate US and EU rows for what resolves to the same internal
 * card — confirmed possible by PokeTrace's documented 'US' | 'EU' market
 * query dimension; not yet confirmed how OFTEN it actually happens against
 * real data), both rows map to the same internal_card_id, and which one
 * `LIMIT 1` happened to return was an accident of SQLite's storage order —
 * meaning a card's market profile could silently be built from either
 * market's pricing, and could change which one between runs.
 *
 * FIX: order deterministically by an explicit, visible market preference
 * (`preferredMarkets`, most-preferred first) instead. `DEFAULT_EXTERNAL_REF_MARKET_PREFERENCE`
 * is a PLACEHOLDER — EU is listed ahead of US as a starting guess for a
 * UK-based business (closer market, not a business decision made from real
 * evidence), not a confirmed rule. The live catalogue-ingestion diagnostic
 * (`POST /catalogue/sync-and-profile`) reports how many internal cards
 * actually pick up more than one ref from the same provider, and which
 * markets those are — that real evidence is what should settle the actual
 * preference (or reveal the ambiguity almost never occurs, in which case
 * this whole question is moot). Until then this is deterministic and
 * visible rather than fabricated confidence about which market "wins".
 */
export async function findExternalRefForCard(
  db: Db,
  provider: string,
  internalCardId: string,
  preferredMarkets: readonly string[] = DEFAULT_EXTERNAL_REF_MARKET_PREFERENCE,
): Promise<ExternalCardRefRow | null> {
  const rankCase = preferredMarkets.map((_, i) => `WHEN ? THEN ${i}`).join(" ");
  return db.queryFirst<ExternalCardRefRow>(
    `SELECT * FROM external_card_refs
     WHERE provider = ? AND internal_card_id = ?
     ORDER BY (CASE market ${rankCase} ELSE ${preferredMarkets.length} END) ASC, id ASC
     LIMIT 1`,
    provider,
    internalCardId,
    ...preferredMarkets,
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
