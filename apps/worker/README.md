# Deployment — mumwheresmycards.com/trade

## 1. Prerequisites

- A Cloudflare account with the `mumwheresmycards.com` zone active on Cloudflare DNS.
- Cloudflare Zero Trust (Access) enabled on the account (free tier is enough for a handful of users).
- `wrangler` CLI authenticated: `npx wrangler login`.

## 2. Create the D1 database

```bash
cd apps/worker
npx wrangler d1 create mwmc-db
```

Copy the returned `database_id` into `wrangler.toml` (`[[d1_databases]] database_id = "..."`) for both the top-level block and `[env.dev]` (a separate `mwmc-db-dev` database is recommended for local/dev so scans never mix with production data).

## 3. Run migrations

```bash
# local (Miniflare-backed SQLite, used by `wrangler dev`)
pnpm migrate:local

# production
pnpm migrate:remote
```

Migrations live in `apps/worker/migrations/*.sql` and are applied in numeric order. Never edit an already-applied migration — add a new numbered file instead.

## 4. Configure secrets

Copy `.env.example` (repo root) to `apps/worker/.dev.vars` for local dev. For production, set each secret individually (never in `wrangler.toml`):

```bash
npx wrangler secret put EBAY_CLIENT_ID
npx wrangler secret put EBAY_CLIENT_SECRET
npx wrangler secret put EBAY_MARKETPLACE_ID
npx wrangler secret put EBAY_OAUTH_SCOPE
npx wrangler secret put POKETRACE_API_KEY
npx wrangler secret put POKETRACE_API_BASE_URL
npx wrangler secret put CF_ACCESS_AUD
```

`CF_ACCESS_TEAM_DOMAIN` is not sensitive and can stay in `wrangler.toml` `[vars]`.

## 5. Set up Cloudflare Access (private authentication)

This application must never be publicly reachable — Access is configured at the Cloudflare edge, independent of application code:

1. Zero Trust dashboard → **Access → Applications → Add an application → Self-hosted**.
2. Application domain: `mumwheresmycards.com`, path: `/trade`.
3. Add a policy restricting access to your email / your team (e.g. "Emails ending in @yourdomain.com", or an explicit allow-list of individual emails).
4. Once saved, copy the **Application Audience (AUD) Tag** from the application's Overview tab into the `CF_ACCESS_AUD` secret (step 4).
5. Note your **team domain** (`<team-name>.cloudflareaccess.com`) into `CF_ACCESS_TEAM_DOMAIN` in `wrangler.toml`.

The Worker additionally verifies the forwarded `Cf-Access-Jwt-Assertion` JWT against this team domain's JWKS (`src/middleware/auth.ts`) as defense-in-depth — so a misconfigured route or a future additional route is never accidentally left open.

## 6. Build the frontend and deploy

```bash
pnpm --filter @mwmc/web build   # outputs apps/web/dist, referenced by wrangler.toml [assets]
pnpm --filter @mwmc/worker deploy
```

`wrangler deploy` publishes both the Worker (API + cron + asset routing) and the built SPA in one deployment — see `wrangler.toml`'s `[assets]` block. `run_worker_first = ["/trade/api/*"]` means only API requests invoke the Worker; every other path under `/trade/*` is served directly from static assets (with SPA fallback for client-side routing), which keeps latency and Worker invocation counts down for what is mostly a single-page app.

## 7. Domain routing

`wrangler.toml`'s `routes` block binds this Worker to:

```
mumwheresmycards.com/trade*
```

This requires the zone to already be on Cloudflare (orange-clouded DNS). No DNS record needs to be created solely for this route — Cloudflare routes matching the pattern to the Worker regardless of which record serves the rest of the zone. If `mumwheresmycards.com` serves an unrelated site today, that site is unaffected outside the `/trade` path.

## 8. Scheduled scans

The cron trigger (`[triggers] crons = ["*/30 * * * *"]` in `wrangler.toml`) runs `scheduled()` in `src/index.ts`, which calls `runScan(env, "CRON")`. Each run now does four bounded, resumable steps automatically — catalogue sync, market profiling (Dynamic Flip/Grade Universe), prioritised eBay search, then the opportunity engine — see `ARCHITECTURE.md` sections 2, 7, 8, 11. Tune the interval, `catalogue_sync.maxPagesPerRun`, and `ebay_scan_budget` (all in Settings) once real PokeTrace/eBay API quotas and pricing are known — the `api_usage` and `catalogue_sync_runs` tables show actual call volume.

A catalogue sync can also be triggered directly, independent of a full scan:

```bash
curl -X POST https://mumwheresmycards.com/trade/api/catalogue/sync \
  -H "Cookie: CF_Authorization=<your Access session cookie>"
```

A manual scan can always be triggered from the dashboard ("Scan now" button, `POST /trade/api/scan-runs`) or directly:

```bash
curl -X POST https://mumwheresmycards.com/trade/api/scan-runs \
  -H "Cookie: CF_Authorization=<your Access session cookie>"
```

## 9. Seeding the grading watchlist

```bash
cd apps/worker
cp seed/watchlist.example.json seed/watchlist.json   # edit with your ~31 researched cards
pnpm seed:watchlist                                   # generates seed/watchlist.generated.sql
npx wrangler d1 execute mwmc-db --remote --file=seed/watchlist.generated.sql
```

Watchlist entries are pure data (`watchlist_cards` table) — see `ARCHITECTURE.md`; they never get hardcoded into `packages/core`'s opportunity engine.

## 10. Local development

```bash
pnpm dev:worker   # wrangler dev, serves the API against local D1 + mock providers (env.dev vars)
pnpm dev:web      # vite dev server, proxies /trade/api to the worker
```

`env.dev` in `wrangler.toml` forces `MARKET_PROVIDER=mock` and `EBAY_PROVIDER=mock`, so local development never touches real PokeTrace/eBay quota and needs no API keys.

## 11. Controlled real-data validation run (real PokeTrace → local D1, no eBay)

A one-off, bounded check that catalogue sync + market profiling behave correctly against REAL PokeTrace data before trusting them at full scale — without touching eBay quota at all, and without writing to any remote database.

Uses a dedicated `[env.live_local]` in `wrangler.toml` — same `ENVIRONMENT=development` as the regular mock-based `[env.dev]` (so the Cloudflare Access check, which is otherwise required, is skipped locally — see `src/middleware/auth.ts`), but real `MARKET_PROVIDER=poketrace` / `EBAY_PROVIDER=ebay-browse`, and its OWN local D1 database (`mwmc-db-live-local`) kept separate from `[env.dev]`'s disposable mock-data database. `pnpm dev` (plain `[env.dev]`) is unaffected and stays mock-only for routine development.

**Requires Wrangler 4** (`pnpm install` after pulling — the pinned version was bumped from 3.86 to 4.127.1). On 3.x, `wrangler dev` fails outright with `Expected "assets.run_worker_first" to be of type boolean but got [...]` — the array form of `run_worker_first` this project relies on (worker-first only for `/trade/api/*`, static assets served directly otherwise — see the `[assets]` block) is a Wrangler 4 feature. This was caught, and the fix verified end-to-end (migrations + a real `wrangler dev` + a real HTTP call, not just a config read), while building this validation flow — every command below has actually been run, not just written.

```bash
cd apps/worker
pnpm install                    # picks up wrangler 4
cat .dev.vars                  # confirm POKETRACE_API_KEY is set (same file the poketrace:*-smoke scripts use)
pnpm migrate:live-local         # applies ALL migrations, including 0010-0012, to the mwmc-db-live-local LOCAL database
pnpm dev:live-local             # wrangler dev --env live_local — real providers, local D1 only (never touches remote D1; that needs an explicit --remote flag this script does not pass)
```

In a second terminal, once `wrangler dev` reports it's listening:

```bash
curl -s -X POST http://localhost:8787/trade/api/catalogue/sync-and-profile \
  -H 'Content-Type: application/json' \
  -d '{"maxPagesPerRun": 8, "pageSize": 20}' | tee sync-and-profile-report.json
```

`maxPagesPerRun: 8` × `pageSize: 20` = up to 160 cards — inside the requested 100-200 card range. Raise/lower `maxPagesPerRun` to adjust. This endpoint runs ONLY catalogue sync + market profiling (steps 1-2 of the full scan pipeline in `src/scan/scanRunner.ts`) — it never calls the eBay provider, so it's safe to run repeatedly without burning eBay API quota.

This is a genuinely new persistent local D1 database (or an extension of whatever it already has from `pnpm migrate:local` runs) — real PokeTrace data will be written into it. There's no production database to affect (see `wrangler.toml` — `database_id` is still a placeholder, so nothing is deployed).

Paste the resulting JSON back — it directly answers the two open questions this validation run exists for:

- **`catalogueTotals.cardsWithNullYear`** — how many real cards have a set PokeTrace doesn't resolve a release year for (confirms the year-optional model change is doing something real, not just passing fixture tests).
- **`multiMarketCards`** — every internal card that picked up more than one `external_card_refs` row from PokeTrace, and which markets those rows actually are (`samples[].markets`). If this is empty or near-empty, the whole multi-market ambiguity may not matter in practice at this catalogue size. If it's non-trivial, `samples[].markets` is the real evidence for finalizing `externalRefMarketPreference` (currently the placeholder `["EU","US"]` seeded by migration 0012 — see `src/repo/externalCardRefsRepo.ts` `findExternalRefForCard` doc comment) instead of a guess.

Also worth eyeballing: `catalogueSync.errors` / `marketProfiling.errors` (anything unexpected breaking on real data), and `catalogueTotals.cardsWithRawValue` / `cardsWithAnyPsaGrade` (sanity-check that PokeTrace pricing is actually flowing through, not just catalogue metadata).

## 12. Tuning the commercial model (V1)

Every commercial assumption is a row in the `settings` table, editable from the dashboard Settings tab or via `PUT /trade/api/settings/:key`. **Nothing in the calculation path hardcodes a fee, a grading price, a turnaround, a batch size or a profit threshold** — if changing a number needs a code change, that is a bug.

| Settings key | What it controls |
|---|---|
| `exit_market_fees` | eBay UK business seller fees: 10.9% FVF, 0.35% regulatory operating fee, £0.40 per-order, 20% fee VAT, `sellerFeeVatRecoverable`, promoted/international rates |
| `selling_costs` | Our own outbound postage, packaging and insurance — separate figures for raw cards and graded slabs |
| `qsv_settings` | Quick-sale haircut (8%) and the confidence penalties for single-median / no-median data |
| `graders` | Which grading companies are enabled for arbitrage. PSA on; BGS/CGC supported but off until their market data is validated |
| `grading_services` | Service tiers as data: fee per card, estimated turnaround, USD declared-value cap |
| `grading_batch` | Batch size (10) and the shared outbound/return/insurance costs divided across it |
| `grading_consumables` | Genuine per-card consumables (sleeve, Card Saver) — NOT divided by batch size |
| `upcharge_settings` | Declared-value upcharge reserve, and whether it is carried in the basis or only flagged |
| `grade_classification` | Thresholds separating DOWNSIDE PROTECTED / BALANCED / ASYMMETRIC |
| `flip_qualification` | Raw flip bar: £40 net profit AND 40% ROC, plus liquidity/confidence/QSV/days-to-sale limits |
| `grade_qualification` | Which economic classes count, plus every grading guardrail (basis caps, PSA thresholds, required-hit-rate ceiling, capital-lock ceiling, enabled graders/services) |
| `flip_score_weights` / `grade_score_weights` | RANKING weights only — score orders qualifying opportunities and never decides qualification |
| `market_profile_settings` | Coarse pre-eBay catalogue eligibility, deliberately looser than per-listing qualification |

### The one rule to keep in mind

**Economics qualify; score ranks.** A trade that meets the economic bar is an opportunity regardless of its score, and a high score never rescues one that does not. If you want fewer or more opportunities, change the qualification rules — not the score weights.

### Worked example of the fee model

A £200 raw sale, no buyer-paid postage:

```
FVF          200 x 0.109  = 21.80
regulatory   200 x 0.0035 =  0.70
per order                 =  0.40
                     ex-VAT 22.90
+20% fee VAT              =  4.58
              total fees  = 27.48
fulfilment (postage + packaging) = 2.30
              net sale cash = 170.22
```

Buy that card delivered for £103 and the true net profit is £67.22 at a 65% ROC — which clears the £40/40% bar. Buy it for £160 and it does not, whatever it scores.
