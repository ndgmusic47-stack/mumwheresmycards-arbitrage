import type { LiquidityLevel, PsaGrade } from "@mwmc/core";

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
  /**
   * 7-day SOLD median for the raw card. Carried through UNMODIFIED so the
   * QSV model (packages/core/src/market/qsv.ts) can take the lower of the
   * two windows itself and the underlying data stays auditable.
   * MUST be a completed-sale statistic — never an active asking price.
   */
  rawMedian7d: number | null;
  /** 30-day SOLD median. Same rules as `rawMedian7d`. */
  rawMedian30d: number | null;
  /**
   * QSV derived by the provider adapter via `computeQsv` — the lower of the
   * two sold medians, less the quick-sale haircut. Null when neither median
   * nor a fallback reference is available.
   */
  rawQsv: number | null;
  /** How `rawQsv` was derived, for audit — see QsvBasis in @mwmc/core. */
  qsvBasis?: string;
  /** FALSE when rawQsv came from a fallback reference, not a sold median. */
  isHighConfidenceQsv?: boolean;
  psa6?: number | null;
  psa7: number | null;
  psa8: number | null;
  psa9: number | null;
  psa10: number | null;
  /**
   * EVERY graded price the provider returned, in GBP, keyed by the
   * provider's own normalised tier key (e.g. "PSA_5", "SGC_8_5", "TAG_9").
   *
   * The five named psa6-psa10 fields above are a SUBSET of this, kept
   * because the scan-time engine reads them by name. This map is the whole
   * observation, including low grades, half grades and other graders — see
   * @mwmc/core's gradedTierKeys.ts for mapping it onto a published scale.
   *
   * Empty object (not undefined) when the provider returned no graded tier
   * this adapter recognised.
   */
  gradedPrices?: Record<string, number>;
  /**
   * HOW MANY SALES SIT BEHIND EACH GRADED PRICE, keyed the same way as
   * `gradedPrices`. Added 2026-09-13.
   *
   * A slab price without its sale count is not evidence, it is a rumour. The
   * provider has always returned this per tier; the adapter used to keep only
   * the RAW tier's count and then present it downstream as slab liquidity.
   * A grade whose key is absent here has a price and no stated evidence.
   */
  gradedSaleCounts?: Record<string, number>;
  /** Named-grade sale counts, the psa6-psa10 subset of `gradedSaleCounts`. */
  psaSaleCounts?: Partial<Record<PsaGrade, number | null>>;
  /**
   * Grades whose price is a provider AVERAGE because no sold median was
   * available for that tier. Everything else is the lower of the 7-day and
   * 30-day medians, matching the raw side. An average is the statistic one
   * mis-listed bundle distorts, so a grade listed here is a weaker number
   * than the rest of the ladder and must be able to say so.
   */
  estimatedGrades?: number[];
  confidence: number; // 0..1
  /**
   * The GRADED side's own confidence, 0..1 — added 2026-09-13.
   *
   * `confidence` above describes the raw card. Presenting it against slab
   * economics is how a PSA 10 backed by 34 sales came to be displayed at
   * "100% confidence": the raw tier had 110 sales and there was only ever
   * one number. This one is derived from the graded tiers' own sale counts
   * and from how far the provider's price windows disagree with each other.
   *
   * `null` means the provider priced no named grade, so nothing can be said
   * about the slabs — never a reason to fall back to the raw figure.
   */
  gradedConfidence?: number | null;
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
