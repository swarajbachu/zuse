import { app } from "./index.ts";
import type { Env, KvStore } from "./env.ts";

/**
 * Local dev entry (`bun dev`): serves the same Hono app on :8787 with env
 * from process.env and an in-memory KV. TTLs are ignored — fine for dev.
 */
const memoryKv = (): KvStore => {
  const store = new Map<string, string>();
  return {
    get: (key) => Promise.resolve(store.get(key) ?? null),
    put: (key, value) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
};

const env: Env = {
  VERCEL_TEAM_TOKEN: process.env.VERCEL_TEAM_TOKEN ?? "",
  VERCEL_TEAM_ID: process.env.VERCEL_TEAM_ID ?? "",
  CONVEX_OAUTH_CLIENT_ID: process.env.CONVEX_OAUTH_CLIENT_ID ?? "",
  CONVEX_OAUTH_CLIENT_SECRET: process.env.CONVEX_OAUTH_CLIENT_SECRET ?? "",
  WORKOS_JWKS_URL:
    process.env.WORKOS_JWKS_URL ?? "https://api.workos.com/sso/jwks/dev",
  ZUSE_APP_DOMAIN: process.env.ZUSE_APP_DOMAIN ?? "zuse.app",
  QUOTA: memoryKv(),
  DEV_BEARER_TOKEN: process.env.DEV_BEARER_TOKEN,
};

export default {
  port: Number(process.env.PORT ?? 8787),
  fetch: (request: Request) => app.fetch(request, env),
};
