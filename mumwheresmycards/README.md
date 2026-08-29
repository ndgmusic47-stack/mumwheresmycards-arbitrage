# Mum Where's My Cards — Arbitrage Engine

Private application at `mumwheresmycards.com/arbitrage` that scans eBay + market pricing data for Pokémon card opportunities so nobody has to manually trawl thousands of listings. V1 covers two strategies:

1. **Underpriced raw card flips**
2. **Raw → PSA grading candidates**

New-release flipping/holding is intentionally out of scope for v1 but the architecture (provider abstractions, opportunity engine, `Opportunity` states/scoring) is built to add it later without a rewrite — see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Repository layout

```
apps/worker    Cloudflare Worker — API, cron-triggered scans, static asset host, Cloudflare Access auth
apps/web       React + Vite dashboard SPA
packages/core        Pure business logic: canonical card model, cost/profit calc engine, scoring, filters, opportunity engine
packages/providers    Market data (PokeTrace + mock) and eBay (Browse API + mock) provider abstractions, D1-backed caching, API usage accounting
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
pnpm dev:web           # http://127.0.0.1:5173/arbitrage (proxies /arbitrage/api to the worker)
```

## Status

| Area | Status |
|---|---|
| Canonical card model + resolver | Done, tested |
| Cost/profit calculation engine | Done, tested (74 core-package tests) |
| Market data provider abstraction (PokeTrace + mock) | Done, tested |
| eBay provider abstraction (Browse API + mock) | Done, tested |
| Opportunity engine (scoring, states, filters) | Done, tested |
| D1 schema + migrations | Done |
| Worker API (opportunities, cards, inventory, transactions, grading, settings, scan-runs, watchlist) | Done |
| Scheduled scans (Cloudflare Cron Triggers) | Done |
| Cloudflare Access auth (edge policy + JWT verification) | Documented + middleware implemented — Access application itself is configured in the Cloudflare dashboard, not in code |
| Dashboard (React) | Done — operational, not yet visually polished per the brief's stated priority order |
| Deployment | Documented in `apps/worker/README.md`; not yet deployed to a live Cloudflare account from this session |

Real PokeTrace/eBay credentials have not been integrated or tested against live APIs from this session — both providers are implemented against their documented/expected contracts and exercised only through their fixture-backed mock implementations, per the brief's explicit instruction to build provider mocks before integrating paid APIs.
