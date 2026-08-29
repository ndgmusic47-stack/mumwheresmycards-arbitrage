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
