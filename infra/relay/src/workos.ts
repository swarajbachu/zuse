import { Context, Effect, Layer } from "effect";
import { createRemoteJWKSet, jwtVerify } from "jose";

import { unauthorized, type RelayError } from "./errors.ts";
import { RelayConfiguration } from "./config.ts";

/** The account identity proven by a verified WorkOS access token. */
export interface WorkosPrincipal {
  readonly accountId: string;
  readonly orgId: string | undefined;
}

/**
 * Verifies WorkOS access tokens presented by signed-in clients (desktop +
 * mobile) and extracts the account identity every relay record is scoped by.
 * A service so tests can inject a fake verifier without hitting WorkOS.
 */
export class WorkosVerifier extends Context.Tag("@zuse/relay/WorkosVerifier")<
  WorkosVerifier,
  {
    readonly verify: (
      token: string,
    ) => Effect.Effect<WorkosPrincipal, RelayError>;
  }
>() {}

export const acceptedWorkosIssuers = (issuer: string): string[] => {
  const trimmed = issuer.trim();
  const withoutSlash = trimmed.replace(/\/+$/, "");
  const withSlash = `${withoutSlash}/`;
  return withoutSlash === withSlash ? [trimmed] : [withoutSlash, withSlash];
};

const decodeJwtPart = (part: string): Record<string, unknown> | null => {
  try {
    const padded = part.padEnd(
      part.length + ((4 - (part.length % 4)) % 4),
      "=",
    );
    const json = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
    const value = JSON.parse(json) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const logWorkosVerifyFailure = (
  token: string,
  config: {
    readonly workosIssuer: string;
    readonly workosJwksUrl: string;
    readonly acceptedIssuers: readonly string[];
  },
  cause: unknown,
): void => {
  const parts = token.split(".");
  const header = parts[0] === undefined ? null : decodeJwtPart(parts[0]);
  const payload = parts[1] === undefined ? null : decodeJwtPart(parts[1]);
  console.warn("[zuse-relay] WorkOS token verification failed", {
    configuredIssuer: config.workosIssuer,
    acceptedIssuers: config.acceptedIssuers,
    jwksUrl: config.workosJwksUrl,
    tokenHeader: {
      alg: header?.alg,
      kid: header?.kid,
      typ: header?.typ,
    },
    tokenClaims: {
      iss: payload?.iss,
      client_id: payload?.client_id,
      aud: payload?.aud,
      exp: payload?.exp,
      iat: payload?.iat,
    },
    cause:
      cause instanceof Error
        ? { name: cause.name, message: cause.message }
        : String(cause),
  });
};

/** Production verifier: validates the JWT against WorkOS's JWKS. */
export const WorkosVerifierLive: Layer.Layer<
  WorkosVerifier,
  never,
  RelayConfiguration
> = Layer.effect(
  WorkosVerifier,
  Effect.gen(function* () {
    const config = yield* RelayConfiguration;
    const jwks = createRemoteJWKSet(new URL(config.workosJwksUrl));
    const issuers = acceptedWorkosIssuers(config.workosIssuer);
    return {
      verify: (token) =>
        Effect.gen(function* () {
          const verified = yield* Effect.tryPromise({
            try: () => jwtVerify(token, jwks, { issuer: issuers }),
            catch: (cause) => {
              logWorkosVerifyFailure(
                token,
                {
                  workosIssuer: config.workosIssuer,
                  workosJwksUrl: config.workosJwksUrl,
                  acceptedIssuers: issuers,
                },
                cause,
              );
              return unauthorized("invalid_workos_token");
            },
          });
          const payload = verified.payload as {
            readonly sub?: unknown;
            readonly org_id?: unknown;
            readonly organization_id?: unknown;
          };
          if (typeof payload.sub !== "string") {
            return yield* Effect.fail(unauthorized("workos_token_no_subject"));
          }
          const orgId =
            typeof payload.org_id === "string"
              ? payload.org_id
              : typeof payload.organization_id === "string"
                ? payload.organization_id
                : undefined;
          return { accountId: payload.sub, orgId };
        }),
    };
  }),
);

/** Test verifier: accepts `test-token:<accountId>[:<orgId>]`. */
export const WorkosVerifierTest: Layer.Layer<WorkosVerifier> = Layer.succeed(
  WorkosVerifier,
  {
    verify: (token) =>
      Effect.gen(function* () {
        const match = /^test-token:([^:]+)(?::(.+))?$/.exec(token);
        if (match === null) {
          return yield* Effect.fail(unauthorized("invalid_workos_token"));
        }
        return { accountId: match[1]!, orgId: match[2] };
      }),
  },
);
