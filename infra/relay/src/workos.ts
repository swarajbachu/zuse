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
    readonly verify: (token: string) => Effect.Effect<WorkosPrincipal, RelayError>;
  }
>() {}

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
    return {
      verify: (token) =>
        Effect.gen(function* () {
          const verified = yield* Effect.tryPromise({
            try: () => jwtVerify(token, jwks, { issuer: config.workosIssuer }),
            catch: () => unauthorized("invalid_workos_token"),
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
