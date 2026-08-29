import type { CardPrinting, LiquidityLevel } from "@mwmc/core";

/**
 * Provider-agnostic market snapshot. Every market data provider (PokeTrace
 * today; PriceCharting/PkmnPrices/Cardmarket later) normalizes into this
 * shape. Nothing outside packages/providers/src/market/ knows which
 * provider produced a given snapshot beyond the `sourceProvider` label.
 */
export interface MarketSnapshotResult {
  cardId: string; // printingHash
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
  rawPayload?: unknown;
}

/**
 * The ONE interface the rest of the application depends on for market
 * valuation. Business logic (packages/core, apps/worker) must never import
 * a concrete provider directly — only this interface, resolved via
 * packages/providers/src/market/registry.ts.
 */
export interface MarketDataProvider {
  readonly name: string;
  getSnapshot(printing: CardPrinting): Promise<MarketSnapshotResult | null>;
  /** Optional batch fetch for providers that support it — used to respect
   *  API cost control (see ARCHITECTURE.md section 8). Falls back to
   *  sequential getSnapshot calls when absent. */
  getSnapshotsBatch?(printings: CardPrinting[]): Promise<Map<string, MarketSnapshotResult>>;
}
