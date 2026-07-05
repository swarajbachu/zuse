import { Clock, Effect, Redacted } from "effect";

import { RelayConfiguration } from "./config.ts";
import {
  parseJwk,
  sha256Hex,
  signAccessToken,
  verifyAccessToken,
  verifyDpopProof,
} from "./crypto.ts";
import { forbidden, unauthorized, type RelayError } from "./errors.ts";
import { RelayStore } from "./store.ts";
import { WorkosVerifier, type WorkosPrincipal } from "./workos.ts";

export const RELAY_SCOPES = {
  status: "environment:status",
  connect: "environment:connect",
  register: "mobile:registration",
} as const;

export type RelayScope = (typeof RELAY_SCOPES)[keyof typeof RELAY_SCOPES];

/** Require a valid WorkOS access token (Authorization: Bearer …). */
export const requireWorkos = (
  request: Request,
): Effect.Effect<
  WorkosPrincipal,
  RelayError,
  WorkosVerifier
> =>
  Effect.gen(function* () {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer (.+)$/i.exec(header);
    if (match === null) {
      return yield* Effect.fail(unauthorized("missing_bearer"));
    }
    const verifier = yield* WorkosVerifier;
    return yield* verifier.verify(match[1]!);
  });

/**
 * Require a valid per-environment credential (Authorization: Bearer zenv_…),
 * used on the endpoints the DESKTOP calls (heartbeat, agent-activity). The
 * credential must be active and belong to the environment named in the path.
 */
export const requireEnvironmentCredential = (
  request: Request,
  environmentId: string,
): Effect.Effect<
  { readonly accountId: string; readonly environmentId: string },
  RelayError,
  RelayStore
> =>
  Effect.gen(function* () {
    const store = yield* RelayStore;
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer (zenv_.+)$/i.exec(header);
    if (match === null) {
      return yield* Effect.fail(unauthorized("missing_environment_credential"));
    }
    const hash = yield* sha256Hex(match[1]!);
    const credential = yield* store.findActiveCredentialByHash(hash);
    if (credential === null) {
      return yield* Effect.fail(unauthorized("invalid_environment_credential"));
    }
    if (credential.environmentId !== environmentId) {
      return yield* Effect.fail(forbidden("credential_environment_mismatch"));
    }
    return { accountId: credential.accountId, environmentId };
  });

export interface DpopPrincipal {
  readonly accountId: string;
  readonly thumbprint: string;
  readonly scope: ReadonlyArray<string>;
}

/**
 * Require a DPoP-bound access token: the `Authorization: DPoP <token>` proves
 * identity + key binding, and the `DPoP: <proof>` header proves possession of
 * that key for THIS request. The proof's `jti` is consumed to reject replays,
 * and the proof key thumbprint must match the token's `cnf.jkt`.
 */
export const requireDpop = (
  request: Request,
  scope: RelayScope,
): Effect.Effect<
  DpopPrincipal,
  RelayError,
  WorkosVerifier | RelayStore | RelayConfiguration
> =>
  Effect.gen(function* () {
    const config = yield* RelayConfiguration;
    const store = yield* RelayStore;
    const nowMs = yield* Clock.currentTimeMillis;

    const authHeader = request.headers.get("authorization") ?? "";
    const tokenMatch = /^DPoP (.+)$/i.exec(authHeader);
    const proof = request.headers.get("dpop");
    if (tokenMatch === null || proof === null) {
      return yield* Effect.fail(unauthorized("missing_dpop"));
    }

    const mintPublicJwk = yield* parseJwk(config.mintPublicKey);
    const claims = yield* verifyAccessToken({
      token: tokenMatch[1]!,
      mintPublicJwk,
      issuer: config.relayIssuer,
    });
    if (!claims.scope.includes(scope)) {
      return yield* Effect.fail(unauthorized("insufficient_scope"));
    }

    const dpop = yield* verifyDpopProof({
      proof,
      method: request.method.toUpperCase(),
      url: request.url,
      nowMs,
    });
    if (dpop.thumbprint !== claims.thumbprint) {
      return yield* Effect.fail(unauthorized("dpop_key_mismatch"));
    }

    const fresh = yield* store.consumeDpopProof({
      thumbprint: dpop.thumbprint,
      jti: dpop.jti,
      issuedAtMs: dpop.issuedAtMs,
      expiresAtMs: nowMs + 5 * 60 * 1000,
    });
    if (!fresh) {
      return yield* Effect.fail(unauthorized("dpop_replayed"));
    }

    return {
      accountId: claims.accountId,
      thumbprint: dpop.thumbprint,
      scope: claims.scope,
    };
  });

/**
 * Exchange a WorkOS token + a DPoP proof for a short-lived, DPoP-bound access
 * token. This is the `POST /v1/client/dpop-token` grant.
 */
export const mintAccessToken = (
  request: Request,
  scopes: ReadonlyArray<RelayScope>,
): Effect.Effect<
  { readonly accessToken: string; readonly expiresInMs: number },
  RelayError,
  WorkosVerifier | RelayStore | RelayConfiguration
> =>
  Effect.gen(function* () {
    const config = yield* RelayConfiguration;
    const store = yield* RelayStore;
    const nowMs = yield* Clock.currentTimeMillis;

    const principal = yield* requireWorkos(request);
    const proof = request.headers.get("dpop");
    if (proof === null) {
      return yield* Effect.fail(unauthorized("missing_dpop"));
    }
    const dpop = yield* verifyDpopProof({
      proof,
      method: request.method.toUpperCase(),
      url: request.url,
      nowMs,
    });
    const fresh = yield* store.consumeDpopProof({
      thumbprint: dpop.thumbprint,
      jti: dpop.jti,
      issuedAtMs: dpop.issuedAtMs,
      expiresAtMs: nowMs + 5 * 60 * 1000,
    });
    if (!fresh) {
      return yield* Effect.fail(unauthorized("dpop_replayed"));
    }

    const mintPrivateJwk = yield* parseJwk(Redacted.value(config.mintPrivateKey));
    const accessToken = yield* signAccessToken({
      mintPrivateJwk,
      issuer: config.relayIssuer,
      accountId: principal.accountId,
      thumbprint: dpop.thumbprint,
      scope: scopes,
      ttlMs: config.accessTokenTtlMs,
      nowMs,
    });
    return { accessToken, expiresInMs: config.accessTokenTtlMs };
  });
