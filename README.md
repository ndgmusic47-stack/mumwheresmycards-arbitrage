# Mum Where's My Cards — Arbitrage Engine

Private application at `mumwheresmycards.com/trade` that automatically discovers profitable Pokémon card opportunities across the **whole** singles market — no manual per-card selection. V1 covers two strategies:

1. **Underpriced raw card flips**
2. **Raw → PSA grading candidates**

New-release flipping/holding is intentionally out of scope for v1 but the architecture (provider abstractions, opportunity engine, `Opportunity` states/scoring) is built to add it later without a rewrite — see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

The application bootstraps and keeps its own card catalogue in sync automatically (`apps/worker/src/catalogue`), computes a Dynamic Flip Universe and Dynamic Grade Universe from market data alone (`packages/core/src/market`), and only then searches eBay — prioritised, budget-bounded, never blind — for supply on the cards that universe says are worth checking. See `ARCHITECTURE.md` section 1 for the three-layer model (CARD MARKET / LIVE SUPPLY / OPPORTUNITY) this is built around.

## Repository layout

```
apps/worker    Cloudflare Worker — API, catalogue sync, cron-triggered scans, static asset host, Cloudflare Access auth
apps/web       React + Vite dashboard SPA (Opportunities / Flips / Grade / Market / Inventory / Pipeline)
packages/core        Pure business logic: canonical card model, cost/profit calc engine, scoring, filters, opportunity engine, CARD MARKET profiling
packages/providers    Market data (PokeTrace + mock) + catalogue (PokeTrace + mock) + eBay (Browse API + mock) provider abstractions, D1-backed caching, API usage accounting, shared 429 backoff
packages/db           D1 row types + a thin typed query wrapper
```

Full design rationale: [`ARCHITECTURE.md`](./ARCHITECTURE.md). Deployment steps: [`apps/worker/README.md`](./apps/worker/README.md).

## Getting started

```bash
pnpm install
pnpm test          # full financial-engine + provider test suite (mocked, no network/API keys needed)
pnpm typecheck      # composite TypeScript build across all packages
```

The financial engine (`packages/core/src/calc`, `scoring`, `filters`, `opportunity`) and the provider abstractions (`packages/providers`) are fully covered by fixture/mock-backed tests — see `packages/*/test`. Nothing in `pnpm test` touches a real network or requires API keys, by design (see `ARCHITECTURE.md` and the "Build process" instructions this project follows: provider mocks come before paid API integration).

To run the full stack locally (dashboard + API against local D1, using mock providers by default):

```bash
pnpm migrate:local     # apply D1 migrations to a local Miniflare SQLite DB
pnpm dev:worker        # http://127.0.0.1:8787
pnpm dev:web           # http://127.0.0.1:5173/trade (proxies /trade/api to the worker)
```

## Status

| Area | Status |
|---|---|
| Canonical card model + resolver | Done, tested |
| Cost/profit calculation engine | Done, tested — PSA Regular fee corrected to £65 |
| CARD MARKET profiling (Dynamic Flip/Grade Universe) | Done, tested (`packages/core/src/market`) |
| GBP currency normalization (PokeTrace prices in USD/EUR) | Done, tested — static v1 FX table, editable in Settings |
| Market data provider abstraction (PokeTrace + mock) | Rewritten against PokeTrace's real, verified API contract; ID-based lookup; tested |
| Catalogue provider abstraction (PokeTrace + mock) | New — paginated enumeration + set metadata, tested |
| Resumable, self-bootstrapping catalogue sync | New — empty-DB bootstrap, pagination, resume-after-failure all tested (`apps/worker/test/catalogueSync.test.ts`) |
| Prioritised, budget-bounded eBay search | New — ranks Dynamic Flip/Grade Universe members by score/profit/liquidity/confidence/staleness, tested |
| eBay provider abstraction (Browse API + mock) | Unchanged, tested |
| Opportunity engine (scoring, states, filters) | Unchanged, tested — all 9 original test files still passing |
| D1 schema + migrations (0001–0009) | Done — adds `external_card_refs`, `catalogue_sync_runs`/`checkpoint`, `flip_profiles`/`grade_profiles`, FX/sync/budget settings |
| Worker API (opportunities, market, catalogue, cards, inventory, transactions, grading, settings, scan-runs, watchlist) | Done |
| Scheduled scans (Cloudflare Cron Triggers) | Done — now runs catalogue sync → market profiling → prioritised eBay search → opportunity engine each tick |
| Cloudflare Access auth (edge policy + JWT verification) | Documented + middleware implemented — Access application itself is configured in the Cloudflare dashboard, not in code |
| Dashboard (React) | Done — new primary nav (Opportunities/Flips/Grade/Market/Inventory/Pipeline), new Market tab, live summary stats header |
| Deployment | Documented in `apps/worker/README.md`; still not deployed to a live Cloudflare account from this session |

Real PokeTrace/eBay credentials have not been integrated or tested against live APIs from this session — the market and catalogue providers are implemented against PokeTrace's real, documented OpenAPI contract (not guessed) and exercised only through their fixture-backed mock implementations. A small number of response-shape details remain genuinely unconfirmed by PokeTrace's public documentation (exact `prices` tier-key casing, a couple of catalogue response field names) — see `ARCHITECTURE.md` section 13 ("Known gaps to verify before going live") for the full, explicit list. Both adapters handle this defensively (a short list of plausible field-name candidates, never a fabricated guess) rather than assuming a single unverified shape.
