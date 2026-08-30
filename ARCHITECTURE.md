# Mum Where's My Cards — Arbitrage Engine
## Architecture (v1 — catalogue-first realignment)

Private application at `mumwheresmycards.com/arbitrage`. V1 scope: **underpriced raw card flips** and **raw → PSA grading candidates**. Architected so new-release flipping/holding and additional market/grading providers can be added later without rewrites.

This document reflects a realignment away from the original manually-seeded-watchlist model: the application now discovers opportunities automatically across the **whole** Pokémon singles market. There is no manual per-card selection anywhere in the discovery path. A "Saved Cards" watchlist still exists as a secondary, non-primary-nav feature (`watchlist_cards`), but it plays no part in scanning.

---

## 1. The three layers (do not combine these concepts)

Everything in this system fits into exactly one of three layers. Keeping them structurally separate is a hard architecture rule, not a style preference — it's what makes "is this card worth anything?" answerable independently of "can I buy it right now?", and both independently of "is this specific listing a real trade?".

```
 CARD MARKET                    LIVE SUPPLY                  OPPORTUNITY
 "What cards are               "Which of those cards        "Does this exact
  economically                  can I buy right now?"         listing create a
  interesting?"                                                profitable trade?"

 cards                          ebay_listings                opportunities
 external_card_refs             (supply signal only —        (forecast, immutable
 market_snapshots                NEVER market value)          once acted on)
 flip_profiles
 grade_profiles
      │                               │                            │
      │ computed from market data     │ fetched from eBay,         │ computed from a
      │ ALONE, across the whole       │ prioritised against        │ REAL listing price
      │ catalogue, before any         │ the Dynamic Flip/Grade     │ + the card's market
      │ eBay search                   │ Universe                   │ snapshot
      ▼                               ▼                            ▼
 Dynamic Flip Universe          Prioritised eBay search      buildOpportunities()
 Dynamic Grade Universe         (bounded API budget)         (packages/core, pure,
 (packages/core/src/market)                                   unchanged by this
                                                               realignment)
```

## 2. High-level pipeline

```
FULL POKÉMON SINGLES CATALOGUE (catalogue sync — resumable, self-bootstrapping)
        │  populates: cards, external_card_refs
        ▼
MARKET DATA (raw + PSA values, via the cached MarketDataProvider)
        │  populates: market_snapshots
        ▼
MARKET PROFILING — CARD MARKET layer (packages/core/src/market, pure)
        │  populates: flip_profiles, grade_profiles
        │  = DYNAMIC FLIP UNIVERSE + DYNAMIC GRADE UNIVERSE
        ▼
PRIORITISED EBAY SEARCH — LIVE SUPPLY layer (bounded API budget)
        │  populates: ebay_listings
        ▼
EXACT LISTING/CARD MATCH + TRUE COST CALCULATION + FLIP/GRADE SCORE
        │  packages/core/src/opportunity — unchanged
        ▼
OPPORTUNITY layer → dashboard filters → only real opportunities shown
        populates: opportunities
```

`apps/worker/src/scan/scanRunner.ts` runs all of this every scan (cron or manual): catalogue sync (bounded, resumable) → market profiling (bounded batch) → prioritised eBay search (bounded budget) → the unchanged opportunity engine. Nothing here waits for a human to pick cards.

```
                        ┌─────────────────────────────┐
                        │   Cloudflare Cron Trigger    │
                        │  (scheduled scan, e.g. */30m)│
                        └───────────────┬──────────────┘
                                        │ invokes
                                        ▼
┌───────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker (apps/worker)                 │
│                                                                       │
│  scheduled()/POST /scan-runs ──▶ ScanRunner                          │
│     1. CatalogueSyncJob   ──▶ CatalogueProvider (iface)               │
│     2. Market profiling   ──▶ MarketDataProvider (iface, cached)      │
│     3. Prioritised search ──▶ EbayListingsProvider (iface)            │
│     4. OpportunityEngine (packages/core, pure, unchanged)             │
│                                                                       │
│  fetch() ──▶ Hono router ──▶ /api/* (opportunities, market, catalogue,│
│              cards, inventory, transactions, grading, settings,      │
│              scan-runs, watchlist) + CF Access JWT middleware        │
│              + static asset serving for apps/web build (SPA)         │
└───────────────────────────────┬───────────────────────────────────┘
                                 │ D1 (SQL, bound as DB)
                                 ▼
                        Cloudflare D1 (SQLite)
                        cards, external_card_refs, market_snapshots,
                        flip_profiles, grade_profiles, ebay_listings,
                        opportunities, inventory, transactions,
                        grading_submissions, grading_results, settings,
                        scan_runs, catalogue_sync_runs,
                        catalogue_sync_checkpoint, watchlist_cards, api_usage
```

React SPA (`apps/web`) is built as static assets and served by the same Worker under `/arbitrage/*`. Primary nav: **Opportunities / Flips / Grade / Market / Inventory / Pipeline** — Watchlist is reachable but not in primary nav (it's a "Saved Cards" convenience, not a discovery mechanism). Everything sits behind Cloudflare Access — no public data.

---

## 3. Monorepo layout

```
mumwheresmycards/
  apps/
    worker/
      src/
        catalogue/
          catalogueSync.ts        pure, resumable sync algorithm (unit tested with fakes)
          runCatalogueSyncJob.ts  D1-wired wrapper — records catalogue_sync_runs
        scan/scanRunner.ts        orchestrates one scan: sync → profile → search → score
        repo/
          cardsRepo.ts, externalCardRefsRepo.ts, catalogueSyncRepo.ts,
          marketProfilesRepo.ts, listingsRepo.ts, opportunitiesRepo.ts, settingsRepo.ts
        routes/
          market.ts (MARKET tab + dashboard summary), catalogue.ts (sync status/trigger),
          opportunities.ts, cards.ts, inventory.ts, transactions.ts, grading.ts,
          settings.ts, scan-runs.ts, watchlist.ts
      migrations/                 D1 SQL migrations (numbered, 0001–0009)

    web/
      src/
        pages/ (Dashboard, Market, OpportunityDetail, Inventory, Pipeline, Watchlist)
        components/ (OpportunityTable, FilterBar, SummaryStats, ScoreBadge, ...)

  packages/
    core/                         Pure business logic, framework-free, heavily tested
      src/
        card/                     canonical card model + resolver (unchanged)
        calc/                     cost & profit calculation engine (unchanged)
        scoring/                  FLIP SCORE / GRADE SCORE (unchanged)
        filters/                  opportunity filter predicates (unchanged)
        opportunity/              opportunity engine (pure functions, unchanged)
        market/                   NEW — CARD MARKET layer: flipProfile.ts, gradeProfile.ts,
                                  prioritization.ts, currency.ts (GBP normalization)

    providers/
      src/
        market/                   MarketDataProvider (revised: ID-based lookup), PokeTraceProvider
                                  (rewritten against the VERIFIED real contract), MockMarketProvider, cache
        catalogue/                NEW — CatalogueProvider (iface), PokeTraceCatalogueProvider,
                                  MockCatalogueProvider, poketraceVariantMapping.ts
        ebay/                     EbayListingsProvider / EbayBrowseProvider / MockEbayProvider (unchanged)
        http/backoff.ts           NEW — shared 429/rate-limit backoff, used by both PokeTrace adapters
        fixtures/                 market.fixtures.ts, ebay.fixtures.ts, catalogue.fixtures.ts

    db/                           D1 row types + thin typed query wrapper
```

Package boundaries: `packages/core` has ZERO dependency on `packages/providers`. `MarketDataProvider` and `CatalogueProvider` are the only interfaces business logic depends on for external data — swapping PokeTrace for PriceCharting/PkmnPrices/Cardmarket means adding one new adapter file per interface and one line in each registry (`packages/providers/src/market/registry.ts`, `packages/providers/src/catalogue/registry.ts`).

---

## 4. Canonical card model

Unchanged from the original design: a `CardPrinting` uniquely identifies an exact printing (game/name/set/set code/card number/year/language/edition/variant/finish/rarity/stampType), hashed deterministically (`printingHash`). `resolveCardPrinting()` never fills in a default for a missing/ambiguous field — an incomplete identity is flagged, never guessed.

**New in this realignment**: catalogue-sourced identities go through `packages/providers/src/catalogue/poketraceVariantMapping.ts`, which maps PokeTrace's 6-value `variant` enum (`Normal | Holofoil | Reverse_Holofoil | 1st_Edition | 1st_Edition_Holofoil | Unlimited`) onto our `edition`/`variant`/`finish` fields. **Known gap**: that enum has no concept of "shadowless" at all, so Base-Set-era shadowless-vs-unlimited-shadow can never be determined from catalogue data alone — every catalogue-sourced card gets `finish: "na"` from the mapping. The only place `finish` can be upgraded to `shadowless`/`unlimited_shadow` is eBay-listing-title reconciliation (`apps/worker/src/scan/titleParser.ts`), and only when the seller's title says so explicitly. Absent that, such listings correctly stay `REJECTED — CARD IDENTITY UNCERTAIN` rather than being guessed. Closing this properly would need a dedicated reference table of known split-print-run sets/card ranges — noted here as a real follow-up, not implemented in this pass.

`year` and `language` also aren't obviously present on PokeTrace's per-card payload: `year` is backfilled via a `setCode → year` lookup (`CatalogueProvider.fetchSets()`). **Changed in the year-optional fix**: `year` used to be a REQUIRED identity field, so a card whose set couldn't be resolved to a year was **skipped entirely** — dropped from the catalogue, not just missing a display field. Since year is descriptive metadata only (never part of pricing/grading, and a real PokeTrace gap — some real sets return `releaseDate: null`, e.g. "151"), `CardPrinting.year` is now `number | null` and `resolveCardPrinting()` no longer requires it: a card with an unresolvable year is still catalogued, with `year: null` stored (never fabricated). `cards.year` (D1) is nullable as of migration `0010_cards_year_nullable.sql`. `language` is currently **assumed `"EN"`** for every PokeTrace-catalogued card (PokeTrace's documented coverage is English-market TCG singles) — a documented assumption to verify against real data, not a per-card guess.

---

## 5. Market valuation policy + currency normalization

`market_snapshots` stores, per `printingHash` per `capturedAt`: `rawMarketPrice`, `rawQsv`, `psa7`..`psa10`, `confidence`, `liquidity`, `sourceProvider`, `sampleSize`, `priceTimestamp` — **always in GBP**. Active eBay listings are supply-side signal only, never written into `rawMarketPrice`.

**New in this realignment**: PokeTrace prices in USD (`market: "US"`) or EUR (`market: "EU"`), not GBP. `packages/core/src/market/currency.ts::convertToGbp()` normalizes every PokeTrace price at the adapter boundary (`PokeTraceProvider.ts`) using a static, settings-editable FX rate table (`fx_rates`, default `{GBP:1, USD:0.79, EUR:0.86}`). This is a deliberate v1 approximation, not a live feed — refresh it periodically via Settings. Everything downstream of the adapter (calc engine, scoring, market profiling, opportunity engine) continues to assume GBP throughout, unchanged.

Outlier rejection (IQR/median trimming, `packages/providers/src/market/outliers.ts`) still exists and is still tested, but the **real** PokeTrace `GET /cards/{id}` contract returns provider-side pre-aggregated tier statistics (avg/median/etc.), not a raw list of sold comps — so there is nothing for our own IQR trimming to run against for a live PokeTrace snapshot (`outliersExcluded` is always 0 from that adapter). The utility remains available for any future provider that does return raw comp lists, and for `MockMarketProvider`'s fixture-authored snapshots.

**Documented gap**: PokeTrace's OpenAPI spec defines `prices[source][tier]` as an open (`additionalProperties`) map with no enum and ships no example response bodies — so the *exact literal key strings* for the raw/ungraded tier and each PSA tier (e.g. `"raw"` vs `"ungraded"`; `"PSA_10"` vs `"PSA10"`) are **not confirmed** by primary documentation. `PokeTraceProvider.ts` does not hardcode a guessed literal; it searches a short, case-insensitive candidate list per tier and simply finds nothing if none match. **This must be spot-checked against one real authenticated response before relying on it in production** — consistent with "do not connect paid API credentials yet."

---

## 6. Calculation engine (`packages/core/src/calc`) — unchanged

Pure, side-effect-free functions, each independently unit tested. **Unchanged by this realignment** except one corrected constant:

- `acquisitionCost.ts`, `netSaleProceeds.ts`, `flipProfit.ts`, `gradingBasis.ts`, `gradeLadder.ts` — same formulas as before.
- `DEFAULT_FEE_SCHEDULE.gradingFeePsaRegular` corrected from **£25 to £65** (the previous UK PSA Regular assumption was wrong) — editable in Settings, seeded correctly in migration 0005.
- `scoring/flipScore.ts`, `scoring/gradeScore.ts` — same weighted 0–100 scores.
- `filters/predicates.ts` — same per-listing filter predicates.

---

## 7. CARD MARKET layer — market profiling (`packages/core/src/market`, NEW)

Two independent, pure profile computations run across **every** catalogued card with usable market data, **before** any eBay search:

- `computeFlipProfile()` — is this card worth flipping at all? Outputs raw market value, conservative QSV, liquidity/confidence, and `maxProfitableAcquisitionPrice`: the highest all-in acquisition cost that would still clear the global `minNetProfit`/`minReturnOnCapital` filters against this card's QSV (solved in closed form from the fee schedule). This is a **reference ceiling for prioritisation**, not a forecast for any real trade — a real trade's economics are only ever computed once an actual listing exists (`packages/core/src/opportunity`).
- `computeGradeProfile()` — is this card worth grading at all, assuming a reference acquisition at roughly its own raw market value? Outputs a reference graded basis/PSA ladder/break-even grade/PSA10 upside — again explicitly a **reference**, not a forecast.

A card passing its strategy's coarse eligibility thresholds (`settings.market_profile_settings`) becomes part of the **Dynamic Flip Universe** / **Dynamic Grade Universe** (`flip_profiles`/`grade_profiles` rows with `eligible = 1`). These thresholds are deliberately looser and separate from the dashboard's per-listing filters.

`packages/core/src/market/prioritization.ts::rankForEbaySearch()` then ranks universe members by score, potential absolute profit, liquidity, confidence, and staleness (time since last eBay search) — **eBay is never searched blindly across the whole catalogue**; only the top N (per `settings.ebay_scan_budget`) get searched each run.

---

## 8. Catalogue sync — self-bootstrapping (`apps/worker/src/catalogue`, NEW)

The application bootstraps its own `cards` table from an empty database — no manual seeding, no watchlist import. `runCatalogueSync()` (pure, injectable `CatalogueProvider` + `CatalogueSyncRepo`) enumerates a provider's full singles catalogue page by page, resolving each entry through the canonical card resolver and persisting both the `cards` row and its `external_card_refs` mapping (provider name + provider's own card ID + our internal `printingHash` — **the provider's own ID is stored explicitly, never inferred solely from `printingHash`**, since the real market API is looked up by provider ID).

Resumable by design: the checkpoint (`catalogue_sync_checkpoint`) is saved after **every page**, not just at the end of a run, so a mid-run crash loses at most the in-flight page. Bounded to `maxPagesPerRun` (`settings.catalogue_sync`) so one scheduled tick can't run forever on a large catalogue; the checkpoint only resets to "start over" once a run's pagination genuinely reaches the end (`hasMore: false`), which naturally converges to periodic full refreshes on a large catalogue without ever restarting progress early. Unit tested (`apps/worker/test/catalogueSync.test.ts`) against an in-memory fake repo for: empty-DB bootstrap, pagination, resume-after-a-thrown-failure, external-ID mapping, and skip-rather-than-guess behaviour for an unmappable variant (year-unresolvable sets are no longer skipped — see section 4).

**Multi-market external ref ambiguity (fix)**: card IDENTITY has no market dimension, but PokeTrace's catalogue does (`market: 'US' | 'EU'` per card). That means the SAME internal card can legitimately pick up more than one `external_card_refs` row from PokeTrace — one per market — and `findExternalRefForCard()` (`apps/worker/src/repo/externalCardRefsRepo.ts`) used to resolve that with a bare `LIMIT 1`, no `ORDER BY`: which market's pricing a card's profile got built from was an accident of SQLite's row order, and could change between runs. Fixed by: (1) migration `0011_external_card_refs_market.sql` — actually storing the `market` value per ref, instead of reading it off the catalogue DTO and discarding it (which is what the old code did); (2) an explicit, visible, settings-editable preference order (`settings.externalRefMarketPreference`, seeded by migration `0012` as `["EU","US"]`) that `findExternalRefForCard` orders by deterministically. **That default is a documented PLACEHOLDER** — EU-before-US is a starting guess appropriate for a UK-based business, not a rule confirmed against real data — see `POST /catalogue/sync-and-profile` below, which is the tool built specifically to get that real evidence (how often the ambiguity actually occurs, and which markets are actually involved) before the preference gets finalized.

**`POST /catalogue/sync-and-profile`** (`apps/worker/src/routes/catalogue.ts`): runs catalogue sync + market profiling (steps 1-2 of the pipeline, section 2) as one bounded, eBay-free call — never reaches step 3. Built for a controlled validation run against real PokeTrace data into a local D1 database (see `apps/worker/README.md` section 11) without spending eBay quota or touching any deployed database. Returns a diagnostic report: sync counts, `cardsWithNullYear` (real evidence for the year-optional fix above), and `multiMarketCards` (real evidence for the market-preference placeholder above — every internal card with more than one ref from the same provider, and which markets). The profiling step itself was extracted from `scanRunner.ts` into `apps/worker/src/scan/marketProfiling.ts::runMarketProfiling()` so both the full scan and this standalone diagnostic share one implementation.

**Real bug this endpoint caught immediately, against real `wrangler dev` + real D1** (never surfaced by the 170 unit tests, which run against in-memory fakes, never Miniflare/D1 — this project had NO test coverage that actually executes SQL through the D1 API before this): `upsertGradeProfile()` (`apps/worker/src/repo/marketProfilesRepo.ts`) built an `INSERT` with 20 `?` placeholders but only ever bound 19 values — its own `rawSampleSize` parameter was accepted but never included in the bound values. D1 rejects this outright (`Wrong number of parameter bindings for SQL query`), meaning **every grade-profile write had been silently failing since this function was written** — `grade_profiles` could never have been populated, in this session or any prior one, the moment this ran against a real D1 binding instead of a fake. Fixed by adding the missing `rawSampleSize` argument at its correct position. `upsertFlipProfile()` (the near-identical sibling function) did not have this bug. This is also why `apps/worker/README.md` section 11's validation flow is worth taking literally — it is the ONLY path in this codebase that has ever run the market-profiling write path against a real D1 binding at all, even with the mock provider.

**Also caught the same way**: (1) the pinned Wrangler version (3.86) can't parse this project's own `[assets] run_worker_first = [...]` array config at all (`wrangler dev` crashes outright) — that syntax needs Wrangler 4; bumped to `^4.127.1` and re-verified the full flow end-to-end after upgrading. (2) Wrangler environments do NOT inherit top-level `[vars]` — `[env.dev]` and `[env.live_local]` each need every `Env` var repeated explicitly, not just the ones that differ, or those vars are silently `undefined` in that environment. (3) **Local D1 persistence is keyed by `database_id`, not `database_name`** — `[env.dev]` and `[env.live_local]` originally shared the same placeholder `database_id`, so despite having different `database_name`s they were silently writing to the SAME local SQLite file (confirmed by inspecting `.wrangler/state/v3/d1/` directly — one file existed where two were expected), defeating the whole point of keeping mock-provider dev data separate from real ingested data. Fixed by giving each environment's `d1_databases` block a distinct placeholder `database_id`.

---

## 9. Opportunity engine — unchanged

`packages/core/src/opportunity/engine.ts::buildOpportunities(listings, snapshots, settings)` is the same pure function as before: listings + market snapshots + settings → `Opportunity[]`, each tagged with a state (`HIGH_CONFIDENCE_FLIP`, `GRADE_CANDIDATE`, `INSPECT_PHOTOS`, `WATCH`, `PASS`, `REJECTED_*`). This realignment changes **what feeds it** (a prioritised, catalogue-derived set of listings instead of a hand-curated target list) but not the engine itself or its 9 existing test files.

---

## 10. Forecast vs. realised economics — unchanged

`opportunities` stores forecast numbers only, immutable once acted on. `inventory`/`grading_submissions`/`grading_results`/`transactions` carry actuals. Market-profile "reference" numbers (section 7) are a third, explicitly-labelled category — never confused with either forecast or realised, since they're computed before any real listing exists.

---

## 11. API cost control

`api_usage` logs every outbound provider call (cache hit/miss, cost weight). `MarketSnapshotCache` (D1-backed, keyed by internal card ID, looked up by provider card ID) is the only place a market-data network call happens. **New**: `packages/providers/src/http/backoff.ts` gives both PokeTrace adapters (market + catalogue) shared 429/rate-limit backoff — respects `Retry-After`/`X-RateLimit-Reset`, capped retries, so a quota exhaustion event degrades a scan (partial results, logged errors) rather than hammering the API or crashing the run. Catalogue sync's `maxPagesPerRun` and eBay's `maxCardsSearchedPerRun`/`maxListingsPerCardSearch` (both in Settings) are the other two quota levers.

---

## 12. Auth & Deployment — unchanged

Cloudflare Access protects `mumwheresmycards.com/arbitrage*` at the edge; `apps/worker/src/middleware/auth.ts` verifies the JWT as defense-in-depth. Single Worker serves both API and built SPA. See `apps/worker/README.md` for full deployment steps. **Still not deployed, and still no real API credentials connected from this session** — `MARKET_PROVIDER`/`EBAY_PROVIDER` remain provider-name env vars; wiring real `POKETRACE_API_KEY`/eBay credentials and running `wrangler deploy` are explicitly deferred until the user says otherwise.

---

## 13. Known gaps to verify before going live

Listed here so they're never mistaken for confirmed behaviour:

1. ~~**PokeTrace `prices[source][tier]` exact key literals**~~ — **CONFIRMED** (2026-08-29) against a live authenticated call: the raw/ungraded tier is `"NEAR_MINT"`, and the four PSA tiers this project uses are `"PSA_7"`/`"PSA_8"`/`"PSA_9"`/`"PSA_10"` — see `PokeTraceProvider.ts`'s class doc-comment for the full smoke-test findings, including that `GET /cards/{id}` wraps its payload as `{ data: {...} }` (previously undocumented — fixed) and that each card carries its own `currency` field directly rather than needing to be derived from `market`. The real API also returns many other grading-tier keys (BGS/CGC/SGC/TAG, half-point PSA grades, condition tiers) this project doesn't use yet — see `apps/worker/scripts/poketrace-smoke-test.ts` for the full sanitized sample if those become relevant later.
2. ~~**PokeTrace catalogue response field names**~~ — **CONFIRMED** (2026-08-29) against two live calls, including one that actually paged. `id`/`name`/`cardNumber`/`variant`/`rarity`/`game`/`market`/`image`/`lastUpdated` all matched on the first try. `set` turned out to be an object `{ slug, name }`, not a flat string as originally guessed — this was a real bug (every real card's `setCode` was silently coming out as the literal text `"[object Object]"`), now fixed. The `pagination` object is `{ hasMore, nextCursor, count }`, nested under a top-level `pagination` key — the previous code read `nextCursor`/`hasMore` at the top level, which doesn't exist there, a real bug that would have made a catalogue sync silently stop after one page (`hasMore` always read as `false`). Verified across two real pages with no duplicate card ids. `GET /sets` returns the same `{ data, pagination }` envelope with real fields `slug`/`name`/`releaseDate`/`cardCount` — `fetchSets()` now pages through all of it (it previously only fetched page 1). PokeTrace returns `releaseDate: null` for at least some real sets (e.g. "151", "Ancient Origins") — this project does not fabricate a year for those; it stays `null` and (as of the year-optional fix, section 4/8) the card is still catalogued rather than skipped. All fixed in `PokeTraceCatalogueProvider.ts`; see `apps/worker/scripts/poketrace-catalogue-smoke-test.ts` for the full sanitized sample.
3. **Shadowless vs. unlimited-shadow detection** — impossible from PokeTrace catalogue data alone (see section 4); currently relies entirely on eBay listing titles.
4. **Assumed English-only PokeTrace catalogue coverage** — `language: "EN"` is applied to every catalogue-sourced card; verify this holds once real data is available.
5. **Static FX rates** — `fx_rates` is a manually-maintained table, not a live feed.
6. **PokeTrace's Scale-plan-gated `GET /cards/{id}/listings`** (individual sold listings) is not wired in — the market adapter uses only the aggregated `prices` object, which is available on lower plan tiers.
7. **`externalRefMarketPreference` default (`["EU","US"]`)** — a documented placeholder (section 8), not confirmed against real data. `POST /catalogue/sync-and-profile`'s `multiMarketCards` report is what should settle this: how often a card actually gets more than one provider ref, and which markets. Revisit once that's been run against real PokeTrace data.
