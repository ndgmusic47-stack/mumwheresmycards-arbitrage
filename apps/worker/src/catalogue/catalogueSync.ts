import { resolveCardPrinting } from "@mwmc/core";
import type { RawCardIdentity, CardPrinting } from "@mwmc/core";
import type { CatalogueProvider, CatalogueCardDTO } from "@mwmc/providers";
import { mapPokeTraceVariant } from "@mwmc/providers";

/**
 * Persistence abstraction the sync algorithm needs — deliberately NOT a
 * concrete D1 `Db`, so this function is a pure orchestration loop that can
 * be unit tested with an in-memory fake (see apps/worker/test/catalogueSync.test.ts)
 * without Miniflare. `apps/worker/src/repo/catalogueSyncRepo.ts` provides
 * the real D1-backed implementation used by the scan/cron job.
 */
export interface CatalogueSyncRepo {
  getCheckpoint(providerName: string): Promise<{ cursor: string | null } | null>;
  saveCheckpoint(providerName: string, cursor: string | null, reachedEnd: boolean): Promise<void>;
  upsertCard(printing: CardPrinting): Promise<"inserted" | "updated">;
  /** `market` is the provider's own 'US' | 'EU' | ... dimension for this
   *  catalogue entry (PokeTrace: CatalogueCardDTO.market) — stored (not
   *  discarded) so a card with more than one provider ref (one per market)
   *  can be resolved deterministically later. See externalCardRefsRepo.ts. */
  upsertExternalRef(providerName: string, providerCardId: string, internalCardId: string, providerUpdatedAt: string | null, market: string | null): Promise<void>;
}

export interface CatalogueSyncOptions {
  maxPagesPerRun: number;
  pageSize: number;
  /** PokeTrace's catalogue is assumed English-market-only (see
   *  @mwmc/providers CatalogueProvider.ts doc comment) — a documented
   *  assumption to verify with real data, not a per-card guess. */
  assumedLanguage: RawCardIdentity["language"];
}

export const DEFAULT_CATALOGUE_SYNC_OPTIONS: CatalogueSyncOptions = {
  maxPagesPerRun: 25,
  pageSize: 20,
  assumedLanguage: "EN",
};

export interface CatalogueSyncRunResult {
  status: "SUCCESS" | "PARTIAL" | "FAILED";
  cursorStart: string | null;
  cursorEnd: string | null;
  pagesFetched: number;
  cardsInserted: number;
  cardsUpdated: number;
  cardsSkipped: number;
  apiCallsMade: number;
  /** True once pagination reached hasMore=false during this run — the
   *  NEXT run should then start over from the top to pick up new/changed
   *  catalogue entries, rather than treating the checkpoint as "done forever". */
  reachedEnd: boolean;
  errors: string[];
}

/**
 * Resumable catalogue sync: enumerates a CatalogueProvider's full singles
 * catalogue into `cards` + `external_card_refs` via the injected repo,
 * resuming from the last saved cursor. Bounded to `maxPagesPerRun` pages
 * per call so a single scheduled tick can't run forever — the checkpoint
 * is saved after EVERY page, so a mid-run failure (thrown error, worker
 * timeout) loses at most the in-flight page; the next call resumes from
 * exactly where the last successfully-processed page left off. This is
 * what lets the application bootstrap itself from an empty database with
 * no manually-seeded cards required — see ARCHITECTURE.md.
 */
export async function runCatalogueSync(
  provider: CatalogueProvider,
  repo: CatalogueSyncRepo,
  options: Partial<CatalogueSyncOptions> = {},
): Promise<CatalogueSyncRunResult> {
  const opts = { ...DEFAULT_CATALOGUE_SYNC_OPTIONS, ...options };
  const result: CatalogueSyncRunResult = {
    status: "SUCCESS",
    cursorStart: null,
    cursorEnd: null,
    pagesFetched: 0,
    cardsInserted: 0,
    cardsUpdated: 0,
    cardsSkipped: 0,
    apiCallsMade: 0,
    reachedEnd: false,
    errors: [],
  };

  try {
    const checkpoint = await repo.getCheckpoint(provider.name);
    let cursor = checkpoint?.cursor ?? null;
    result.cursorStart = cursor;
    result.cursorEnd = cursor;

    const setsList = await provider.fetchSets();
    result.apiCallsMade++;
    const yearBySetCode = new Map(setsList.map((s) => [s.setCode, s.year]));

    for (let pages = 0; pages < opts.maxPagesPerRun; pages++) {
      const page = await provider.fetchPage(cursor, opts.pageSize);
      result.apiCallsMade++;
      result.pagesFetched++;

      for (const dto of page.cards) {
        try {
          const outcome = await processCard(provider.name, dto, yearBySetCode, opts, repo);
          if (outcome === "inserted") result.cardsInserted++;
          else if (outcome === "updated") result.cardsUpdated++;
          else result.cardsSkipped++;
        } catch (err) {
          result.cardsSkipped++;
          result.errors.push(`Card ${dto.providerCardId}: ${String(err)}`);
        }
      }

      cursor = page.nextCursor;
      result.reachedEnd = !page.hasMore;
      // Save after EVERY page (not just at the end of the run) — this is
      // what makes a mid-run crash resumable rather than restart-from-zero.
      await repo.saveCheckpoint(provider.name, cursor, result.reachedEnd);
      result.cursorEnd = cursor;

      if (!page.hasMore) break;
    }

    result.status = result.errors.length > 0 ? "PARTIAL" : "SUCCESS";
  } catch (err) {
    result.status = "FAILED";
    result.errors.push(String(err));
  }

  return result;
}

async function processCard(
  providerName: string,
  dto: CatalogueCardDTO,
  yearBySetCode: Map<string, number | null>,
  opts: CatalogueSyncOptions,
  repo: CatalogueSyncRepo,
): Promise<"inserted" | "updated" | "skipped"> {
  // Never guess an unrecognized provider variant string (see
  // poketraceVariantMapping.ts) — skip rather than fabricate an identity.
  const mapped = mapPokeTraceVariant(dto.providerVariant);
  if (!mapped) return "skipped";

  // Never fabricate a year for an unresolvable set — store null rather than
  // guess. This no longer skips the card: year is not a required identity
  // field (see packages/core/src/card/resolver.ts REQUIRED_FIELDS), so a
  // card whose set has no resolvable release year is still catalogued.
  const year = yearBySetCode.get(dto.setCode);

  if (!dto.name || !dto.cardNumber || !dto.setName) return "skipped";

  const identity: RawCardIdentity = {
    game: "pokemon",
    name: dto.name,
    setName: dto.setName,
    setCode: dto.setCode,
    cardNumber: dto.cardNumber,
    year: year ?? undefined,
    language: opts.assumedLanguage,
    edition: mapped.edition,
    variant: mapped.variant,
    finish: mapped.finish,
    rarity: dto.rarity ?? undefined,
  };

  const resolved = resolveCardPrinting(identity);
  if (!resolved.ok || !resolved.printing) return "skipped";

  const outcome = await repo.upsertCard(resolved.printing);
  await repo.upsertExternalRef(providerName, dto.providerCardId, resolved.printing.printingHash, dto.providerUpdatedAt, dto.market);
  return outcome;
}
