import type { Db } from "@mwmc/db";

export interface RecordApiUsageInput {
  provider: string;
  endpoint: string;
  scanRunId?: string | null;
  cacheHit: boolean;
  costWeight?: number;
}

/**
 * Every outbound provider call — cache hit or miss — is logged here. This
 * is what lets the dashboard show real API spend/call counts instead of an
 * estimate (see ARCHITECTURE.md section 8, "API cost control").
 */
/**
 * Real (non-cache-hit) calls made to `provider` since UTC midnight — the
 * input to the daily provider-call budget (see apps/worker's
 * marketProfiling.ts / settingsRepo.ts's MarketProviderBudgetSettings).
 * UTC day boundary, matching `api_usage.called_at`'s own datetime('now')
 * default, so the count and the timestamps it's counting never disagree
 * about what "today" is. Uses the existing (provider, called_at) index.
 */
export async function countProviderCallsToday(db: Db, provider: string): Promise<number> {
  const row = await db.queryFirst<{ n: number }>(
    `SELECT COUNT(*) as n FROM api_usage
     WHERE provider = ? AND cache_hit = 0 AND called_at >= datetime('now', 'start of day')`,
    provider,
  );
  return row?.n ?? 0;
}

export async function recordApiUsage(db: Db, input: RecordApiUsageInput): Promise<void> {
  await db.exec(
    `INSERT INTO api_usage (provider, endpoint, scan_run_id, cache_hit, cost_weight) VALUES (?, ?, ?, ?, ?)`,
    input.provider,
    input.endpoint,
    input.scanRunId ?? null,
    input.cacheHit ? 1 : 0,
    input.costWeight ?? 1,
  );
}
