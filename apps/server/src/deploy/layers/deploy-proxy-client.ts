import { Effect } from "effect";

import { DeployProxyError } from "@zuse/wire";

import type { AuthServiceShape } from "../../auth/services/auth-service.ts";

/**
 * Effect-wrapped client for the zuse deploy-proxy (apps/deploy-proxy) — the
 * cloud side that holds Zuse's Vercel team token and the Convex OAuth client
 * secret. Every call carries the user's WorkOS access token as bearer; the
 * proxy is where identity, ownership, and quotas are enforced (ADR 0022).
 */

const BASE_URL = (
  process.env.ZUSE_DEPLOY_PROXY_URL ?? "https://deploy.zuse.app"
).replace(/\/$/, "");

export interface VercelFileRef {
  readonly file: string;
  readonly sha: string;
  readonly size: number;
}

export interface VercelFileInline {
  readonly file: string;
  readonly data: string;
  readonly encoding: "base64";
}

export type VercelDeployFile = VercelFileRef | VercelFileInline;

export interface EnsuredProject {
  readonly projectId: string;
  readonly name: string;
  readonly subdomain: string | null;
  readonly url: string | null;
}

export interface CreatedDeployment {
  readonly deploymentId: string;
  readonly url: string | null;
  readonly status: string;
}

export interface DeploymentPoll {
  readonly status: string;
  readonly url: string | null;
  readonly buildLogTail: string | null;
}

export interface ConvexTokenResponse {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresIn: number | null;
}

export interface DeployProxyClient {
  readonly convexTokenExchange: (input: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }) => Effect.Effect<ConvexTokenResponse, DeployProxyError>;
  readonly ensureProject: (input: {
    readonly name: string;
    readonly framework: string;
  }) => Effect.Effect<EnsuredProject, DeployProxyError>;
  readonly uploadFile: (
    sha: string,
    bytes: Uint8Array,
  ) => Effect.Effect<void, DeployProxyError>;
  readonly createDeployment: (input: {
    readonly projectId: string;
    readonly name: string;
    readonly files: ReadonlyArray<VercelDeployFile>;
    readonly env: Record<string, string>;
    readonly framework: string;
    readonly rootDirectory: string;
  }) => Effect.Effect<CreatedDeployment, DeployProxyError>;
  readonly getDeployment: (
    deploymentId: string,
  ) => Effect.Effect<DeploymentPoll, DeployProxyError>;
}

const proxyError = (status: number, reason: string, quota = false) =>
  new DeployProxyError({ status, reason, quotaExceeded: quota });

/**
 * The client is a plain factory over the auth service rather than its own
 * Layer — DeployService and ConvexAuthService each build one from the deps
 * they already have.
 */
export const makeDeployProxyClient = (
  getAccessToken: AuthServiceShape["getAccessToken"],
): DeployProxyClient => {
  const call = <A>(
    path: string,
    init: {
      readonly method?: string;
      readonly json?: unknown;
      readonly bytes?: Uint8Array;
      readonly headers?: Record<string, string>;
    } = {},
  ): Effect.Effect<A, DeployProxyError> =>
    Effect.gen(function* () {
      const token = yield* getAccessToken().pipe(
        Effect.mapError((err) =>
          proxyError(401, `Not signed in to Zuse: ${err.reason}`),
        ),
      );
      return yield* Effect.tryPromise({
        try: async () => {
          const res = await fetch(`${BASE_URL}${path}`, {
            method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
            headers: {
              authorization: `Bearer ${token}`,
              ...(init.json !== undefined
                ? { "content-type": "application/json" }
                : {}),
              ...init.headers,
            },
            body:
              init.json !== undefined
                ? JSON.stringify(init.json)
                : (init.bytes ?? null),
          });
          const text = await res.text();
          const body =
            text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
          if (!res.ok) {
            const reason =
              typeof body.error === "string"
                ? body.error
                : `deploy-proxy ${res.status}`;
            throw proxyError(res.status, reason, body.quotaExceeded === true);
          }
          return body as A;
        },
        catch: (cause) =>
          cause instanceof DeployProxyError
            ? cause
            : proxyError(
                0,
                cause instanceof Error ? cause.message : String(cause),
              ),
      });
    });

  return {
    convexTokenExchange: (input) =>
      call<{
        accessToken: string;
        refreshToken: string | null;
        expiresIn: number | null;
      }>("/v1/convex/oauth/token", {
        json: {
          grantType: "authorization_code",
          code: input.code,
          codeVerifier: input.codeVerifier,
          redirectUri: input.redirectUri,
        },
      }),
    ensureProject: (input) =>
      call<EnsuredProject>("/v1/vercel/projects", { json: input }),
    uploadFile: (sha, bytes) =>
      call<{ uploaded: boolean }>("/v1/vercel/files", {
        method: "POST",
        bytes,
        headers: {
          "x-vercel-digest": sha,
          "content-type": "application/octet-stream",
        },
      }).pipe(Effect.asVoid),
    createDeployment: (input) =>
      call<CreatedDeployment>("/v1/vercel/deployments", { json: input }),
    getDeployment: (deploymentId) =>
      call<DeploymentPoll>(
        `/v1/vercel/deployments/${encodeURIComponent(deploymentId)}`,
      ),
  };
};
