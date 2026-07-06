import { Effect } from "effect";
import {
  calculateJwkThumbprint,
  EmbeddedJWK,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
} from "jose";

import { badRequest, unauthorized, type RelayError } from "./errors.ts";

const encoder = new TextEncoder();

/** SHA-256 hex digest via WebCrypto (available on Workers, Node 20+, Bun). */
export const sha256Hex = (input: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  });

/** A random opaque token with a typed prefix, e.g. `zenv_a1b2…`. */
export const randomToken = (prefix: string, bytes = 24): Effect.Effect<string> =>
  Effect.sync(() => {
    const raw = crypto.getRandomValues(new Uint8Array(bytes));
    const b64 = btoa(String.fromCharCode(...raw))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    return `${prefix}_${b64}`;
  });

const importEd25519 = (
  jwk: JWK,
  usage: "verify" | "sign",
): Effect.Effect<CryptoKey, RelayError> =>
  Effect.tryPromise({
    try: async () => (await importJWK(jwk, "EdDSA")) as CryptoKey,
    catch: () =>
      usage === "sign"
        ? badRequest("invalid_signing_key")
        : unauthorized("invalid_environment_key"),
  });

export interface LinkProofClaims {
  readonly challenge: string;
  readonly environmentId: string;
}

/**
 * Verify the Ed25519 link proof the desktop signs with its per-environment
 * private key. The relay holds only the public key, so a forged proof (wrong
 * key, tampered claims, wrong challenge/issuer) fails to verify.
 */
export const verifyEnvironmentLinkProof = (input: {
  readonly proof: string;
  readonly environmentPublicJwk: JWK;
  readonly expectedChallenge: string;
  readonly expectedEnvironmentId: string;
  readonly relayIssuer: string;
}): Effect.Effect<LinkProofClaims, RelayError> =>
  Effect.gen(function* () {
    const key = yield* importEd25519(input.environmentPublicJwk, "verify");
    const verified = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(input.proof, key, {
          audience: input.relayIssuer,
          typ: "environment-link-proof+jwt",
        }),
      catch: () => unauthorized("invalid_link_proof"),
    });
    const payload = verified.payload as {
      readonly challenge?: unknown;
      readonly environmentId?: unknown;
    };
    if (
      payload.challenge !== input.expectedChallenge ||
      payload.environmentId !== input.expectedEnvironmentId
    ) {
      return yield* Effect.fail(unauthorized("link_proof_mismatch"));
    }
    return {
      challenge: input.expectedChallenge,
      environmentId: input.expectedEnvironmentId,
    };
  });

export interface DpopVerification {
  readonly thumbprint: string;
  readonly jti: string;
  readonly issuedAtMs: number;
}

/**
 * Verify a DPoP proof (RFC 9449 shape): a JWS whose header carries the client's
 * public key. We check the signature against that embedded key, that the method
 * and URL match this request, and freshness. The caller is responsible for
 * consuming the `jti` to reject replays.
 */
export const verifyDpopProof = (input: {
  readonly proof: string;
  readonly method: string;
  readonly url: string;
  readonly nowMs: number;
  readonly maxSkewMs?: number;
}): Effect.Effect<DpopVerification, RelayError> =>
  Effect.gen(function* () {
    const verified = yield* Effect.tryPromise({
      try: () => jwtVerify(input.proof, EmbeddedJWK, { typ: "dpop+jwt" }),
      catch: () => unauthorized("invalid_dpop_proof"),
    });
    const header = verified.protectedHeader as {
      readonly jwk?: JWK;
    };
    const payload = verified.payload as {
      readonly htm?: unknown;
      readonly htu?: unknown;
      readonly jti?: unknown;
      readonly iat?: unknown;
    };
    if (header.jwk === undefined) {
      return yield* Effect.fail(unauthorized("dpop_missing_jwk"));
    }
    if (
      typeof payload.jti !== "string" ||
      typeof payload.iat !== "number" ||
      payload.htm !== input.method ||
      normalizeUrl(payload.htu) !== normalizeUrl(input.url)
    ) {
      return yield* Effect.fail(unauthorized("dpop_claims_mismatch"));
    }
    const issuedAtMs = payload.iat * 1000;
    const skew = input.maxSkewMs ?? 5 * 60 * 1000;
    if (Math.abs(input.nowMs - issuedAtMs) > skew) {
      return yield* Effect.fail(unauthorized("dpop_stale"));
    }
    const thumbprint = yield* Effect.tryPromise({
      try: () => calculateJwkThumbprint(header.jwk!),
      catch: () => unauthorized("dpop_bad_jwk"),
    });
    return { thumbprint, jti: payload.jti, issuedAtMs };
  });

const normalizeUrl = (value: unknown): string => {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
};

/** Mint a short-lived, DPoP-bound access token (JWT, EdDSA-signed by the relay). */
export const signAccessToken = (input: {
  readonly mintPrivateJwk: JWK;
  readonly issuer: string;
  readonly accountId: string;
  readonly thumbprint: string;
  readonly scope: ReadonlyArray<string>;
  readonly ttlMs: number;
  readonly nowMs: number;
}): Effect.Effect<string, RelayError> =>
  Effect.gen(function* () {
    const key = yield* importEd25519(input.mintPrivateJwk, "sign");
    return yield* Effect.tryPromise({
      try: () =>
        new SignJWT({ scope: input.scope.join(" "), cnf: { jkt: input.thumbprint } })
          .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt" })
          .setIssuer(input.issuer)
          .setSubject(input.accountId)
          .setIssuedAt(Math.floor(input.nowMs / 1000))
          .setExpirationTime(Math.floor((input.nowMs + input.ttlMs) / 1000))
          .sign(key),
      catch: () => badRequest("token_sign_failed"),
    });
  });

/** Mint a short-lived connect token scoped to one environment. */
export const signConnectToken = (input: {
  readonly mintPrivateJwk: JWK;
  readonly issuer: string;
  readonly accountId: string;
  readonly environmentId: string;
  readonly thumbprint: string;
  readonly ttlMs: number;
  readonly nowMs: number;
}): Effect.Effect<string, RelayError> =>
  Effect.gen(function* () {
    const key = yield* importEd25519(input.mintPrivateJwk, "sign");
    return yield* Effect.tryPromise({
      try: () =>
        new SignJWT({
          environmentId: input.environmentId,
          cnf: { jkt: input.thumbprint },
        })
          .setProtectedHeader({ alg: "EdDSA", typ: "connect+jwt" })
          .setIssuer(input.issuer)
          .setAudience(`zuse-env:${input.environmentId}`)
          .setSubject(input.accountId)
          .setIssuedAt(Math.floor(input.nowMs / 1000))
          .setExpirationTime(Math.floor((input.nowMs + input.ttlMs) / 1000))
          .sign(key),
      catch: () => badRequest("token_sign_failed"),
    });
  });

export interface MintedTokenClaims {
  readonly accountId: string;
  readonly thumbprint: string;
  readonly scope: ReadonlyArray<string>;
}

/** Verify a relay-minted access token (for DPoP-protected endpoints). */
export const verifyAccessToken = (input: {
  readonly token: string;
  readonly mintPublicJwk: JWK;
  readonly issuer: string;
}): Effect.Effect<MintedTokenClaims, RelayError> =>
  Effect.gen(function* () {
    const key = yield* importEd25519(input.mintPublicJwk, "verify");
    const verified = yield* Effect.tryPromise({
      try: () => jwtVerify(input.token, key, { issuer: input.issuer, typ: "at+jwt" }),
      catch: () => unauthorized("invalid_access_token"),
    });
    const payload = verified.payload as {
      readonly sub?: unknown;
      readonly scope?: unknown;
      readonly cnf?: { readonly jkt?: unknown };
    };
    if (
      typeof payload.sub !== "string" ||
      typeof payload.cnf?.jkt !== "string"
    ) {
      return yield* Effect.fail(unauthorized("access_token_malformed"));
    }
    return {
      accountId: payload.sub,
      thumbprint: payload.cnf.jkt,
      scope: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
    };
  });

export const parseJwk = (value: string): Effect.Effect<JWK, RelayError> =>
  Effect.try({
    try: () => JSON.parse(value) as JWK,
    catch: () => badRequest("invalid_jwk"),
  });
