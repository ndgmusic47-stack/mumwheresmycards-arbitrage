import type { LiquidityLevel } from "@mwmc/core";

/**
 * Provider-agnostic market snapshot. Every market data provider (PokeTrace
 * today; PriceCharting/PkmnPrices/Cardmarket later) normalizes into this
 * shape, ALWAYS in GBP (see currency.ts — PokeTrace itself prices in
 * USD/EUR). Nothing outside packages/providers/src/market/ knows which
 * provider produced a given snapshot beyond the `sourceProvider` label.
 *
 * NOTE: this does NOT carry our internal printingHash — providers have no
 * knowledge of it. The caller (the D1-backed cache / catalogue sync) is
 * responsible for associating a snapshot with an internal card via
 * `external_card_refs`.
 */
export interface MarketSnapshotResult {
  /** The provider's own card identifier — what was actually queried. */
  providerCardId: string;
  sourceProvider: string;
  priceTimestamp: string; // ISO 8601 — timestamp of the underlying sold data
  rawMarketPrice: number | null;
  rawQsv: number | null;
  psa7: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  confidence: number; // 0..1
  liquidity: LiquidityLevel;
  sampleSize: number | null;
  psaPopulation?: Partial<Record<7 | 8 | 9 | 10, number>>;
  /** Historical gem-rate (PSA10 / total graded) if the provider exposes it.
   *  Informational only — NEVER treated as our probability of a PSA10. */
  historicalGemRate?: number | null;
  outliersExcluded: number;
  /** Currency the provider originally returned this snapshot in, before GBP
   *  conversion — kept for audit even though every field above is GBP. */
  sourceCurrency?: string;
  rawPayload?: unknown;
}

/**
 * The ONE interface the rest of the application depends on for market
 * valuation. Business logic (packages/core, apps/worker) must never import
 * a concrete provider directly — only this interface, resolved via
 * packages/providers/src/market/registry.ts.
 *
 * Looked up by the PROVIDER'S OWN card ID (see `external_card_refs`), not
 * by searching identity fields — this matches how PokeTrace's real API
 * actually works (GET /cards/{id}) and is populated by the catalogue sync,
 * not guessed per-lookup.
 */
export interface MarketDataProvider {
  readonly name: string;
  getSnapshotByProviderId(providerCardId: string): Promise<MarketSnapshotResult | null>;
  /** Optional batch fetch for providers that support it — used to respect
   *  API cost control (see ARCHITECTURE.md section 8). Falls back to
   *  sequential getSnapshotByProviderId calls when absent. PokeTrace's
   *  documented contract has no batch-by-ID endpoint today, so its adapter
   *  does not implement this. */
  getSnapshotsBatch?(providerCardIds: string[]): Promise<Map<string, MarketSnapshotResult>>;
}
