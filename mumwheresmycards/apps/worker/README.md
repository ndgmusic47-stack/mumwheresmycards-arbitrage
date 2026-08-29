# Deployment — mumwheresmycards.com/arbitrage

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
2. Application domain: `mumwheresmycards.com`, path: `/arbitrage`.
3. Add a policy restricting access to your email / your team (e.g. "Emails ending in @yourdomain.com", or an explicit allow-list of individual emails).
4. Once saved, copy the **Application Audience (AUD) Tag** from the application's Overview tab into the `CF_ACCESS_AUD` secret (step 4).
5. Note your **team domain** (`<team-name>.cloudflareaccess.com`) into `CF_ACCESS_TEAM_DOMAIN` in `wrangler.toml`.

The Worker additionally verifies the forwarded `Cf-Access-Jwt-Assertion` JWT against this team domain's JWKS (`src/middleware/auth.ts`) as defense-in-depth — so a misconfigured route or a future additional route is never accidentally left open.

## 6. Build the frontend and deploy

```bash
pnpm --filter @mwmc/web build   # outputs apps/web/dist, referenced by wrangler.toml [assets]
pnpm --filter @mwmc/worker deploy
```

`wrangler deploy` publishes both the Worker (API + cron + asset routing) and the built SPA in one deployment — see `wrangler.toml`'s `[assets]` block. `run_worker_first = ["/arbitrage/api/*"]` means only API requests invoke the Worker; every other path under `/arbitrage/*` is served directly from static assets (with SPA fallback for client-side routing), which keeps latency and Worker invocation counts down for what is mostly a single-page app.

## 7. Domain routing

`wrangler.toml`'s `routes` block binds this Worker to:

```
mumwheresmycards.com/arbitrage*
```

This requires the zone to already be on Cloudflare (orange-clouded DNS). No DNS record needs to be created solely for this route — Cloudflare routes matching the pattern to the Worker regardless of which record serves the rest of the zone. If `mumwheresmycards.com` serves an unrelated site today, that site is unaffected outside the `/arbitrage` path.

## 8. Scheduled scans

The cron trigger (`[triggers] crons = ["*/30 * * * *"]` in `wrangler.toml`) runs `scheduled()` in `src/index.ts`, which calls `runScan(env, "CRON")`. Tune the interval once real PokeTrace/eBay API quotas and pricing are known — see `ARCHITECTURE.md` section 8 (API cost control) and the `api_usage` table for actual call volume.

A manual scan can always be triggered from the dashboard ("Scan now" button, `POST /arbitrage/api/scan-runs`) or directly:

```bash
curl -X POST https://mumwheresmycards.com/arbitrage/api/scan-runs \
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
pnpm dev:web      # vite dev server, proxies /arbitrage/api to the worker
```

`env.dev` in `wrangler.toml` forces `MARKET_PROVIDER=mock` and `EBAY_PROVIDER=mock`, so local development never touches real PokeTrace/eBay quota and needs no API keys.
