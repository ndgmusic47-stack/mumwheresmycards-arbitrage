import type { Db, MarketSnapshotRow } from "@mwmc/db";
import type { MarketDataProvider, MarketSnapshotResult } from "./MarketDataProvider.js";
import { recordApiUsage } from "../apiUsage.js";

export interface MarketSnapshotCacheOptions {
  /** How long a stored snapshot is considered fresh before re-querying the provider.
   *  Slow-moving card metadata should use a long TTL; nothing here refreshes as
   *  often as live listings (see ARCHITECTURE.md section 8). */
  ttlHours: number;
  scanRunId?: string | null;
}

/**
 * D1-backed cache in front of a MarketDataProvider. This is the ONLY place
 * that decides whether to hit the network for market data — every call
 * site (market profiling, scan runner) goes through here, never the
 * provider directly, so API-cost control is enforced in one place.
 *
 * Cache rows are keyed by our INTERNAL card id (printing_hash, same as
 * every other table), while the actual provider call is keyed by the
 * PROVIDER's own card id (from `external_card_refs`) — the caller supplies
 * both because only it knows the mapping between them.
 */
export class MarketSnapshotCache {
  constructor(
    private readonly db: Db,
    private readonly provider: MarketDataProvider,
    private readonly options: MarketSnapshotCacheOptions,
  ) {}

  async getSnapshot(internalCardId: string, providerCardId: string): Promise<MarketSnapshotResult | null> {
    const cached = await this.db.queryFirst<MarketSnapshotRow>(
      `SELECT * FROM market_snapshots WHERE card_id = ? ORDER BY captured_at DESC LIMIT 1`,
      internalCardId,
    );

    if (cached && this.isFresh(cached.captured_at)) {
      await recordApiUsage(this.db, {
        provider: this.provider.name,
        endpoint: "getSnapshotByProviderId",
        scanRunId: this.options.scanRunId,
        cacheHit: true,
        costWeight: 0,
      });
      return rowToSnapshot(cached, providerCardId);
    }

    const fresh = await this.provider.getSnapshotByProviderId(providerCardId);

    await recordApiUsage(this.db, {
      provider: this.provider.name,
      endpoint: "getSnapshotByProviderId",
      scanRunId: this.options.scanRunId,
      cacheHit: false,
      costWeight: 1,
    });

    if (!fresh) {
      // Provider had nothing new — fall back to the stale cached row (if
      // any) rather than surfacing no data at all.
      return cached ? rowToSnapshot(cached, providerCardId) : null;
    }

    await this.persist(internalCardId, fresh);
    return fresh;
  }

  private isFresh(capturedAtIso: string): boolean {
    const capturedAt = new Date(capturedAtIso.endsWith("Z") ? capturedAtIso : capturedAtIso + "Z").getTime();
    const ageHours = (Date.now() - capturedAt) / (1000 * 60 * 60);
    return ageHours <= this.options.ttlHours;
  }

  private async persist(internalCardId: string, snapshot: MarketSnapshotResult): Promise<void> {
    await this.db.exec(
      `INSERT INTO market_snapshots (
        card_id, source_provider, price_timestamp, raw_market_price, raw_qsv,
        psa7, psa8, psa9, psa10, confidence, liquidity, sample_size,
        psa_population_7, psa_population_8, psa_population_9, psa_population_10,
        historical_gem_rate, outliers_excluded, raw_payload
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      internalCardId,
      snapshot.sourceProvider,
      snapshot.priceTimestamp,
      snapshot.rawMarketPrice,
      snapshot.rawQsv,
      snapshot.psa7,
      snapshot.psa8,
      snapshot.psa9,
      snapshot.psa10,
      snapshot.confidence,
      snapshot.liquidity,
      snapshot.sampleSize,
      snapshot.psaPopulation?.[7] ?? null,
      snapshot.psaPopulation?.[8] ?? null,
      snapshot.psaPopulation?.[9] ?? null,
      snapshot.psaPopulation?.[10] ?? null,
      snapshot.historicalGemRate ?? null,
      snapshot.outliersExcluded,
      snapshot.rawPayload ? JSON.stringify(snapshot.rawPayload) : null,
    );
  }
}

function rowToSnapshot(row: MarketSnapshotRow, providerCardId: string): MarketSnapshotResult {
  return {
    providerCardId,
    sourceProvider: row.source_provider,
    priceTimestamp: row.price_timestamp,
    rawMarketPrice: row.raw_market_price,
    rawQsv: row.raw_qsv,
    psa7: row.psa7,
    psa8: row.psa8,
    psa9: row.psa9,
    psa10: row.psa10,
    confidence: row.confidence,
    liquidity: row.liquidity,
    sampleSize: row.sample_size,
    psaPopulation: {
      7: row.psa_population_7 ?? undefined,
      8: row.psa_population_8 ?? undefined,
      9: row.psa_population_9 ?? undefined,
      10: row.psa_population_10 ?? undefined,
    },
    historicalGemRate: row.historical_gem_rate,
    outliersExcluded: row.outliers_excluded,
    rawPayload: row.raw_payload ? safeParse(row.raw_payload) : undefined,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
