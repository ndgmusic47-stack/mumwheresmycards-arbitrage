import type { CardPrinting } from "@mwmc/core";
import type { MarketDataProvider, MarketSnapshotResult } from "./MarketDataProvider.js";
import { median, trimOutliersIQR } from "./outliers.js";
import { classifyLiquidity } from "./liquidity.js";

export interface PokeTraceConfig {
  apiKey: string;
  baseUrl: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * NOTE ON CONTRACT STABILITY: this adapter's request/response shapes
 * (`PokeTraceSoldComp`, the query params, the endpoint path) are this
 * project's best-effort mapping of PokeTrace's raw/graded pricing API and
 * are ISOLATED ENTIRELY to this file. If PokeTrace's actual contract
 * differs, only this file changes — packages/core and apps/worker depend
 * solely on MarketDataProvider/MarketSnapshotResult and are unaffected.
 * Swapping to PriceCharting/PkmnPrices/Cardmarket later means adding a
 * sibling file implementing the same interface, not touching this one.
 */
interface PokeTraceSoldComp {
  price: number;
  grade: "raw" | "PSA7" | "PSA8" | "PSA9" | "PSA10";
  soldAt: string; // ISO date
}

interface PokeTraceLookupResponse {
  comps: PokeTraceSoldComp[];
  psaPopulation?: { psa7?: number; psa8?: number; psa9?: number; psa10?: number };
  gemRate?: number;
}

export class PokeTraceProvider implements MarketDataProvider {
  readonly name = "poketrace";

  constructor(private readonly config: PokeTraceConfig) {}

  async getSnapshot(printing: CardPrinting): Promise<MarketSnapshotResult | null> {
    const doFetch = this.config.fetchImpl ?? fetch;

    const url = new URL("/v1/cards/lookup", this.config.baseUrl);
    url.searchParams.set("name", printing.name);
    url.searchParams.set("setCode", printing.setCode);
    url.searchParams.set("cardNumber", printing.cardNumber);
    url.searchParams.set("year", String(printing.year));
    url.searchParams.set("language", printing.language);
    url.searchParams.set("edition", printing.edition);
    url.searchParams.set("variant", printing.variant);
    url.searchParams.set("finish", printing.finish);

    const response = await doFetch(url.toString(), {
      headers: { Authorization: `Bearer ${this.config.apiKey}`, Accept: "application/json" },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`PokeTrace lookup failed: ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as PokeTraceLookupResponse;
    return this.toSnapshot(printing, body);
  }

  async getSnapshotsBatch(printings: CardPrinting[]): Promise<Map<string, MarketSnapshotResult>> {
    // PokeTrace batch endpoint TODO — until confirmed available, fall back
    // to sequential calls (still routed through the shared cache upstream,
    // so this only fires for cards that actually need a refresh).
    const results = new Map<string, MarketSnapshotResult>();
    for (const printing of printings) {
      const snapshot = await this.getSnapshot(printing);
      if (snapshot) results.set(printing.printingHash, snapshot);
    }
    return results;
  }

  private toSnapshot(printing: CardPrinting, body: PokeTraceLookupResponse): MarketSnapshotResult | null {
    if (!body.comps || body.comps.length === 0) return null;

    const byGrade = groupByGrade(body.comps);

    const rawPrices = trimOutliersIQR(byGrade.raw.map((c) => c.price));
    const psa7Prices = trimOutliersIQR(byGrade.PSA7.map((c) => c.price));
    const psa8Prices = trimOutliersIQR(byGrade.PSA8.map((c) => c.price));
    const psa9Prices = trimOutliersIQR(byGrade.PSA9.map((c) => c.price));
    const psa10Prices = trimOutliersIQR(byGrade.PSA10.map((c) => c.price));

    const totalExcluded =
      rawPrices.excludedCount + psa7Prices.excludedCount + psa8Prices.excludedCount + psa9Prices.excludedCount + psa10Prices.excludedCount;

    const totalSamples = body.comps.length;
    const rawMarketPrice = rawPrices.trimmed.length ? median(rawPrices.trimmed) : null;

    // QSV (quick-sale value) approximated as the lower quartile-ish of raw
    // comps — the price that clears fast rather than the median "hold out
    // for it" price. Using the 25th percentile of the trimmed raw comps.
    const rawQsv = rawPrices.trimmed.length ? percentile(rawPrices.trimmed, 0.25) : null;

    const latestSoldAt = body.comps.reduce((latest, c) => (c.soldAt > latest ? c.soldAt : latest), body.comps[0]!.soldAt);

    return {
      cardId: printing.printingHash,
      sourceProvider: this.name,
      priceTimestamp: latestSoldAt,
      rawMarketPrice,
      rawQsv,
      psa7: psa7Prices.trimmed.length ? median(psa7Prices.trimmed) : null,
      psa8: psa8Prices.trimmed.length ? median(psa8Prices.trimmed) : null,
      psa9: psa9Prices.trimmed.length ? median(psa9Prices.trimmed) : null,
      psa10: psa10Prices.trimmed.length ? median(psa10Prices.trimmed) : null,
      confidence: computeConfidence(totalSamples, totalExcluded),
      liquidity: classifyLiquidity(totalSamples),
      sampleSize: totalSamples,
      psaPopulation: {
        7: body.psaPopulation?.psa7,
        8: body.psaPopulation?.psa8,
        9: body.psaPopulation?.psa9,
        10: body.psaPopulation?.psa10,
      },
      historicalGemRate: body.gemRate ?? null,
      outliersExcluded: totalExcluded,
      rawPayload: body,
    };
  }
}

function groupByGrade(comps: PokeTraceSoldComp[]): Record<PokeTraceSoldComp["grade"], PokeTraceSoldComp[]> {
  const grouped: Record<PokeTraceSoldComp["grade"], PokeTraceSoldComp[]> = {
    raw: [],
    PSA7: [],
    PSA8: [],
    PSA9: [],
    PSA10: [],
  };
  for (const comp of comps) grouped[comp.grade].push(comp);
  return grouped;
}

function percentile(sortedOrUnsorted: number[], p: number): number {
  const sorted = [...sortedOrUnsorted].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx]!;
}

/** More comps + fewer outliers trimmed => higher confidence. Simple, monotonic, bounded. */
function computeConfidence(totalSamples: number, excluded: number): number {
  const sampleConfidence = Math.min(1, totalSamples / 20); // 20+ comps => full sample confidence
  const cleanliness = totalSamples > 0 ? 1 - excluded / totalSamples : 0;
  return Math.max(0, Math.min(1, Math.round(sampleConfidence * cleanliness * 100) / 100));
}
