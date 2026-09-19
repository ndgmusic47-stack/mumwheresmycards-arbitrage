import { convertToGbp, DEFAULT_FX_RATES, computeQsv, normaliseTierKey, graderIdForTierKey, type FxRates } from "@mwmc/core";
import type { MarketDataProvider, MarketSnapshotResult } from "./MarketDataProvider.js";
import { classifyLiquidity } from "./liquidity.js";

/**
 * JUSTTCG MARKET PROVIDER (v2) — graded ladders for games PokeTrace does
 * not cover.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHY IT CHANGED THE PLAN.
 *
 * The standing assumption was that no provider we hold sells slab prices
 * for anything but Pokémon, and that a new game's ladder would therefore
 * have to be built in-house from auctions closing with bids — which starts
 * empty and accrues over weeks. JustTCG's v2 documentation contradicts
 * that: it treats PSA, BGS and CGC as first-class priced variants, carrying
 * a `grading: { company, grade, canonical }` block per variant, across the
 * seventeen games it covers including One Piece.
 *
 * If that holds against live data, a new game can qualify trades from its
 * first sync rather than from its first quarter.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS ADAPTER REFUSES TO DO, BECAUSE IT IS NOT YET VERIFIED.
 *
 * Nobody has run this against a live key. The specific thing unverified is
 * not the schema but the COVERAGE: whether JustTCG's graded data actually
 * reaches One Piece, or only the large games. A thin ladder and a full one
 * are the same shape.
 *
 * So this adapter never fills a rung it did not receive. There is no
 * interpolation between grades, no carrying a PSA 9 price down to a PSA 8,
 * no substituting a raw price for a missing low grade. A card that comes
 * back with prices at PSA 9 and PSA 10 only produces a two-rung ladder, the
 * rest null, and the downstream qualification rules — which already refuse
 * to buy on a grade with no price behind it — decline it on their own.
 *
 * This matters more here than it did for Pokémon. PokeTrace returns sale
 * counts per tier, so a thin number can be SEEN to be thin. JustTCG's
 * documented variant shape carries a price and a timestamp; the sale count
 * behind it is not published. Rather than invent a count, this adapter
 * leaves `gradedSaleCounts` empty and lets the existing "a price with no
 * sales behind it is not a price" gate treat every JustTCG grade as
 * evidence-unstated. That is deliberately conservative and it will make
 * this provider qualify FEWER cards than PokeTrace on identical data.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE OTHER HONEST LIMIT: THESE ARE NOT SOLD MEDIANS.
 *
 * JustTCG documents `price` as a market price per variant, with a price
 * history series. It does not document a 7-day and 30-day SOLD median the
 * way PokeTrace does, and this project's QSV model is built on sold
 * medians specifically ("MUST be a completed-sale statistic — never an
 * active asking price").
 *
 * Therefore this adapter passes `rawMedian7d` and `rawMedian30d` as NULL
 * and routes the market price through `computeQsv`'s FALLBACK reference
 * path, which is exactly what that path exists for and which already
 * applies a confidence penalty and a ceiling. The result is marked
 * `isHighConfidenceQsv: false`. A JustTCG-priced card is therefore held to
 * a stricter standard than a PokeTrace-priced one, which is correct: we
 * know less about it.
 */

export interface JustTcgMarketConfig {
  apiKey: string;
  /** Defaults to the documented v2 base. v1 has no graded data at all. */
  baseUrl?: string;
  fxRates?: FxRates;
  /** Currency to assume when a variant carries no explicit currency. */
  assumedCurrency?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_V2_BASE_URL = "https://api.justtcg.com/v2";

export class JustTcgMarketProvider implements MarketDataProvider {
  readonly name = "justtcg";
  private readonly config: Required<Omit<JustTcgMarketConfig, "fetchImpl" | "fxRates">> & {
    fxRates: FxRates;
    fetchImpl: typeof fetch;
  };

  constructor(config: JustTcgMarketConfig) {
    if (!config.apiKey) throw new Error("JustTcgMarketProvider: apiKey is required");
    this.config = {
      apiKey: config.apiKey,
      baseUrl: (config.baseUrl ?? DEFAULT_V2_BASE_URL).replace(/\/+$/, ""),
      assumedCurrency: config.assumedCurrency ?? "USD",
      fxRates: config.fxRates ?? DEFAULT_FX_RATES,
      fetchImpl: config.fetchImpl ?? fetch,
    };
  }

  /**
   * `providerCardId` is the composite this project's catalogue provider
   * built: `<justtcgCardId>::<printing>`. The printing half is what makes a
   * foil and a non-foil distinct rows, so it is used to SELECT the matching
   * variants rather than being stripped and forgotten — asking for a card
   * and pricing whichever printing came back first is how the wrong
   * printing's money ends up on a row.
   */
  async getSnapshotByProviderId(providerCardId: string): Promise<MarketSnapshotResult | null> {
    const [cardId, printing] = splitProviderCardId(providerCardId);

    const url = new URL(`${this.config.baseUrl}/cards`);
    url.searchParams.set("cardId", cardId);
    url.searchParams.set("graded", "true");

    const res = await this.config.fetchImpl(url.toString(), {
      headers: { "x-api-key": this.config.apiKey, accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`JustTCG v2 /cards failed: ${res.status} ${await safeText(res)}`);

    const body = (await res.json()) as unknown;
    const card = asArray(readField(body, ["data", "cards"]) ?? body)[0] ?? readField(body, ["data"]) ?? body;
    const variants = asArray(readField(card, ["variants"]));
    if (variants.length === 0) return null;

    const convert = (value: number | null, currency: string): number | null =>
      value === null ? null : convertToGbp(value, currency, this.config.fxRates);

    // ── RAW SIDE ────────────────────────────────────────────────────────
    // Only variants of THIS printing, and only ungraded ones. Condition is
    // a property of a copy, not of the printing, so several conditions of
    // one printing are candidates for the same raw price; the BEST
    // condition available is used, because that is what a card being sent
    // for grading actually is. Taking a median across conditions would
    // price a near-mint submission using played copies.
    const rawVariants = variants
      .filter((v) => !isGraded(v))
      .filter((v) => printing === null || matchesPrinting(v, printing));

    const rawBest = pickBestConditionPrice(rawVariants);
    const rawCurrency = rawBest?.currency ?? this.config.assumedCurrency;
    const rawMarketPrice = convert(rawBest?.price ?? null, rawCurrency);

    // ── GRADED SIDE ─────────────────────────────────────────────────────
    // A slab's grade does not belong to a printing's condition axis, and
    // JustTCG's graded variants are not guaranteed to repeat the printing
    // string. Graded variants are therefore matched on the CARD, not on the
    // printing, and that is a real limitation worth stating: if a card has
    // both a foil and a non-foil printing, this adapter cannot tell which
    // one a given slab belongs to and will apply the same ladder to both.
    //
    // For Pokemon that would be unacceptable (a 1st Edition holo and an
    // unlimited copy are different markets). For the simple Normal/Foil
    // axis of the games this provider serves it is a bounded, known
    // overstatement, and it is flagged here rather than discovered later.
    const gradedPrices: Record<string, number> = {};
    for (const v of variants) {
      if (!isGraded(v)) continue;
      const tierKey = tierKeyFor(v);
      if (!tierKey) continue;
      // Unrecognised grader (a company we have no scale for) is dropped,
      // not coerced onto PSA's scale.
      if (!graderIdForTierKey(tierKey)) continue;

      const price = num(readField(v, ["price", "market_price", "marketPrice"]));
      const currency = str(readField(v, ["currency"])) ?? this.config.assumedCurrency;
      const gbp = convert(price, currency);
      if (gbp === null || gbp <= 0) continue;

      // Keep the HIGHEST observation when a tier appears more than once
      // (v2's `markets` array can repeat a tier per region). Deliberately
      // not an average: averaging across regions invents a price that
      // nobody paid in any market.
      gradedPrices[tierKey] = Math.max(gradedPrices[tierKey] ?? 0, gbp);
    }

    const psa = (grade: number): number | null => gradedPrices[`PSA_${grade}`] ?? null;

    // ── QSV ─────────────────────────────────────────────────────────────
    // No sold medians exist here (see the class doc comment). The market
    // price goes in as a FALLBACK reference, which is the path that already
    // penalises confidence and caps the result.
    const qsv = computeQsv({
      median7d: null,
      median30d: null,
      fallbackReference: rawMarketPrice,
      baseConfidence: 0.5,
    });

    return {
      providerCardId,
      sourceProvider: this.name,
      priceTimestamp: str(readField(card, ["lastUpdated", "last_updated", "updated_at"])) ?? new Date().toISOString(),
      rawMarketPrice,
      rawMedian7d: null,
      rawMedian30d: null,
      rawQsv: qsv.qsv,
      qsvBasis: qsv.basis,
      isHighConfidenceQsv: false,
      psa6: psa(6),
      psa7: psa(7),
      psa8: psa(8),
      psa9: psa(9),
      psa10: psa(10),
      gradedPrices,
      // Deliberately empty: JustTCG does not publish how many sales sit
      // behind a graded price, and a fabricated count would satisfy the one
      // gate specifically built to catch prices with no evidence.
      gradedSaleCounts: {},
      psaSaleCounts: {},
      // Every graded figure here is a market price, not a sold median, so
      // every grade is flagged as the weaker kind of number.
      estimatedGrades: [6, 7, 8, 9, 10].filter((g) => psa(g) !== null),
      confidence: qsv.confidence,
      // Null, not a number: nothing observable here describes how well
      // evidenced the slab prices are, and borrowing the raw side's
      // confidence is the exact mistake that once displayed a 34-sale PSA
      // 10 at "100% confidence".
      gradedConfidence: null,
      liquidity: classifyLiquidity(0),
      sampleSize: null,
      outliersExcluded: 0,
      sourceCurrency: rawCurrency,
      rawPayload: card,
    };
  }
}

/** `<cardId>::<printing>`; a bare id (no separator) yields a null printing. */
export function splitProviderCardId(providerCardId: string): [string, string | null] {
  const idx = providerCardId.indexOf("::");
  if (idx === -1) return [providerCardId, null];
  return [providerCardId.slice(0, idx), providerCardId.slice(idx + 2) || null];
}

function matchesPrinting(variant: unknown, printing: string): boolean {
  const p = str(readField(variant, ["printing"]));
  return p !== null && p.toLowerCase() === printing.toLowerCase();
}

function isGraded(v: unknown): boolean {
  if (readField(v, ["grading"]) != null) return true;
  return str(readField(v, ["type"]))?.toLowerCase() === "graded";
}

/**
 * Build our tier key ("PSA_9", "BGS_9_5") from v2's grading block.
 * Returns null rather than a guess when the company or grade is absent.
 *
 * A QUALIFIER is treated as a different tier, not the same one: a PSA 9 with
 * an OC qualifier does not sell for what a clean PSA 9 sells for, and
 * folding them together would put the cheaper card's price on the dearer
 * card's rung.
 */
export function tierKeyFor(variant: unknown): string | null {
  const grading = readField(variant, ["grading"]);
  const company = str(readField(grading, ["company"]));
  const gradeRaw = readField(grading, ["grade"]);
  const grade = typeof gradeRaw === "number" ? gradeRaw : Number(str(gradeRaw) ?? NaN);
  if (!company || !Number.isFinite(grade)) return null;

  const qualifier = str(readField(grading, ["qualifier"]));
  const base = `${company}_${String(grade).replace(".", "_")}`;
  return normaliseTierKey(qualifier ? `${base}_${qualifier}` : base);
}

/**
 * The best-conditioned ungraded copy. "Best" is by this project's own
 * ordering, not by price — picking the dearest would silently prefer a
 * mispriced played copy over a correctly priced near-mint one.
 */
const CONDITION_ORDER = ["sealed", "mint", "near mint", "nm", "lightly played", "moderately played", "heavily played", "damaged"];

function pickBestConditionPrice(variants: unknown[]): { price: number; currency: string } | null {
  let best: { price: number; currency: string; rank: number } | null = null;

  for (const v of variants) {
    const price = num(readField(v, ["price", "market_price", "marketPrice"]));
    if (price === null || price <= 0) continue;
    const condition = str(readField(v, ["condition"]))?.toLowerCase() ?? "";
    const idx = CONDITION_ORDER.indexOf(condition);
    // An unrecognised condition ranks LAST, never first — an unknown label
    // must not outrank a known Near Mint.
    const rank = idx === -1 ? CONDITION_ORDER.length : idx;
    const currency = str(readField(v, ["currency"])) ?? "USD";
    if (best === null || rank < best.rank) best = { price, currency, rank };
  }

  return best ? { price: best.price, currency: best.currency } : null;
}

function readField(obj: unknown, names: string[]): unknown {
  if (obj == null || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const n of names) {
    if (rec[n] !== undefined && rec[n] !== null) return rec[n];
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "<no body>";
  }
}
