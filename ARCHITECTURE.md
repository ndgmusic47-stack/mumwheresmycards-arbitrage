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

`market_snapshots` stores, per `printingHash` per `capturedAt`: `rawMarketPrice`, `rawMedian7d`, `rawMedian30d`, `rawQsv`, `qsvBasis`, `psa6`..`psa10`, `confidence`, `liquidity`, `sourceProvider`, `sampleSize`, `priceTimestamp` — **always in GBP**. Active eBay listings are supply-side signal only, never written into `rawMarketPrice`.

### QSV — conservative executable sale value (`packages/core/src/market/qsv.ts`)

QSV is what we could actually realise reasonably quickly. It is explicitly NOT an asking-price estimate and NOT a headline market value:

```
QSV = min(7-day sold median, 30-day sold median) x (1 - quick-sale haircut)
```

with an 8% default haircut (`settings.qsv_settings`). Three rules make it conservative on purpose:

1. **Sold medians only.** Active eBay asking prices NEVER influence QSV — they are what sellers hope for, including the ones that never sell.
2. **Medians, not averages.** One mis-listed bundle or a graded card sold as raw moves an average and barely moves a median. The previous model fell back to `avg7d`/`avg` freely; the adapter now passes medians through untouched and refuses to substitute an average for one.
3. **Lower of two windows, then a haircut.** A card that has just spiked isn't valued at the spike, and liquidating promptly means pricing below the median, not at it.

When only one median exists, QSV is still produced but confidence is reduced. When neither exists, a broader market reference may be used but the result is flagged `isHighConfidenceQsv: false` and **a flip priced that way can never qualify** — it can only be watched. The underlying medians are stored raw so every QSV is auditable.

**New in this realignment**: PokeTrace prices in USD (`market: "US"`) or EUR (`market: "EU"`), not GBP. `packages/core/src/market/currency.ts::convertToGbp()` normalizes every PokeTrace price at the adapter boundary (`PokeTraceProvider.ts`) using a static, settings-editable FX rate table (`fx_rates`, default `{GBP:1, USD:0.79, EUR:0.86}`). This is a deliberate v1 approximation, not a live feed — refresh it periodically via Settings. Everything downstream of the adapter (calc engine, scoring, market profiling, opportunity engine) continues to assume GBP throughout, unchanged.

Outlier rejection (IQR/median trimming, `packages/providers/src/market/outliers.ts`) still exists and is still tested, but the **real** PokeTrace `GET /cards/{id}` contract returns provider-side pre-aggregated tier statistics (avg/median/etc.), not a raw list of sold comps — so there is nothing for our own IQR trimming to run against for a live PokeTrace snapshot (`outliersExcluded` is always 0 from that adapter). The utility remains available for any future provider that does return raw comp lists, and for `MockMarketProvider`'s fixture-authored snapshots.

**Documented gap**: PokeTrace's OpenAPI spec defines `prices[source][tier]` as an open (`additionalProperties`) map with no enum and ships no example response bodies — so the *exact literal key strings* for the raw/ungraded tier and each PSA tier (e.g. `"raw"` vs `"ungraded"`; `"PSA_10"` vs `"PSA10"`) are **not confirmed** by primary documentation. `PokeTraceProvider.ts` does not hardcode a guessed literal; it searches a short, case-insensitive candidate list per tier and simply finds nothing if none match. **This must be spot-checked against one real authenticated response before relying on it in production** — consistent with "do not connect paid API credentials yet."

---

## 6. Calculation engine (`packages/core/src/calc`, `packages/core/src/grading`) — REBUILT for the V1 commercial model

Pure, side-effect-free functions, each independently unit tested. **Every commercial assumption lives in Settings; nothing in this path hardcodes a fee, a grading price, a turnaround or a profit threshold.**

### 6.1 V1 exit market — eBay UK business seller

V1 assumes BOTH raw flips and graded exits sell through an eBay UK business seller account. The exit provider is modelled as data (`ExitMarketFeeModel`) so Cardmarket/Packrat/shows can be added later without touching calculation code, but no alternate exit is modelled yet.

`calc/fees.ts::computeSellingFees()` — seeded defaults in `settings.exit_market_fees`:

| Component | Default | Note |
|---|---|---|
| Variable final value fee | 10.9% | charged on the buyer's TOTAL payment |
| Regulatory operating fee | 0.35% | charged on the buyer's TOTAL payment |
| Per-order fee (above £10) | £0.40 | |
| Per-order fee (at/below £10) | £0.40 | published reference only defines the above-£10 fee; defaulting the lower band to the same value is deliberately conservative and configurable, not a claim about eBay's actual sub-£10 charge |
| Promoted Listings | 0% | opt-in per listing, never assumed |
| International selling fee | 0% | V1 assumes a UK buyer, UK exit |
| Fee VAT | 20% | see below |

**Two things this gets right that the previous model did not.** First, the fee base is the buyer's TOTAL payment (item price + buyer-paid postage), not the item price alone — eBay charges its variable fees on the whole sale including postage, so charging them on the item alone understated cost on every listing with postage. Second, **VAT on seller fees**: eBay publishes UK business fees EXCLUSIVE of VAT and charges 20% on top. Whether that is a real economic cost depends on the seller's own VAT position, so `sellerFeeVatRecoverable` decides, defaulting to **false** — the conservative reading that treats fee VAT as a genuine cost rather than flattering profit. This is VAT on the SELLER FEES only and is deliberately not any statement about VAT on the card sale itself (margin scheme, second-hand goods), which this project does not model.

**Superseded and removed**: the old `DEFAULT_FEE_SCHEDULE` carried a 13.25% final value fee, a £0.30 fixed order fee, a `paymentProcessingPct` field corresponding to no real eBay UK charge (managed payments are bundled into the FVF), no regulatory operating fee at all, and no VAT treatment. Migration 0013 marks the old `fee_schedule` settings row SUPERSEDED rather than deleting it, so historical forecasts stay interpretable.

### 6.2 Raw flip economics

```
TOTAL ACQUISITION      = item price + seller postage + import tax + other acquisition cost
EXPECTED BUYER PAYMENT = QSV item price + buyer-paid shipping
EBAY FEES              = FVF + regulatory fee + per-order fee + non-recoverable fee VAT
                         (+ promoted/international when configured)
NET SALE CASH          = buyer payment - eBay fees - outbound postage - insurance - packaging
TRUE NET PROFIT        = net sale cash - total acquisition
ROC                    = true net profit / total acquisition
PROFIT MARGIN          = true net profit / buyer payment      (revenue, not proceeds)
```

Also surfaced: expected days-to-sale (capital lock) and profit per £ of capital.

### 6.3 Grading economics — services and batches as DATA

`GradingService` rows (`settings.grading_services`) carry fee per card, estimated turnaround, and a USD declared-value cap:

| Service | Fee/card | Est. turnaround | Final-value cap |
|---|---|---|---|
| PSA Regular | £65 | ~75 business days | $1,500 |
| PSA Value | £23 | ~160 business days | $500 |

Turnaround figures are explicitly **estimates** — graders publish targets, not guarantees. When a grade's slab value exceeds the selected service's cap, the rung is flagged **POTENTIAL UPCHARGE** with a configurable reserve (`settings.upcharge_settings`); the exact escalation is not known before submission and is never presented as if it were.

**Batch logistics (`settings.grading_batch`)** — the correction that most changes which cards qualify. Submissions go out in batches (10 cards by default), so postage and insurance to and from the grader are shared:

```
PER-CARD SHARED LOGISTICS = (batch outbound + batch return + batch insurance) / batch size
TOTAL GRADED BASIS        = raw price + seller postage + import tax + other fees
                          + service fee + per-card shared logistics
                          + sleeve + Card Saver (genuine per-card consumables)
                          + upcharge reserve, where carried
```

The old model charged roughly £8 outbound + £7 return + £3 insurance to EVERY card — about £18/card against £4.70 at a 10-card batch. That ~£13 of phantom cost per card landed directly on the profit line at every grade and silently killed viable candidates.

### 6.4 Economic classification, not a single pass/fail bar

Requiring PSA 8 to be profitable throws away exactly the trades with the best payoff structures; inventing a grade probability and calling the result an expected value is worse. So `grading/classification.ts` classifies each candidate by the SHAPE of its economics (thresholds in `settings.grade_classification`):

- **DOWNSIDE PROTECTED** — PSA 7 already breaks even. The floor is covered and everything above is upside on a trade that doesn't lose. Receives a major scoring advantage.
- **BALANCED** — PSA 8 within a bounded loss (default −10% of basis) AND PSA 9 clearing `max(£40, 25% of basis)`.
- **ASYMMETRIC** — PSA 10 profit ≥ £500 AND PSA 10 gross ≥ 5× basis. Explicitly does **not** require PSA 8 or PSA 9 profitability. A discovery rule, not a buy recommendation; the downside is shown alongside it.

### 6.5 Required hit rate — the honest alternative to fake EV

We do not know this physical card's true PSA 10 probability, so the engine never displays an expected grading profit. `grading/requiredHitRate.ts` inverts the question instead:

```
required p  such that  p·psa10Profit + (1-p)·fallbackProfit = 0
            =>  p = -fallbackProfit / (psa10Profit - fallbackProfit)
```

Computed against both a PSA 9 and a PSA 8 fallback. Worked example: PSA 9 = −£50, PSA 10 = +£950 → **5%** — one 10 in twenty pays for the other nineteen. This is labelled **REQUIRED HIT RATE** everywhere it appears, never EXPECTED. Once real submission history exists it can be compared against empirical selection rates; that is a separate, evidence-backed feature.

### 6.6 Grade ladder

`calc/gradeLadder.ts` computes, per grade 6→10: gross slab value, selling fees, net proceeds, profit, ROC, and an upcharge flag — plus break-even grade and PSA 10 gross/net multiples. **Losing rungs are computed and displayed, never hidden.**

### 6.7 Profit vs capital velocity

The cheapest service is not automatically the best. `grading/serviceComparison.ts` evaluates every enabled service and surfaces both winners:

```
CAPITAL LOCK   = grading turnaround (business days -> calendar) + estimated time to sell
PROFIT/DAY     = profit at the reference grade / capital lock days
ANNUALISED ROC = ROC x (365 / capital lock days)      -- an INDICATOR, not a forecast return
```

A £23 service locking capital for 9 months regularly loses to a £65 service returning in 4. Both **best absolute profit** and **best capital velocity** are reported, and the dashboard flags when they differ — which constraint binds is the operator's call, so the engine shows both rather than choosing.

---

## 7. CARD MARKET layer — market profiling (`packages/core/src/market`, NEW)

Two independent, pure profile computations run across **every** catalogued card with usable market data, **before** any eBay search:

- `computeFlipProfile()` — is this card worth flipping at all? Outputs raw market value, conservative QSV, liquidity/confidence, and `maxProfitableAcquisitionPrice`: the highest all-in acquisition cost that would still clear the global `minNetProfit`/`minReturnOnCapital` filters against this card's QSV (solved in closed form from the fee schedule). This is a **reference ceiling for prioritisation**, not a forecast for any real trade — a real trade's economics are only ever computed once an actual listing exists (`packages/core/src/opportunity`).
- `computeGradeProfile()` — is this card worth grading at all, assuming a reference acquisition at roughly its own raw market value? Outputs a reference graded basis/PSA ladder/break-even grade/PSA10 gross multiple/economic class/required PSA10 rate/capital lock — again explicitly a **reference**, not a forecast. **Eligibility is decided by economic CLASSIFICATION, not by a break-even-grade cutoff**: the old model required break-even to beat a fixed grade, which discarded every asymmetric candidate (lower grades lose, PSA 10 exceptional) before a listing was ever seen — precisely the structure this business most wants to find. It also evaluates every enabled service and keeps the strongest structure any of them produces, since a card can be DOWNSIDE PROTECTED on one service and unclassified on another.

A card passing its strategy's coarse eligibility thresholds (`settings.market_profile_settings`) becomes part of the **Dynamic Flip Universe** / **Dynamic Grade Universe** (`flip_profiles`/`grade_profiles` rows with `eligible = 1`). These thresholds are deliberately looser and separate from the dashboard's per-listing filters.

`packages/core/src/market/prioritization.ts::rankForEbaySearch()` then ranks universe members by score, potential absolute profit, liquidity, confidence, and staleness (time since last eBay search) — **eBay is never searched blindly across the whole catalogue**; only the top N (per `settings.ebay_scan_budget`) get searched each run.

---

## 8. Catalogue sync — self-bootstrapping (`apps/worker/src/catalogue`, NEW)

The application bootstraps its own `cards` table from an empty database — no manual seeding, no watchlist import. `runCatalogueSync()` (pure, injectable `CatalogueProvider` + `CatalogueSyncRepo`) enumerates a provider's full singles catalogue page by page, resolving each entry through the canonical card resolver and persisting both the `cards` row and its `external_card_refs` mapping (provider name + provider's own card ID + our internal `printingHash` — **the provider's own ID is stored explicitly, never inferred solely from `printingHash`**, since the real market API is looked up by provider ID).

Resumable by design: the checkpoint (`catalogue_sync_checkpoint`) is saved after **every page**, not just at the end of a run, so a mid-run crash loses at most the in-flight page. Bounded to `maxPagesPerRun` (`settings.catalogue_sync`) so one scheduled tick can't run forever on a large catalogue; the checkpoint only resets to "start over" once a run's pagination genuinely reaches the end (`hasMore: false`), which naturally converges to periodic full refreshes on a large catalogue without ever restarting progress early. Unit tested (`apps/worker/test/catalogueSync.test.ts`) against an in-memory fake repo for: empty-DB bootstrap, pagination, resume-after-a-thrown-failure, external-ID mapping, and skip-rather-than-guess behaviour for an unmappable variant (year-unresolvable sets are no longer skipped — see section 4).

**Multi-market external ref ambiguity (fix)**: card IDENTITY has no market dimension, but PokeTrace's catalogue does (`market: 'US' | 'EU'` per card). That means the SAME internal card can legitimately pick up more than one `external_card_refs` row from PokeTrace — one per market — and `findExternalRefForCard()` (`apps/worker/src/repo/externalCardRefsRepo.ts`) used to resolve that with a bare `LIMIT 1`, no `ORDER BY`: which market's pricing a card's profile got built from was an accident of SQLite's row order, and could change between runs. Fixed by: (1) migration `0011_external_card_refs_market.sql` — actually storing the `market` value per ref, instead of reading it off the catalogue DTO and discarding it (which is what the old code did); (2) an explicit, visible, settings-editable preference order (`settings.externalRefMarketPreference`, seeded by migration `0012` as `["EU","US"]`) that `findExternalRefForCard` orders by deterministically. **That default is a documented PLACEHOLDER** — EU-before-US is a starting guess appropriate for a UK-based business, not a rule confirmed against real data — see `POST /catalogue/sync-and-profile` below, which is the tool built specifically to get that real evidence (how often the ambiguity actually occurs, and which markets are actually involved) before the preference gets finalized.

**`POST /catalogue/sync-and-profile`** (`apps/worker/src/routes/catalogue.ts`): runs catalogue sync + market profiling (steps 1-2 of the pipeline, section 2) as one bounded, eBay-free call — never reaches step 3. Built for a controlled validation run against real PokeTrace data into a local D1 database (see `apps/worker/README.md` section 11) without spending eBay quota or touching any deployed database. Returns a diagnostic report: sync counts, `cardsWithNullYear` (real evidence for the year-optional fix above), and `multiMarketCards` (real evidence for the market-preference placeholder above — every internal card with more than one ref from the same provider, and which markets). The profiling step itself was extracted from `scanRunner.ts` into `apps/worker/src/scan/marketProfiling.ts::runMarketProfiling()` so both the full scan and this standalone diagnostic share one implementation.

**Real bug this endpoint caught immediately, against real `wrangler dev` + real D1** (never surfaced by the 170 unit tests, which run against in-memory fakes, never Miniflare/D1 — this project had NO test coverage that actually executes SQL through the D1 API before this): `upsertGradeProfile()` (`apps/worker/src/repo/marketProfilesRepo.ts`) built an `INSERT` with 20 `?` placeholders but only ever bound 19 values — its own `rawSampleSize` parameter was accepted but never included in the bound values. D1 rejects this outright (`Wrong number of parameter bindings for SQL query`), meaning **every grade-profile write had been silently failing since this function was written** — `grade_profiles` could never have been populated, in this session or any prior one, the moment this ran against a real D1 binding instead of a fake. Fixed by adding the missing `rawSampleSize` argument at its correct position. `upsertFlipProfile()` (the near-identical sibling function) did not have this bug. This is also why `apps/worker/README.md` section 11's validation flow is worth taking literally — it is the ONLY path in this codebase that has ever run the market-profiling write path against a real D1 binding at all, even with the mock provider.

**Caught the same way, in the V1 commercial-model rebuild — a scan-killing foreign key**: an eBay search for one card routinely returns others, so a listing can resolve cleanly to a printing that simply is not in our catalogue. `opportunities.card_id` is a foreign key into `cards`, so writing one of those raised `D1_ERROR: FOREIGN KEY constraint failed` — which propagated out of the candidate loop and **failed the ENTIRE scan run on the first such listing**, returning a bare 500. In production that is the normal case, not an edge case: the catalogue is always a subset of what is for sale. Fixed in two places: `upsertOpportunity()` now checks the printing is catalogued and returns `skipped_uncatalogued_card` instead of attempting the insert (the same guard protects the `ebay_listings.card_id` update, which has the identical foreign key), and `scanRunner.ts` wraps each candidate's persistence so one unpersistable listing can never take the run down. Both counts surface in the scan summary. Regression-guarded in `apps/worker/test/sqlParameterParity.test.ts`. Found by running the real pipeline against real `wrangler dev` + real D1 — no unit test against fakes could have found it, because fakes have no foreign keys.

**Also caught the same way**: (1) the pinned Wrangler version (3.86) can't parse this project's own `[assets] run_worker_first = [...]` array config at all (`wrangler dev` crashes outright) — that syntax needs Wrangler 4; bumped to `^4.127.1` and re-verified the full flow end-to-end after upgrading. (2) Wrangler environments do NOT inherit top-level `[vars]` — `[env.dev]` and `[env.live_local]` each need every `Env` var repeated explicitly, not just the ones that differ, or those vars are silently `undefined` in that environment. (3) **Local D1 persistence is keyed by `database_id`, not `database_name`** — `[env.dev]` and `[env.live_local]` originally shared the same placeholder `database_id`, so despite having different `database_name`s they were silently writing to the SAME local SQLite file (confirmed by inspecting `.wrangler/state/v3/d1/` directly — one file existed where two were expected), defeating the whole point of keeping mock-provider dev data separate from real ingested data. Fixed by giving each environment's `d1_databases` block a distinct placeholder `database_id`.

---

## 9. Opportunity engine — QUALIFICATION FIRST, SCORE ONLY RANKS

`packages/core/src/opportunity/engine.ts::buildOpportunities(listings, snapshots, settings)` is still a pure function, but its order of operations is now the point:

1. Resolve card identity (unchanged — never guesses a missing field).
2. Compute REAL ECONOMICS from the fee model, QSV model and grade ladder.
3. **QUALIFY** on those economics alone (`packages/core/src/filters/predicates.ts`).
4. **SCORE**, purely to rank what already qualified.

**Step 4 can never promote or demote across step 3.** Previously a candidate that cleared every economic filter still had to beat a hardcoded score threshold (70 for flips, 60 for grades) before it was labelled an opportunity — an arbitrary weighted blend was silently vetoing real trades. That is gone. Score is a 0–100 ordering signal and nothing else.

**Raw flip qualification** (`settings.flip_qualification`): TRUE NET PROFIT ≥ £40 **AND** ROC ≥ 40% — both required. A £12 profit at 80% ROC does not qualify (percentage alone never rescues a trivial flip); £45 at 5% ROC does not qualify either. Plus max acquisition, min QSV, min liquidity/confidence, max days-to-sale, and a hard requirement that QSV came from sold medians rather than a fallback reference.

**Grade qualification** (`settings.grade_qualification`): the economic CLASS is the primary gate — all three classes enabled by default so asymmetric opportunities are discovered rather than filtered away — plus guardrails on raw acquisition, graded basis, PSA 10 value/profit/multiple, PSA 9 profit, PSA 8 loss %, break-even grade, max required PSA 10 rate, capital lock, and which graders/services are enabled. Rules set to `null` are simply not applied.

States now describe qualification, not score: `QUALIFIED_FLIP`, `QUALIFIED_GRADE`, `INSPECT_PHOTOS` (qualifies, but identity needs photo verification), `WATCH` (real economics computed, doesn't clear the bar — kept and shown, with every failing rule listed), `NO_MARKET_DATA`, `REJECTED_CARD_IDENTITY_UNCERTAIN`.

**Graders** are architected for several but enabled deliberately: **PSA enabled**; **BGS and CGC supported but DISABLED** until sold-slab pricing, liquidity and exact grade-tier mapping are validated for them. Cheap grading is never a reason to enable a grader — the objective is resale profit, not the cheapest slab.

---

## 10. Forecast vs. realised economics

`opportunities` stores forecast numbers only. **The forecast is frozen at purchase**: `inventory.forecast_snapshot` holds a JSON copy of the opportunity exactly as forecast when the money was committed, so realised performance is always compared against what we actually believed at decision time — never against a forecast quietly recomputed later against newer market data.

`packages/core/src/realised/realisedEconomics.ts` computes actuals: real net profit, real ROC, days capital was locked, profit per day, and forecast-vs-realised variance on each. Marketplace fees use the ACTUAL payout figures when available and are flagged `feesWereEstimated` when they had to be recomputed from the fee model — a realised number is never silently a forecast.

`allocateBatchCost()` handles the grading subtlety: at forecast time a card carries an estimated share of an assumed 10-card batch; once a real submission goes out, the ACTUAL batch cost is divided across the cards actually in it. A batch that went out with 6 instead of 10 costs more per card, and the realised numbers say so.

Market-profile "reference" numbers (section 7) remain a third, explicitly-labelled category — never confused with either forecast or realised, since they are computed before any real listing exists.

---

## 11. API cost control

`api_usage` logs every outbound provider call (cache hit/miss, cost weight). `MarketSnapshotCache` (D1-backed, keyed by internal card ID, looked up by provider card ID) is the only place a market-data network call happens. **New**: `packages/providers/src/http/backoff.ts` gives both PokeTrace adapters (market + catalogue) shared 429/rate-limit backoff — respects `Retry-After`/`X-RateLimit-Reset`, capped retries, so a quota exhaustion event degrades a scan (partial results, logged errors) rather than hammering the API or crashing the run. Catalogue sync's `maxPagesPerRun` and eBay's `maxCardsSearchedPerRun`/`maxListingsPerCardSearch` (both in Settings) are the other two quota levers.

---

## 12. Auth & Deployment — unchanged

Cloudflare Access protects `mumwheresmycards.com/arbitrage*` at the edge; `apps/worker/src/middleware/auth.ts` verifies the JWT as defense-in-depth. Single Worker serves both API and built SPA. See `apps/worker/README.md` for full deployment steps. **Still not deployed, and still no real API credentials connected from this session** — `MARKET_PROVIDER`/`EBAY_PROVIDER` remain provider-name env vars; wiring real `POKETRACE_API_KEY`/eBay credentials and running `wrangler deploy` are explicitly deferred until the user says otherwise.

---

## 13. Known gaps to verify before going live

- **The eBay UK fee figures are commercial assumptions, not verified rates.** 10.9% FVF, 0.35% regulatory operating fee, £0.40 per-order and 20% fee VAT are seeded in `settings.exit_market_fees` from a current reference; confirm them against an actual eBay business seller fee statement before trusting forecast profit to the penny. The sub-£10 per-order fee is deliberately set equal to the above-£10 fee (conservative) rather than guessed.
- **`sellerFeeVatRecoverable` defaults to false.** If the business is VAT registered and reclaims input VAT on marketplace fees, flip it in Settings — it moves every profit figure.
- **Grading turnaround figures are estimates.** ~75 and ~160 business days are published targets, not guarantees; actuals routinely run longer, and capital-lock/velocity metrics inherit that uncertainty.
- **The declared-value upcharge reserve (£40) is an estimate.** The real escalation is unknown before submission — the engine flags POTENTIAL UPCHARGE rather than pretending to price it.
- **Batch assumptions (10 cards, £15/£20/£12) are planning figures.** Replace with actual batch costs once a real submission happens; `allocateBatchCost()` exists for exactly that.
- **The classification thresholds are starting points**: PSA 7 ≥ £0 for downside protection, −10% of basis for a balanced PSA 8, `max(£40, 25%)` for a balanced PSA 9, £500/5× for asymmetric. All editable; none validated against realised outcomes yet, because there are no realised outcomes yet.
- **No grading probability data exists.** Required hit rates are honest arithmetic, but nothing in the system knows how often these cards actually gem. Our own submission history is the only defensible source, and it does not exist yet.
- **`externalRefMarketPreference` default `["EU","US"]` remains an unconfirmed placeholder** — needs the real-data evidence from `POST /catalogue/sync-and-profile`.
- **BGS and CGC are disabled**, and should stay disabled until raw-to-grade pricing, sold slab pricing, liquidity and exact grade-tier mapping are validated for each.
- **PokeTrace tier key literals** for PSA 6 in particular are inferred from the same candidate-list pattern as 7-10 and not confirmed against a live response containing a PSA 6 tier.
- **Not deployed.** Placeholder `database_id`/`CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` remain; run the section 11 validation flow clean first.
- **Import tax and "other acquisition fees" are silently £0 in every forecast (scan-time) opportunity — RELEASE HARDENING finding, 2026-09-03.** `computeAcquisitionCost()`/`gradingBasis.ts`/`maxBuySolver.ts` all correctly ADD `importTax`/`acquisitionFees` when present (see TOTAL ACQUISITION / TOTAL GRADED BASIS above), and `ListingCandidate.importTax`/`.acquisitionFees` (packages/core/src/opportunity/types.ts) exist as real, honoured optional fields — but nothing in the live pipeline ever POPULATES them: no eBay provider field maps to either, and scanRunner.ts's `listingCandidates.push({...})` never sets them, so every forecast simply defaults both to £0 via `?? 0`. That is a legitimate default for a UK-domestic purchase with no extra fees, but for any listing from a non-UK seller — genuinely common on eBay for Pokémon singles — real UK import VAT (typically 20%) and/or customs duty is a real cost this app is not forecasting at all, and the dashboard/detail page currently show no indication that the figure is an assumed zero rather than a computed one. The ONLY place either field is ever populated today is `actual_import_tax`/`actual_other_acquisition_fees` on the `inventory` table (`apps/worker/src/routes/inventory.ts`), entered by hand AFTER a real purchase, for realised-economics reconciliation — never fed back into forecasting. Closing this properly (an HMRC import-VAT/duty estimate keyed on seller location, or at minimum a visible "assumes £0 import tax" caveat on every forecast row) is real follow-up work, deliberately NOT implemented in this pass — flagging it here rather than leaving it silently invisible is the fix this pass DOES make.
  - **UPDATE, MWMC V1 FINAL SHIP PASS item 10, 2026-09-03: the visible caveat above is now built**, deliberately as a UI-only warning rather than a computed HMRC estimate (still real follow-up work, still not done). `ebay_listings.location_country` — eBay's own structured seller/item location, already captured since the original Browse integration but never joined into the opportunities feed — is now selected as `listing_location_country` (`apps/worker/src/routes/opportunities.ts`) and rendered as a prominent **"IMPORT COST NOT MODELLED — VERIFY BEFORE BUYING"** tag whenever it's present and not `"GB"` (`NonUkImportWarning` in `apps/web/src/components/OpportunityTable.tsx`, and a matching banner on the opportunity detail page). A null/unknown location is deliberately left unflagged rather than guessed at, consistent with this codebase's standing "no signal is not a confirmation" discipline elsewhere (`listingStructure.ts`) — so this warning is a real, evidence-based signal wherever it fires, not a blanket disclaimer, but it will not catch every non-UK listing eBay didn't report a location for.
