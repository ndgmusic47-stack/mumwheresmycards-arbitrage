# Mum Where's My Cards — Arbitrage Engine
## Architecture (v1)

Private application at `mumwheresmycards.com/arbitrage`. V1 scope: **underpriced raw card flips** and **raw → PSA grading candidates**. Architected so new-release flipping/holding and additional market/grading providers can be added later without rewrites.

---

## 1. High-level shape

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
│  scheduled()  ──▶  ScanRunner ──▶ OpportunityEngine                 │
│                                     │        │                       │
│                          ┌──────────┘        └──────────┐            │
│                          ▼                              ▼            │
│              MarketDataProvider (iface)      EbayListingsProvider    │
│                          │                    (iface)                 │
│              ┌───────────┴───────────┐            │                   │
│              ▼                       ▼            ▼                   │
│      PokeTraceProvider      (future: PriceCharting,   EbayBrowseProvider
│      (impl)                  Cardmarket, PkmnPrices)   (impl)          │
│                                                                       │
│  fetch() ──▶ Hono router ──▶ /api/* (opportunities, cards, filters,   │
│              inventory, transactions, grading, settings, scan-runs)  │
│              + CF Access JWT verification middleware                 │
│              + static asset serving for apps/web build (SPA)         │
└───────────────────────────────┬───────────────────────────────────┘
                                 │ D1 (SQL, bound as DB)
                                 ▼
                        Cloudflare D1 (SQLite)
                        cards, market_snapshots, ebay_listings,
                        opportunities, inventory, transactions,
                        grading_submissions, grading_results,
                        settings, scan_runs, api_usage
```

React SPA (`apps/web`) is built as static assets and served by the same Worker (Workers Static Assets) under `/arbitrage/*`, calling the Worker's `/api/*` JSON endpoints. Everything sits behind Cloudflare Access — no public data.

---

## 2. Monorepo layout

```
mumwheresmycards/
  package.json                 (pnpm workspace root)
  pnpm-workspace.yaml
  tsconfig.base.json
  vitest.workspace.ts
  ARCHITECTURE.md
  README.md
  .env.example

  apps/
    worker/                    Cloudflare Worker (API + cron + static asset host)
      src/
        index.ts               fetch()/scheduled() entry
        router.ts               Hono app, route registration
        routes/                 opportunities.ts, cards.ts, inventory.ts,
                                transactions.ts, grading.ts, settings.ts, scan-runs.ts
        middleware/auth.ts      Cloudflare Access JWT verification
        scan/scanRunner.ts      orchestrates one scan run
        env.ts                  typed Env bindings
      wrangler.toml
      migrations/               D1 SQL migrations (numbered)

    web/                        React + Vite SPA
      src/
        pages/ (Dashboard, OpportunityDetail, Watchlist, Inventory, Pipeline)
        components/ (OpportunityTable, FilterBar, ScoreBadge, GradeLadder, ...)
        api/client.ts
        state/filters.ts
      vite.config.ts

  packages/
    core/                       Pure business logic, framework-free, heavily tested
      src/
        card/                   canonical card model + resolver
        calc/                   cost & profit calculation engine
        scoring/                FLIP SCORE / GRADE SCORE
        filters/                opportunity filter predicates
        opportunity/            opportunity engine (pure functions)
        types.ts
      test/                     vitest specs mirroring src/ 1:1

    providers/                  External data provider abstractions + implementations
      src/
        market/
          MarketDataProvider.ts     interface
          PokeTraceProvider.ts      real impl (PokeTrace API)
          MockMarketProvider.ts     fixture-backed impl for local/dev/tests
          cache.ts                  D1-backed snapshot cache
        ebay/
          EbayListingsProvider.ts   interface
          EbayBrowseProvider.ts     real impl (eBay Browse API, OAuth)
          MockEbayProvider.ts       fixture-backed impl
        fixtures/                   canned JSON fixtures for both providers
        apiUsage.ts                 shared API-call accounting helper

    db/                         D1 schema source of truth + typed query helpers
      schema.sql                (generated concatenation of migrations, for reference)
      client.ts                 thin typed wrapper over D1 prepared statements
      types.ts                  row types matching schema
```

Package boundaries enforce the two abstraction requirements from the spec:
- **Market data**: `packages/providers/src/market/MarketDataProvider.ts` is the only interface `packages/core` and `apps/worker` depend on. Swapping PokeTrace for PriceCharting/PkmnPrices/Cardmarket later means adding a new class implementing the same interface and changing one line of provider wiring (`apps/worker/src/env.ts` / a `providerRegistry.ts`). No business logic references PokeTrace by name outside `PokeTraceProvider.ts`.
- **eBay**: same pattern via `EbayListingsProvider`. The Browse API is one implementation; `MockEbayProvider` (fixture-backed) is the default for local dev and all `packages/core` tests.

---

## 3. Canonical card model

A `CardPrinting` uniquely identifies an exact printing:

```ts
interface CardPrinting {
  game: 'pokemon';
  name: string;              // "Charizard"
  setName: string;           // "Base Set"
  setCode: string;           // "BS", "BS2" (shadowless), etc — set code alone is NOT enough
  cardNumber: string;        // "4/102"
  year: number;
  language: Language;        // EN, JA, FR, DE, ...
  edition: Edition;          // '1st' | 'unlimited' | 'na'
  variant: Variant;          // 'normal' | 'holo' | 'reverse_holo' | 'stamped' | 'promo'
  finish: Finish;            // 'shadowless' | 'unlimited_shadow' | 'na' (Base Set specific
                              // distinction, modeled generically as a "printRun" tag)
  rarity: string;
  stampType?: string;        // e.g. "Cosmos Holo Stamp", staff/prerelease stamp, etc.
  printingHash: string;      // deterministic hash of the above, = canonical identity key
}
```

`resolveCardPrinting()` in `packages/core/src/card/resolver.ts` takes raw identity fields (from a market provider match or an eBay listing's best-guess parse) and produces a `printingHash`. **Nothing downstream compares by name+number alone** — every join between a listing, a market snapshot, and an opportunity is keyed on `printingHash`. Distinct variants (1st/unlimited, shadowless/unlimited, holo/non-holo/reverse/stamped, promo/set, language, copyright year) always hash differently, by construction — the resolver refuses to fill in a default for an ambiguous field; ambiguous listings are flagged `REJECTED — CARD IDENTITY UNCERTAIN` rather than silently merged.

---

## 4. Market valuation policy

`market_snapshots` stores, per `printingHash` per `capturedAt`: `rawMarketPrice`, `rawQsv`, `psa7`..`psa10`, `confidence` (0–1), `liquidity` (enum), `sourceProvider`, `sampleSize`, `priceTimestamp`. Active eBay listings (`ebay_listings`) are supply-side signal only — used for acquisition price and to compute listing density (a liquidity input), **never** written into `rawMarketPrice`. Outlier rejection (IQR/median-based trimming) happens inside the provider adapter before a snapshot is persisted, documented in `packages/providers/src/market/outliers.ts`.

---

## 5. Calculation engine (`packages/core/src/calc`)

Pure, side-effect-free functions, each independently unit tested:

- `acquisitionCost.ts` — purchase price + postage + import/tax + acquisition fees → `TotalAcquisitionCost`
- `netSaleProceeds.ts` — QSV − marketplace fees − payment costs − outbound postage − insurance − packaging → `ExpectedNetSaleProceeds`
- `flipProfit.ts` — net profit, ROC, margin, from the two above
- `gradingBasis.ts` — raw purchase + postage + packaging + sleeve + card saver + insured grading postage allocation + grading fee + return shipping + insurance + upcharge reserve → `TotalGradedBasis`
- `gradeLadder.ts` — net proceeds & profit at PSA 6/7/8/9/10 from `TotalGradedBasis` + per-grade market prices; break-even grade = lowest grade where profit ≥ 0
- `scoring/flipScore.ts`, `scoring/gradeScore.ts` — weighted 0–100 scores, weights defined in `settings` (DB-configurable, defaults match the spec)
- `filters/predicates.ts` — pure predicate functions for every filter in the spec, composable, used identically by the engine (server-side default filter) and by the dashboard's "explain why filtered" view

All of this is provider-agnostic: it takes plain numbers/enums in, never touches `fetch` or D1.

---

## 6. Opportunity engine

`packages/core/src/opportunity/engine.ts::buildOpportunities(listings, snapshot, settings)` is a pure function: listings + market snapshot + settings → `Opportunity[]`, each tagged with a state (`HIGH CONFIDENCE FLIP`, `GRADE CANDIDATE`, `INSPECT PHOTOS`, `WATCH`, `PASS`, `REJECTED — ...`). `apps/worker/src/scan/scanRunner.ts` is the only place that wires real providers + D1 persistence around this pure function, so the engine is trivially testable with fixtures and trivially reusable when new strategies (new-release flip/hold) are added later — a new engine module plugs into the same `Opportunity` shape and `scan_runs` bookkeeping.

---

## 7. Forecast vs. realised economics

`opportunities` stores forecast numbers only, immutable once an opportunity is acted on. `inventory` rows reference an `opportunity_id` and carry **actual** acquisition cost once purchased. `grading_submissions`/`grading_results` carry actual grading cost/turnaround/grade. `transactions` carries actual sale price/fees/shipping/insurance/packaging and computes real cash proceeds, real net profit, real ROC, days held. Nothing overwrites a forecast field — realised data lives in separate rows/tables, joined for analytics (predicted vs. realised views are SQL views over these tables, added once inventory/transactions have data).

---

## 8. API cost control

`api_usage` table logs every outbound call (provider, endpoint, cost-weight, timestamp, cache hit/miss). `packages/providers/src/market/cache.ts` checks D1 for a fresh-enough snapshot (configurable TTL per data class — listings refresh far more often than slow-moving card metadata) before calling a provider. `apiUsage.ts` wraps every provider call to record it, giving the settings/API-spend dashboard a real ledger instead of an estimate.

---

## 9. Auth

Cloudflare Access is configured at the Cloudflare dashboard/Terraform level to protect the `mumwheresmycards.com/arbitrage*` route (not application code). The Worker additionally verifies the `Cf-Access-Jwt-Assertion` header against the Access team domain's JWKS in `apps/worker/src/middleware/auth.ts` as defense-in-depth and to extract the authenticated identity for audit fields — so the app is never reliant on network-edge config alone if it's ever exposed on a different route.

---

## 10. Deployment

Single Worker serves both the API and the built SPA (Workers static assets), deployed via `wrangler deploy` from `apps/worker`. D1 database + migrations applied via `wrangler d1 migrations apply`. Cron Trigger declared in `wrangler.toml`. Custom domain route `mumwheresmycards.com/arbitrage*` bound to the Worker (documented in `apps/worker/README.md`).

---

## 11. Build order (this session)

1. Repo scaffold & tooling
2. D1 schema/migrations
3. `.env.example` / `wrangler.toml` template
4. Canonical card model
5. Calculation engine + tests
6. Market provider abstraction + PokeTrace + mock
7. eBay provider abstraction + mock
8. Opportunity engine (+ tests)
9. Worker API + dashboard
10. Cron scan wiring
11. Access auth middleware
12. Deployment docs
13. Full test run
