import { Effect } from "effect";
import {
	calculateJwkThumbprint,
	EmbeddedJWK,
	importJWK,
	type JWK,
	jwtVerify,
	SignJWT,
} from "jose";

import { badRequest, type RelayError, unauthorized } from "./errors.ts";

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
export const randomToken = (
	prefix: string,
	bytes = 24,
): Effect.Effect<string> =>
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
		const proofJwk = header.jwk;
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
			try: () => calculateJwkThumbprint(proofJwk),
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
				new SignJWT({
					scope: input.scope.join(" "),
					cnf: { jkt: input.thumbprint },
				})
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
	readonly localPairing?: {
		readonly serverNonce: string;
		readonly devicePublicKey: string;
		readonly transportCertificatePin: string;
	};
}): Effect.Effect<string, RelayError> =>
	Effect.gen(function* () {
		const key = yield* importEd25519(input.mintPrivateJwk, "sign");
		return yield* Effect.tryPromise({
			try: () =>
				new SignJWT({
					environmentId: input.environmentId,
					cnf: { jkt: input.thumbprint },
					...(input.localPairing === undefined
						? {}
						: {
								localPairing: {
									serverNonce: input.localPairing.serverNonce,
									devicePublicKey: input.localPairing.devicePublicKey,
									transportCertificatePin:
										input.localPairing.transportCertificatePin,
								},
							}),
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

export interface WorkspaceClientTicketClaims {
	readonly accountId: string;
	readonly deviceId: string;
	readonly workspaceId: string;
	readonly scope: "workspace-client";
	readonly role: "client";
	readonly protocol: string;
	readonly generation: number;
	readonly gatewayEpoch: number;
}

/** Mint a reusable, short-lived client ticket for one cloud workspace. */
export const signWorkspaceClientTicket = (input: {
	readonly mintPrivateJwk: JWK;
	readonly issuer: string;
	readonly accountId: string;
	readonly deviceId: string;
	readonly workspaceId: string;
	readonly protocol: string;
	readonly generation: number;
	readonly gatewayEpoch: number;
	readonly ttlMs: number;
	readonly nowMs: number;
}): Effect.Effect<string, RelayError> =>
	Effect.gen(function* () {
		const key = yield* importEd25519(input.mintPrivateJwk, "sign");
		return yield* Effect.tryPromise({
			try: () =>
				new SignJWT({
					workspaceId: input.workspaceId,
					deviceId: input.deviceId,
					scope: "workspace-client",
					role: "client",
					protocol: input.protocol,
					generation: input.generation,
					gatewayEpoch: input.gatewayEpoch,
				})
					.setProtectedHeader({
						alg: "EdDSA",
						typ: "workspace-client+jwt",
					})
					.setIssuer(input.issuer)
					.setAudience(`zuse-workspace:${input.workspaceId}`)
					.setSubject(input.accountId)
					.setIssuedAt(Math.floor(input.nowMs / 1000))
					.setExpirationTime(Math.floor((input.nowMs + input.ttlMs) / 1000))
					.sign(key),
			catch: () => badRequest("workspace_ticket_sign_failed"),
		});
	});

/** Verify signature, scope, account/workspace binding, and expiry. */
export const verifyWorkspaceClientTicket = (input: {
	readonly token: string;
	readonly mintPublicJwk: JWK;
	readonly issuer: string;
	readonly expectedAccountId: string;
	readonly expectedDeviceId?: string;
	readonly expectedWorkspaceId: string;
	readonly expectedProtocol: string;
	readonly expectedGeneration: number;
	readonly expectedGatewayEpoch: number;
	readonly nowMs: number;
}): Effect.Effect<WorkspaceClientTicketClaims, RelayError> =>
	Effect.gen(function* () {
		const key = yield* importEd25519(input.mintPublicJwk, "verify");
		const verified = yield* Effect.tryPromise({
			try: () =>
				jwtVerify(input.token, key, {
					issuer: input.issuer,
					audience: `zuse-workspace:${input.expectedWorkspaceId}`,
					typ: "workspace-client+jwt",
					currentDate: new Date(input.nowMs),
				}),
			catch: () => unauthorized("invalid_workspace_ticket"),
		});
		const payload = verified.payload as {
			readonly sub?: unknown;
			readonly workspaceId?: unknown;
			readonly deviceId?: unknown;
			readonly scope?: unknown;
			readonly role?: unknown;
			readonly protocol?: unknown;
			readonly generation?: unknown;
			readonly gatewayEpoch?: unknown;
		};
		if (
			payload.sub !== input.expectedAccountId ||
			typeof payload.deviceId !== "string" ||
			payload.deviceId.length === 0 ||
			(input.expectedDeviceId !== undefined &&
				payload.deviceId !== input.expectedDeviceId) ||
			payload.workspaceId !== input.expectedWorkspaceId ||
			payload.scope !== "workspace-client" ||
			payload.role !== "client" ||
			payload.protocol !== input.expectedProtocol ||
			payload.generation !== input.expectedGeneration ||
			payload.gatewayEpoch !== input.expectedGatewayEpoch
		)
			return yield* Effect.fail(
				unauthorized("workspace_ticket_binding_mismatch"),
			);
		return {
			accountId: input.expectedAccountId,
			deviceId: payload.deviceId,
			workspaceId: input.expectedWorkspaceId,
			scope: "workspace-client",
			role: "client",
			protocol: input.expectedProtocol,
			generation: input.expectedGeneration,
			gatewayEpoch: input.expectedGatewayEpoch,
		};
	});

export interface RuntimeRenewalProofClaims {
	readonly workspaceId: string;
	readonly requestId: string;
	readonly generation: number;
	readonly gatewayEpoch: number;
}

export const runtimeSigningKeyThumbprint = (
	jwk: JWK,
): Effect.Effect<string, RelayError> =>
	Effect.gen(function* () {
		yield* importEd25519(jwk, "verify");
		return yield* Effect.tryPromise({
			try: () => calculateJwkThumbprint(jwk),
			catch: () => badRequest("invalid_runtime_signing_key"),
		});
	});

export const runtimeCredentialKeyThumbprint = (
	jwk: JWK,
): Effect.Effect<string, RelayError> =>
	Effect.gen(function* () {
		if (
			jwk.kty !== "RSA" ||
			jwk.d !== undefined ||
			jwk.p !== undefined ||
			jwk.q !== undefined ||
			jwk.dp !== undefined ||
			jwk.dq !== undefined ||
			jwk.qi !== undefined
		)
			return yield* Effect.fail(badRequest("invalid_workspace_key"));
		yield* Effect.tryPromise({
			try: () => importJWK(jwk, "RSA-OAEP-256"),
			catch: () => badRequest("invalid_workspace_key"),
		});
		return yield* Effect.tryPromise({
			try: () => calculateJwkThumbprint(jwk),
			catch: () => badRequest("invalid_workspace_key"),
		});
	});

export const verifyRuntimeRenewalProof = (input: {
	readonly proof: string;
	readonly runtimeSigningPublicJwk: JWK;
	readonly relayIssuer: string;
	readonly workspaceId: string;
	readonly requestId: string;
	readonly generation: number;
	readonly gatewayEpoch: number;
	readonly nowMs: number;
}): Effect.Effect<RuntimeRenewalProofClaims, RelayError> =>
	Effect.gen(function* () {
		const key = yield* importEd25519(input.runtimeSigningPublicJwk, "verify");
		const verified = yield* Effect.tryPromise({
			try: () =>
				jwtVerify(input.proof, key, {
					audience: input.relayIssuer,
					typ: "workspace-runtime-renewal+jwt",
					currentDate: new Date(input.nowMs),
				}),
			catch: () => unauthorized("invalid_runtime_renewal_proof"),
		});
		const payload = verified.payload as {
			readonly workspaceId?: unknown;
			readonly requestId?: unknown;
			readonly generation?: unknown;
			readonly gatewayEpoch?: unknown;
			readonly iat?: unknown;
			readonly exp?: unknown;
		};
		const nowSeconds = Math.floor(input.nowMs / 1_000);
		if (
			payload.workspaceId !== input.workspaceId ||
			payload.requestId !== input.requestId ||
			payload.generation !== input.generation ||
			payload.gatewayEpoch !== input.gatewayEpoch ||
			typeof payload.iat !== "number" ||
			typeof payload.exp !== "number" ||
			payload.iat > nowSeconds + 30 ||
			payload.iat < nowSeconds - 120 ||
			payload.exp <= nowSeconds
		)
			return yield* Effect.fail(
				unauthorized("runtime_renewal_proof_binding_mismatch"),
			);
		return {
			workspaceId: input.workspaceId,
			requestId: input.requestId,
			generation: input.generation,
			gatewayEpoch: input.gatewayEpoch,
		};
	});

/** Verify a relay-minted access token (for DPoP-protected endpoints). */
export const verifyAccessToken = (input: {
	readonly token: string;
	readonly mintPublicJwk: JWK;
	readonly issuer: string;
}): Effect.Effect<MintedTokenClaims, RelayError> =>
	Effect.gen(function* () {
		const key = yield* importEd25519(input.mintPublicJwk, "verify");
		const verified = yield* Effect.tryPromise({
			try: () =>
				jwtVerify(input.token, key, { issuer: input.issuer, typ: "at+jwt" }),
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

export interface CheckoutReceiptTicketClaims {
	readonly accountId: string;
	readonly offerId: string;
}

/**
 * Mint the ticket carried on a checkout success URL. The buyer's browser is the
 * only party that ever holds it, so the completion page can prove which account
 * a checkout belongs to without an authenticated session.
 */
export const signCheckoutReceiptTicket = (input: {
	readonly mintPrivateJwk: JWK;
	readonly issuer: string;
	readonly accountId: string;
	readonly offerId: string;
	readonly ttlMs: number;
	readonly nowMs: number;
}): Effect.Effect<string, RelayError> =>
	Effect.gen(function* () {
		const key = yield* importEd25519(input.mintPrivateJwk, "sign");
		return yield* Effect.tryPromise({
			try: () =>
				new SignJWT({ offerId: input.offerId })
					.setProtectedHeader({ alg: "EdDSA", typ: "checkout-receipt+jwt" })
					.setIssuer(input.issuer)
					.setAudience(CHECKOUT_RECEIPT_AUDIENCE)
					.setSubject(input.accountId)
					.setIssuedAt(Math.floor(input.nowMs / 1000))
					.setExpirationTime(Math.floor((input.nowMs + input.ttlMs) / 1000))
					.sign(key),
			catch: () => badRequest("checkout_ticket_sign_failed"),
		});
	});

const CHECKOUT_RECEIPT_AUDIENCE = "zuse-checkout-receipt";

/** Verify signature, issuer, and expiry of a checkout receipt ticket. */
export const verifyCheckoutReceiptTicket = (input: {
	readonly token: string;
	readonly mintPublicJwk: JWK;
	readonly issuer: string;
	readonly nowMs: number;
}): Effect.Effect<CheckoutReceiptTicketClaims, RelayError> =>
	Effect.gen(function* () {
		const key = yield* importEd25519(input.mintPublicJwk, "verify");
		const verified = yield* Effect.tryPromise({
			try: () =>
				jwtVerify(input.token, key, {
					issuer: input.issuer,
					audience: CHECKOUT_RECEIPT_AUDIENCE,
					typ: "checkout-receipt+jwt",
					currentDate: new Date(input.nowMs),
				}),
			catch: () => unauthorized("invalid_checkout_ticket"),
		});
		const payload = verified.payload as {
			readonly sub?: unknown;
			readonly offerId?: unknown;
		};
		if (
			typeof payload.sub !== "string" ||
			payload.sub.length === 0 ||
			typeof payload.offerId !== "string" ||
			payload.offerId.length === 0
		) {
			return yield* Effect.fail(unauthorized("checkout_ticket_malformed"));
		}
		return { accountId: payload.sub, offerId: payload.offerId };
	});

export const parseJwk = (value: string): Effect.Effect<JWK, RelayError> =>
	Effect.try({
		try: () => JSON.parse(value) as JWK,
		catch: () => badRequest("invalid_jwk"),
	});
