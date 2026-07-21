import {
	createCipheriv,
	createHash,
	createHmac,
	createPublicKey,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { networkInterfaces } from "node:os";
import {
	type AuthTokenId,
	AuthTokenSummary,
	type EnvironmentId,
} from "@zuse/contracts";
import { Clock, Effect, Layer, Ref, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { importJWK, type JWK, jwtVerify } from "jose";
import {
	generateEnvironmentKeypair,
	signEnvironmentLinkProof,
} from "../../relay/link-proof.ts";
import {
	LanAuthConfig,
	LanAuthError,
	LanAuthService,
	PairingRedeemError,
} from "../services/lan-auth-service.ts";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const NEARBY_PAIRING_TTL_MS = 2 * 60 * 1000;

const SAFETY_WORDS = [
	"amber",
	"apple",
	"birch",
	"blue",
	"cedar",
	"cloud",
	"coral",
	"dawn",
	"ember",
	"fern",
	"field",
	"gold",
	"harbor",
	"indigo",
	"jade",
	"kite",
	"lake",
	"leaf",
	"lunar",
	"maple",
	"mint",
	"ocean",
	"pearl",
	"pine",
	"river",
	"rose",
	"silver",
	"sky",
	"stone",
	"sun",
	"violet",
	"willow",
] as const;

interface TokenRow {
	readonly id: string;
	readonly device_id: string | null;
	readonly label: string | null;
	readonly created_at: string;
	readonly last_used_at: string | null;
	readonly revoked_at: string | null;
}

interface EnvironmentIdentityRow {
	readonly id: string;
	readonly signing_secret: string | null;
}

interface EnvironmentKeyRow {
	readonly private_key_jwk: string | null;
	readonly public_key_jwk: string | null;
}

interface PairingCodeState {
	readonly expiresAtMs: number;
}

interface NearbyPairingState {
	readonly request: import("../services/lan-auth-service.ts").NearbyPairingRequest;
	readonly status:
		| { readonly state: "pending" }
		| { readonly state: "denied" }
		| {
				readonly state: "approved";
				readonly credential: {
					readonly ephemeralPublicKey: string;
					readonly nonce: string;
					readonly ciphertext: string;
				};
		  };
}

interface RelayConfigAuthRow {
	readonly environment_id: string;
	readonly relay_issuer: string;
	readonly relay_mint_public_key: string | null;
}

const randomBase64Url = (bytes: number): Effect.Effect<string> =>
	Effect.sync(() => randomBytes(bytes).toString("base64url"));

const tokenHash = (token: string): Effect.Effect<string> =>
	Effect.sync(() => createHash("sha256").update(token).digest("hex"));

const nearbyFingerprint = (value: string): Uint8Array =>
	createHash("sha256").update(value).digest();

const deviceIdentifier = (publicKey: string): string =>
	Buffer.from(nearbyFingerprint(publicKey).slice(0, 2))
		.toString("hex")
		.toUpperCase();

const deviceCryptographicId = (publicKey: string): string =>
	Buffer.from(nearbyFingerprint(publicKey)).toString("hex");

const validateDevicePublicKey = (publicKey: string): void => {
	const recipient = createPublicKey({
		key: { kty: "OKP", crv: "X25519", x: publicKey },
		format: "jwk",
	});
	const ephemeral = generateKeyPairSync("x25519");
	diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
};

const safetyPhrase = (transcript: string): string => {
	const digest = nearbyFingerprint(transcript);
	return [digest[0] ?? 0, digest[1] ?? 0, digest[2] ?? 0]
		.map((value) => SAFETY_WORDS[value % SAFETY_WORDS.length])
		.join("-");
};

const encryptedCredential = (
	devicePublicKey: string,
	payload: { readonly token: string; readonly environmentId: EnvironmentId },
) => {
	const recipient = createPublicKey({
		key: { kty: "OKP", crv: "X25519", x: devicePublicKey },
		format: "jwk",
	});
	const ephemeral = generateKeyPairSync("x25519");
	const shared = diffieHellman({
		privateKey: ephemeral.privateKey,
		publicKey: recipient,
	});
	const key = Buffer.from(
		hkdfSync(
			"sha256",
			shared,
			Buffer.alloc(0),
			"zuse-nearby-credential-v1",
			32,
		),
	);
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(payload), "utf8"),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	const publicJwk = ephemeral.publicKey.export({ format: "jwk" });
	if (publicJwk.x === undefined) throw new Error("x25519_public_key_missing");
	return {
		ephemeralPublicKey: publicJwk.x,
		nonce: nonce.toString("base64url"),
		ciphertext: ciphertext.toString("base64url"),
	};
};

const nowIso = Effect.map(Clock.currentTimeMillis, (ms) =>
	new Date(ms).toISOString(),
);

const toLanAuthError = (cause: unknown): LanAuthError =>
	new LanAuthError({
		reason: cause instanceof Error ? cause.message : String(cause),
	});

const firstNonInternalIpv4 = (): string | null => {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) {
				return entry.address;
			}
		}
	}
	return null;
};

const configuredHost = (
	advertisedHost: string | null,
): Effect.Effect<string, LanAuthError> =>
	Effect.sync(() => advertisedHost ?? firstNonInternalIpv4()).pipe(
		Effect.flatMap((host) =>
			host === null
				? Effect.fail(new LanAuthError({ reason: "no_advertised_host" }))
				: Effect.succeed(host),
		),
	);

export const LanAuthServiceLive = Layer.effect(
	LanAuthService,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const config = yield* LanAuthConfig;
		const pairingCodes = yield* Ref.make(new Map<string, PairingCodeState>());
		const nearbyPairings = yield* Ref.make(
			new Map<string, NearbyPairingState>(),
		);
		const nearbyRequestTimes = yield* Ref.make(new Map<string, number>());
		const nearbyGlobalRequestTimes = yield* Ref.make<ReadonlyArray<number>>([]);
		const nearbyAdmission = yield* Semaphore.make(1);
		const nearbyChallenges = yield* Ref.make(new Map<string, number>());

		const mintToken = (label?: string, deviceId?: string) =>
			Effect.gen(function* () {
				const id = `auth_${yield* randomBase64Url(16)}` as AuthTokenId;
				const token = `zt_${yield* randomBase64Url(32)}`;
				const hash = yield* tokenHash(token);
				const createdAt = yield* nowIso;
				yield* sql.withTransaction(
					Effect.gen(function* () {
						if (deviceId !== undefined) {
							yield* sql`
                UPDATE auth_tokens
                SET revoked_at = COALESCE(revoked_at, ${createdAt})
                WHERE device_id = ${deviceId}
                  AND revoked_at IS NULL
              `;
						}
						yield* sql`
              INSERT INTO auth_tokens
                (id, token_hash, device_id, label, created_at, last_used_at, revoked_at)
              VALUES
                (${id}, ${hash}, ${deviceId ?? null}, ${label ?? null}, ${createdAt}, NULL, NULL)
            `;
					}),
				);
				return { id, token } as const;
			}).pipe(Effect.mapError(toLanAuthError));

		const environmentId = () =>
			Effect.gen(function* () {
				const existing = yield* sql<EnvironmentIdentityRow>`
          SELECT id, signing_secret
          FROM environment_identity
          ORDER BY created_at ASC
          LIMIT 1
        `;
				if (existing[0]?.id !== undefined) {
					if (existing[0].signing_secret === null) {
						const secret = yield* randomBase64Url(32);
						yield* sql`
              UPDATE environment_identity
              SET signing_secret = ${secret}
              WHERE id = ${existing[0].id}
            `;
					}
					return existing[0].id as EnvironmentId;
				}

				const id = `env_${yield* randomBase64Url(16)}` as EnvironmentId;
				const signingSecret = yield* randomBase64Url(32);
				const createdAt = yield* nowIso;
				yield* sql`
          INSERT INTO environment_identity (id, created_at, signing_secret)
          VALUES (${id}, ${createdAt}, ${signingSecret})
        `;
				return id;
			}).pipe(Effect.mapError(toLanAuthError));

		const environmentKeys = () =>
			Effect.gen(function* () {
				const envId = yield* environmentId();
				const rows = yield* sql<EnvironmentKeyRow>`
          SELECT private_key_jwk, public_key_jwk
          FROM environment_identity
          WHERE id = ${envId}
          LIMIT 1
        `;
				if (
					rows[0]?.private_key_jwk != null &&
					rows[0]?.public_key_jwk != null
				) {
					return {
						envId,
						privateJwk: rows[0].private_key_jwk,
						publicJwk: rows[0].public_key_jwk,
					} as const;
				}
				const keypair = yield* generateEnvironmentKeypair();
				yield* sql`
          UPDATE environment_identity
          SET private_key_jwk = ${keypair.privateJwk},
              public_key_jwk = ${keypair.publicJwk}
          WHERE id = ${envId}
        `;
				return { envId, ...keypair } as const;
			}).pipe(Effect.mapError(toLanAuthError));

		const createNearbyPairingChallenge = Effect.fn(
			"LanAuthService.createNearbyPairingChallenge",
		)(function* () {
			const serverNonce = yield* randomBase64Url(18);
			const now = yield* Clock.currentTimeMillis;
			const keys = yield* environmentKeys();
			yield* Ref.update(nearbyChallenges, (items) => {
				const next = new Map(
					[...items].filter(([, expiresAt]) => expiresAt > now),
				);
				next.set(serverNonce, now + 30_000);
				return next;
			});
			return {
				serverNonce,
				environmentPublicKey: keys.publicJwk,
				environmentId: keys.envId,
				transportCertificatePin: config.transportCertificatePin,
				expiresAt: new Date(now + 30_000),
			} as const;
		});

		const requestNearbyPairingUnlocked = Effect.fn(
			"LanAuthService.requestNearbyPairing",
		)(function* (input: {
			readonly deviceId: string;
			readonly deviceLabel: string;
			readonly deviceModel?: string;
			readonly devicePublicKey: string;
			readonly ephemeralPublicKey: string;
			readonly clientNonce: string;
			readonly icloudTrustRecordId?: string;
			readonly icloudTrustProof?: string;
			readonly serverNonce: string;
			readonly accountAssertion?: string;
		}) {
			yield* Effect.try({
				try: () => validateDevicePublicKey(input.devicePublicKey),
				catch: () => new LanAuthError({ reason: "nearby_public_key_invalid" }),
			});
			yield* Effect.try({
				try: () => validateDevicePublicKey(input.ephemeralPublicKey),
				catch: () => new LanAuthError({ reason: "nearby_public_key_invalid" }),
			});
			const cryptographicId = deviceCryptographicId(input.devicePublicKey);
			const blocked = yield* sql<{ readonly cryptographic_id: string }>`
				SELECT cryptographic_id
				FROM blocked_nearby_devices
				WHERE cryptographic_id = ${cryptographicId}
				LIMIT 1
			`;
			if (blocked.length > 0) {
				return yield* new LanAuthError({ reason: "nearby_device_blocked" });
			}
			const now = yield* Clock.currentTimeMillis;
			const challengeValid = yield* Ref.modify(nearbyChallenges, (items) => {
				const expiresAt = items.get(input.serverNonce);
				const next = new Map(items);
				next.delete(input.serverNonce);
				return [expiresAt !== undefined && expiresAt > now, next];
			});
			if (!challengeValid) {
				return yield* new LanAuthError({ reason: "nearby_challenge_invalid" });
			}
			const current = yield* Ref.get(nearbyPairings);
			const active = [...current.values()].find(
				(entry) =>
					entry.status.state === "pending" &&
					entry.request.expiresAt.getTime() > now,
			);
			if (active !== undefined) {
				if (active.request.devicePublicKey === input.devicePublicKey)
					return active.request;
				return yield* new LanAuthError({ reason: "nearby_request_busy" });
			}
			const previousRequestAt = (yield* Ref.get(nearbyRequestTimes)).get(
				cryptographicId,
			);
			if (previousRequestAt !== undefined && now - previousRequestAt < 3_000) {
				return yield* new LanAuthError({
					reason: "nearby_request_rate_limited",
				});
			}
			const globallyAccepted = yield* Ref.modify(
				nearbyGlobalRequestTimes,
				(times) => {
					const recent = times.filter((time) => now - time < 60_000);
					return recent.length >= 8
						? [false, recent]
						: [true, [...recent, now]];
				},
			);
			if (!globallyAccepted) {
				return yield* new LanAuthError({
					reason: "nearby_request_rate_limited",
				});
			}
			yield* Ref.update(nearbyRequestTimes, (times) =>
				new Map(times).set(cryptographicId, now),
			);

			const requestId = `pair_${yield* randomBase64Url(18)}`;
			const serverNonce = input.serverNonce;
			const keys = yield* environmentKeys();
			const transcript = [
				"zuse-nearby-v1",
				input.deviceId,
				input.devicePublicKey,
				input.ephemeralPublicKey,
				input.clientNonce,
				serverNonce,
				keys.publicJwk,
				...(config.transportCertificatePin === undefined
					? []
					: [config.transportCertificatePin]),
			].join("|");
			const request = {
				requestId,
				deviceId: input.deviceId,
				deviceLabel: input.deviceLabel,
				...(input.deviceModel === undefined
					? {}
					: { deviceModel: input.deviceModel }),
				deviceIdentifier: deviceIdentifier(input.devicePublicKey),
				devicePublicKey: input.devicePublicKey,
				ephemeralPublicKey: input.ephemeralPublicKey,
				clientNonce: input.clientNonce,
				serverNonce,
				safetyPhrase: safetyPhrase(transcript),
				createdAt: new Date(now),
				expiresAt: new Date(now + NEARBY_PAIRING_TTL_MS),
			} as const;
			let status: NearbyPairingState["status"] = { state: "pending" };
			if (input.accountAssertion !== undefined) {
				const accountAssertion = input.accountAssertion;
				const relayRows = yield* sql<RelayConfigAuthRow>`
					SELECT environment_id, relay_issuer, relay_mint_public_key
					FROM relay_config
					LIMIT 1
				`;
				const relay = relayRows[0];
				const relayMintPublicKey = relay?.relay_mint_public_key;
				const accountVerified =
					relay === undefined || relayMintPublicKey == null
						? false
						: yield* Effect.tryPromise({
								try: async () => {
									const key = await importJWK(
										JSON.parse(relayMintPublicKey) as JWK,
										"EdDSA",
									);
									const verified = await jwtVerify(accountAssertion, key, {
										issuer: relay.relay_issuer,
										audience: `zuse-env:${relay.environment_id}`,
										typ: "connect+jwt",
									});
									const binding = verified.payload.localPairing as
										| {
												readonly serverNonce?: unknown;
												readonly devicePublicKey?: unknown;
												readonly transportCertificatePin?: unknown;
										  }
										| undefined;
									return (
										verified.payload.environmentId === keys.envId &&
										binding?.serverNonce === serverNonce &&
										binding.devicePublicKey === input.devicePublicKey &&
										binding.transportCertificatePin ===
											config.transportCertificatePin
									);
								},
								catch: () => false,
							}).pipe(Effect.catch(() => Effect.succeed(false)));
				if (accountVerified) {
					const minted = yield* mintToken(input.deviceLabel, input.deviceId);
					status = {
						state: "approved",
						credential: encryptedCredential(input.devicePublicKey, {
							token: minted.token,
							environmentId: keys.envId,
						}),
					};
				}
			}
			if (
				status.state === "pending" &&
				config.icloudTrustRecordId !== undefined &&
				config.icloudTrustSecret !== undefined &&
				input.icloudTrustRecordId === config.icloudTrustRecordId &&
				input.icloudTrustProof !== undefined
			) {
				const challenge = [
					"zuse-icloud-v1",
					input.icloudTrustRecordId,
					input.deviceId,
					input.devicePublicKey,
					input.clientNonce,
					serverNonce,
					keys.publicJwk,
					...(config.transportCertificatePin === undefined
						? []
						: [config.transportCertificatePin]),
				].join("|");
				const expected = createHmac(
					"sha256",
					Buffer.from(config.icloudTrustSecret, "base64url"),
				)
					.update(challenge)
					.digest();
				const supplied = Buffer.from(input.icloudTrustProof, "base64url");
				if (
					supplied.length === expected.length &&
					timingSafeEqual(supplied, expected)
				) {
					const minted = yield* mintToken(input.deviceLabel, input.deviceId);
					status = {
						state: "approved",
						credential: encryptedCredential(input.devicePublicKey, {
							token: minted.token,
							environmentId: keys.envId,
						}),
					};
				}
			}
			yield* Ref.update(nearbyPairings, (items) => {
				const next = new Map(
					[...items].filter(
						([, entry]) => entry.request.expiresAt.getTime() > now,
					),
				);
				next.set(requestId, { request, status });
				return next;
			});
			if (status.state === "pending") {
				yield* Effect.sync(() => {
					console.info("[zuse:pairing] server.request.pending", {
						requestId: request.requestId,
						deviceIdentifier: request.deviceIdentifier,
						presentationConfigured: config.onNearbyPairingRequest !== undefined,
					});
					try {
						config.onNearbyPairingRequest?.(request);
						console.info("[zuse:pairing] server.request.dispatched", {
							requestId: request.requestId,
						});
					} catch (cause) {
						console.error("[zuse:pairing] server.request.dispatch_failed", {
							requestId: request.requestId,
							cause,
						});
						// Presentation must never invalidate a valid pairing request.
					}
				});
			}
			return request;
		});
		const requestNearbyPairing = (
			input: Parameters<typeof requestNearbyPairingUnlocked>[0],
		) =>
			nearbyAdmission
				.withPermits(1)(requestNearbyPairingUnlocked(input))
				.pipe(
					Effect.mapError((error) =>
						error instanceof LanAuthError ? error : toLanAuthError(error),
					),
				);

		const listNearbyPairingRequests = Effect.fn(
			"LanAuthService.listNearbyPairingRequests",
		)(function* () {
			const now = yield* Clock.currentTimeMillis;
			const pairings = yield* Ref.get(nearbyPairings);
			return [...pairings.values()]
				.filter(
					(entry) =>
						entry.status.state === "pending" &&
						entry.request.expiresAt.getTime() > now,
				)
				.map((entry) => entry.request);
		});

		const resolveNearbyPairingRequestUnlocked = Effect.fn(
			"LanAuthService.resolveNearbyPairingRequest",
		)(function* (input: {
			readonly requestId: string;
			readonly decision: "allow" | "deny" | "block";
		}) {
			const pairings = yield* Ref.get(nearbyPairings);
			const entry = pairings.get(input.requestId);
			const now = yield* Clock.currentTimeMillis;
			if (
				entry === undefined ||
				entry.status.state !== "pending" ||
				entry.request.expiresAt.getTime() <= now
			) {
				return yield* new LanAuthError({ reason: "nearby_request_expired" });
			}
			if (input.decision !== "allow") {
				if (input.decision === "block") {
					const cryptographicId = deviceCryptographicId(
						entry.request.devicePublicKey,
					);
					const createdAt = yield* nowIso;
					yield* sql`
						INSERT INTO blocked_nearby_devices (cryptographic_id, created_at)
						VALUES (${cryptographicId}, ${createdAt})
						ON CONFLICT(cryptographic_id) DO NOTHING
					`;
				}
				yield* Ref.update(nearbyPairings, (items) => {
					const next = new Map(items);
					next.set(input.requestId, {
						...entry,
						status: { state: "denied" },
					});
					return next;
				});
				return "denied" as const;
			}

			const minted = yield* mintToken(
				entry.request.deviceLabel,
				entry.request.deviceId,
			);
			const envId = yield* environmentId();
			yield* Ref.update(nearbyPairings, (items) => {
				const next = new Map(items);
				next.set(input.requestId, {
					...entry,
					status: {
						state: "approved",
						credential: encryptedCredential(entry.request.devicePublicKey, {
							token: minted.token,
							environmentId: envId,
						}),
					},
				});
				return next;
			});
			return "approved" as const;
		});
		const resolveNearbyPairingRequest = (
			input: Parameters<typeof resolveNearbyPairingRequestUnlocked>[0],
		) =>
			resolveNearbyPairingRequestUnlocked(input).pipe(
				Effect.mapError((error) =>
					error instanceof LanAuthError ? error : toLanAuthError(error),
				),
			);

		const nearbyPairingStatus = Effect.fn("LanAuthService.nearbyPairingStatus")(
			function* (requestId: string) {
				const pairings = yield* Ref.get(nearbyPairings);
				const entry = pairings.get(requestId);
				if (entry === undefined) return { state: "expired" } as const;
				const now = yield* Clock.currentTimeMillis;
				if (
					entry.status.state === "pending" &&
					entry.request.expiresAt.getTime() <= now
				) {
					return { state: "expired" } as const;
				}
				return entry.status;
			},
		);

		const makePairingUrls = (code: string) =>
			Effect.gen(function* () {
				if (config.port === null) {
					return yield* Effect.fail(
						new LanAuthError({ reason: "no_pairing_endpoint" }),
					);
				}
				const host = yield* configuredHost(config.advertisedHost);
				const pairingUrl = `ws://${host}:${config.port}`;
				const qrText = `zuse:///connect/pair?pairingUrl=${encodeURIComponent(
					pairingUrl,
				)}#token=${code}`;
				return { pairingUrl, qrText } as const;
			});

		const service = LanAuthService.of({
			policy: config.policy,
			pairingBootstrap: config.pairingBootstrap,
			mintToken,
			verifyToken: (token) =>
				Effect.gen(function* () {
					const hash = yield* tokenHash(token);
					const rows = yield* sql<{ readonly id: string }>`
            SELECT id
            FROM auth_tokens
            WHERE token_hash = ${hash}
              AND revoked_at IS NULL
            LIMIT 1
          `;
					const matchedToken = rows[0];
					if (matchedToken === undefined) {
						const relayRows = yield* sql<RelayConfigAuthRow>`
              SELECT environment_id, relay_issuer, relay_mint_public_key
              FROM relay_config
              LIMIT 1
            `;
						const relay = relayRows[0];
						if (relay === undefined || relay.relay_mint_public_key === null) {
							return false;
						}
						const mintPublicKey = relay.relay_mint_public_key;
						return yield* Effect.tryPromise({
							try: async () => {
								const jwk = JSON.parse(mintPublicKey) as JWK;
								const key = await importJWK(jwk, "EdDSA");
								const verified = await jwtVerify(token, key, {
									issuer: relay.relay_issuer,
									audience: `zuse-env:${relay.environment_id}`,
									typ: "connect+jwt",
								});
								return verified.payload.environmentId === relay.environment_id;
							},
							catch: (cause) => cause,
						}).pipe(Effect.catch(() => Effect.succeed(false)));
					}
					const usedAt = yield* nowIso;
					yield* sql`
            UPDATE auth_tokens
            SET last_used_at = ${usedAt}
							WHERE id = ${matchedToken.id}
          `;
					return true;
				}).pipe(Effect.mapError(toLanAuthError)),
			listTokens: () =>
				Effect.gen(function* () {
					const rows = yield* sql<TokenRow>`
            SELECT id, device_id, label, created_at, last_used_at, revoked_at
            FROM auth_tokens
            ORDER BY created_at DESC
          `;
					return rows.map((row) =>
						AuthTokenSummary.make({
							id: row.id as AuthTokenId,
							deviceId: row.device_id ?? undefined,
							label: row.label ?? undefined,
							createdAt: new Date(row.created_at),
							lastUsedAt:
								row.last_used_at === null
									? undefined
									: new Date(row.last_used_at),
							revokedAt:
								row.revoked_at === null ? undefined : new Date(row.revoked_at),
						}),
					);
				}).pipe(Effect.mapError(toLanAuthError)),
			revokeToken: (id) =>
				Effect.gen(function* () {
					const revokedAt = yield* nowIso;
					yield* sql`
            UPDATE auth_tokens
            SET revoked_at = COALESCE(revoked_at, ${revokedAt})
            WHERE id = ${id}
          `;
				}).pipe(Effect.asVoid, Effect.mapError(toLanAuthError)),
			hasActiveTokens: () =>
				Effect.gen(function* () {
					const rows = yield* sql<{ readonly id: string }>`
            SELECT id
            FROM auth_tokens
            WHERE revoked_at IS NULL
            LIMIT 1
          `;
					return rows.length > 0;
				}).pipe(Effect.mapError(toLanAuthError)),
			createPairingCode: () =>
				Effect.gen(function* () {
					const code = `zp_${yield* randomBase64Url(16)}`;
					const now = yield* Clock.currentTimeMillis;
					const expiresAtMs = now + PAIRING_TTL_MS;
					const urls = yield* makePairingUrls(code);
					yield* Ref.set(pairingCodes, new Map([[code, { expiresAtMs }]]));
					return {
						code,
						expiresAt: new Date(expiresAtMs),
						pairingUrl: urls.pairingUrl,
						qrText: urls.qrText,
					} as const;
				}).pipe(Effect.mapError(toLanAuthError)),
			redeemPairingCode: (code, device) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					const status = yield* Ref.modify(pairingCodes, (codes) => {
						const entry = codes.get(code);
						if (entry === undefined) return ["invalid" as const, codes];
						const next = new Map(codes);
						next.delete(code);
						if (entry.expiresAtMs <= now) return ["expired" as const, next];
						return ["valid" as const, next];
					});

					if (status === "invalid") {
						return yield* Effect.fail(
							new PairingRedeemError({ reason: "invalid_code" }),
						);
					}
					if (status === "expired") {
						return yield* Effect.fail(
							new PairingRedeemError({ reason: "expired_code" }),
						);
					}

					const minted = yield* mintToken(
						device?.label ?? "Paired phone",
						device?.id,
					);
					const keys = yield* environmentKeys();
					return {
						token: minted.token,
						environmentId: keys.envId,
						environmentPublicKey: keys.publicJwk,
						transportCertificatePin: config.transportCertificatePin,
					} as const;
				}),
			requestNearbyPairing,
			createNearbyPairingChallenge,
			listNearbyPairingRequests,
			resolveNearbyPairingRequest,
			nearbyPairingStatus,
			environmentId,
			environmentKeys,
			linkProof: (input) =>
				Effect.gen(function* () {
					const { envId, privateJwk } = yield* environmentKeys();
					const nowMs = yield* Clock.currentTimeMillis;
					const proof = yield* signEnvironmentLinkProof({
						privateJwk,
						challenge: input.challenge,
						environmentId: envId,
						relayIssuer: input.relayIssuer,
						nowMs,
					});
					return { proof } as const;
				}).pipe(Effect.mapError(toLanAuthError)),
			saveRelayConfig: (input) =>
				Effect.gen(function* () {
					const actualEnvironmentId = yield* environmentId();
					if (input.environmentId !== actualEnvironmentId) {
						return yield* Effect.fail(
							new LanAuthError({ reason: "environment_id_mismatch" }),
						);
					}
					const updatedAt = yield* nowIso;
					yield* sql`
            INSERT INTO relay_config
              (environment_id, relay_url, relay_issuer, environment_credential, label, connector_token, tunnel_hostname, relay_mint_public_key, updated_at)
            VALUES
              (${input.environmentId}, ${input.relayUrl}, ${input.relayIssuer},
               ${input.environmentCredential}, ${input.label ?? null},
               ${input.connectorToken ?? null}, ${input.tunnelHostname ?? null},
               ${input.mintPublicKey ?? null},
               ${updatedAt})
            ON CONFLICT(environment_id) DO UPDATE SET
              relay_url = excluded.relay_url,
              relay_issuer = excluded.relay_issuer,
              environment_credential = excluded.environment_credential,
              label = excluded.label,
              connector_token = excluded.connector_token,
              tunnel_hostname = excluded.tunnel_hostname,
              relay_mint_public_key = excluded.relay_mint_public_key,
              updated_at = excluded.updated_at
          `;
				}).pipe(Effect.asVoid, Effect.mapError(toLanAuthError)),
			getRelayConfig: () =>
				Effect.gen(function* () {
					const rows = yield* sql<{
						readonly relay_url: string;
						readonly relay_issuer: string;
						readonly environment_id: string;
						readonly environment_credential: string;
						readonly label: string | null;
						readonly connector_token: string | null;
						readonly tunnel_hostname: string | null;
						readonly relay_mint_public_key: string | null;
					}>`
            SELECT relay_url, relay_issuer, environment_id, environment_credential, label, connector_token, tunnel_hostname, relay_mint_public_key
            FROM relay_config
            LIMIT 1
          `;
					const row = rows[0];
					if (row === undefined) return null;
					return {
						relayUrl: row.relay_url,
						relayIssuer: row.relay_issuer,
						environmentId: row.environment_id as EnvironmentId,
						environmentCredential: row.environment_credential,
						label: row.label ?? undefined,
						connectorToken: row.connector_token ?? undefined,
						tunnelHostname: row.tunnel_hostname ?? undefined,
						mintPublicKey: row.relay_mint_public_key ?? undefined,
					};
				}).pipe(Effect.mapError(toLanAuthError)),
			clearRelayConfig: () =>
				Effect.gen(function* () {
					yield* sql`DELETE FROM relay_config`;
				}).pipe(Effect.asVoid, Effect.mapError(toLanAuthError)),
		});

		return service;
	}),
);
