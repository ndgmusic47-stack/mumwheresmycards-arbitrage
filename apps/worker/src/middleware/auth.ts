import type { Context, Next } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { HonoEnv } from "../env.js";

/**
 * Defense-in-depth verification of Cloudflare Access's JWT. Access is
 * configured at the Cloudflare edge to protect mumwheresmycards.com/trade*
 * (see apps/worker/README.md) — that edge policy is the primary security
 * boundary. This middleware additionally verifies the forwarded JWT so the
 * Worker never trusts the header blindly if it's ever exposed on another
 * route, and so the authenticated identity is available for audit fields.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function cloudflareAccessAuth(c: Context<HonoEnv>, next: Next) {
  const env = c.env;

  if (env.ENVIRONMENT === "development") {
    // Local dev has no Access in front of it — skip verification so
    // `wrangler dev` / vitest-against-Miniflare work without a team domain.
    await next();
    return;
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) {
    return c.json({ error: "Missing Cloudflare Access assertion" }, 401);
  }

  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD) {
    return c.json({ error: "Server misconfigured: CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD not set" }, 500);
  }

  try {
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`https://${env.CF_ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`));
    }

    const { payload } = await jwtVerify(token, jwks, {
      audience: env.CF_ACCESS_AUD,
      issuer: `https://${env.CF_ACCESS_TEAM_DOMAIN}`,
    });

    c.set("accessIdentity", { email: payload.email as string | undefined, sub: payload.sub });
  } catch (err) {
    return c.json({ error: "Invalid Cloudflare Access assertion", detail: String(err) }, 401);
  }

  await next();
}
