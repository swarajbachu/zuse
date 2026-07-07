/**
 * Minimal slice of Cloudflare's KVNamespace we use, so the app also runs on
 * an in-memory store under `bun dev` without pulling in workers-types.
 */
export interface KvStore {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  /** Zuse's Vercel team token — the secret this whole service exists to hold. */
  VERCEL_TEAM_TOKEN: string;
  VERCEL_TEAM_ID: string;
  CONVEX_OAUTH_CLIENT_ID: string;
  CONVEX_OAUTH_CLIENT_SECRET: string;
  /** JWKS endpoint for verifying WorkOS access tokens. */
  WORKOS_JWKS_URL: string;
  /** Apex the wildcard points at, e.g. `zuse.app`. */
  ZUSE_APP_DOMAIN: string;
  QUOTA: KvStore;
  /**
   * Dev-only bypass: when set, `Authorization: Bearer <DEV_BEARER_TOKEN>`
   * authenticates as user `dev-user`. Never set in production.
   */
  DEV_BEARER_TOKEN?: string;
}

export type Vars = {
  userId: string;
};
