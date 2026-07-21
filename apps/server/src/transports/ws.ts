import * as http from "node:http";
import * as https from "node:https";
import { NodeHttpServer } from "@effect/platform-node";
import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { Effect, Layer, Schema } from "effect";
import {
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { CompactSign, importJWK } from "jose";
import {
	LanAuthService,
	type LanAuthServiceShape,
	PairingRedeemError,
} from "../lan-auth/services/lan-auth-service.ts";

const PairRequest = Schema.Struct({
	code: Schema.String,
	deviceId: Schema.optional(Schema.String),
	deviceLabel: Schema.optional(Schema.String),
});

const NearbyPairRequest = Schema.Struct({
	deviceId: Schema.String,
	deviceLabel: Schema.String,
	deviceModel: Schema.optional(Schema.String),
	devicePublicKey: Schema.String,
	ephemeralPublicKey: Schema.String,
	clientNonce: Schema.String,
	serverNonce: Schema.String,
	icloudTrustRecordId: Schema.optional(Schema.String),
	icloudTrustProof: Schema.optional(Schema.String),
	accountAssertion: Schema.optional(Schema.String),
});

const NearbyPairStatusRequest = Schema.Struct({ requestId: Schema.String });
const LocalIdentityRequest = Schema.Struct({ challenge: Schema.String });

type WsDiagnostic = (event: string, fields?: Record<string, unknown>) => void;

export type WsServerListeningAddress = {
	readonly host: string;
	readonly port: number;
};

export type WsServerProtocolOptions = {
	readonly port: number;
	readonly host?: string;
	readonly onDiagnostic?: WsDiagnostic;
	readonly onListening?: (address: WsServerListeningAddress) => void;
	readonly tls?: {
		readonly key: string | Buffer;
		readonly cert: string | Buffer;
	};
};

const json = (body: unknown, status: number) =>
	HttpServerResponse.json(body, { status }).pipe(Effect.orDie);

const bearerFromRequest = (
	request: HttpServerRequest.HttpServerRequest,
): string | null => {
	const auth = request.headers.authorization;
	if (auth?.toLowerCase().startsWith("bearer ")) {
		return auth.slice("bearer ".length).trim();
	}

	const url = new URL(request.url, "http://localhost");
	return url.searchParams.get("token");
};

const pairApp = (auth: LanAuthServiceShape, log: WsDiagnostic) =>
	Effect.gen(function* () {
		const body = yield* HttpServerRequest.schemaBodyJson(PairRequest).pipe(
			Effect.catch(() => Effect.fail("bad_request" as const)),
		);
		if (
			(body.deviceId !== undefined &&
				(body.deviceId.length === 0 || body.deviceId.length > 128)) ||
			(body.deviceLabel !== undefined && body.deviceLabel.length > 80)
		) {
			return yield* Effect.fail("bad_request" as const);
		}
		yield* Effect.sync(() => log("ws.pair.redeem.start"));
		const redeemed = yield* auth
			.redeemPairingCode(
				body.code,
				body.deviceId === undefined
					? undefined
					: { id: body.deviceId, label: body.deviceLabel },
			)
			.pipe(
				Effect.mapError((error) =>
					error instanceof PairingRedeemError ? error.reason : "internal",
				),
			);
		yield* Effect.sync(() =>
			log("ws.pair.redeem.ok", { environmentId: redeemed.environmentId }),
		);
		return yield* json(redeemed, 200);
	}).pipe(
		Effect.catch((error) => {
			log("ws.pair.redeem.fail", { reason: error });
			if (error === "expired_code") {
				return json({ error }, 410);
			}
			if (error === "bad_request") {
				return json({ error }, 400);
			}
			if (error === "invalid_code") {
				return json({ error }, 401);
			}
			return json({ error: "internal_error" }, 500);
		}),
	);

const nearbyPairRequestApp = (auth: LanAuthServiceShape, log: WsDiagnostic) =>
	Effect.gen(function* () {
		const body = yield* HttpServerRequest.schemaBodyJson(
			NearbyPairRequest,
		).pipe(Effect.catch(() => Effect.fail("bad_request" as const)));
		if (
			body.deviceId.length === 0 ||
			body.deviceId.length > 128 ||
			body.deviceLabel.length === 0 ||
			body.deviceLabel.length > 80 ||
			(body.deviceModel?.length ?? 0) > 80 ||
			body.devicePublicKey.length !== 43 ||
			!/^[A-Za-z0-9_-]+$/u.test(body.devicePublicKey) ||
			body.ephemeralPublicKey.length !== 43 ||
			!/^[A-Za-z0-9_-]+$/u.test(body.ephemeralPublicKey) ||
			body.clientNonce.length < 8 ||
			body.clientNonce.length > 128 ||
			body.serverNonce.length < 8 ||
			body.serverNonce.length > 128 ||
			(body.icloudTrustRecordId?.length ?? 0) > 128 ||
			(body.icloudTrustProof?.length ?? 0) > 128 ||
			(body.accountAssertion?.length ?? 0) > 8_192
		) {
			return yield* Effect.fail("bad_request" as const);
		}
		const request = yield* auth
			.requestNearbyPairing(body)
			.pipe(Effect.mapError((error) => error.reason));
		const keys = yield* auth.environmentKeys();
		yield* Effect.sync(() =>
			log("ws.pair.nearby.request", {
				requestId: request.requestId,
				deviceIdentifier: request.deviceIdentifier,
			}),
		);
		return yield* json({ request, environmentPublicKey: keys.publicJwk }, 200);
	}).pipe(
		Effect.catch((error) =>
			json(
				{ error },
				error === "bad_request"
					? 400
					: error === "nearby_request_busy"
						? 409
						: error === "nearby_device_blocked"
							? 403
							: error === "nearby_request_rate_limited"
								? 429
								: error === "nearby_challenge_invalid" ||
										error === "nearby_public_key_invalid" ||
										error === "nearby_account_assertion_invalid"
									? 400
									: 500,
			),
		),
	);

const nearbyPairChallengeApp = (auth: LanAuthServiceShape) =>
	auth.createNearbyPairingChallenge().pipe(
		Effect.flatMap((challenge) => json(challenge, 200)),
		Effect.catch(() => json({ error: "internal_error" }, 500)),
	);

const nearbyPairStatusApp = (auth: LanAuthServiceShape) =>
	Effect.gen(function* () {
		const body = yield* HttpServerRequest.schemaBodyJson(
			NearbyPairStatusRequest,
		).pipe(Effect.catch(() => Effect.fail("bad_request" as const)));
		const status = yield* auth
			.nearbyPairingStatus(body.requestId)
			.pipe(Effect.mapError(() => "internal" as const));
		return yield* json(status, 200);
	}).pipe(
		Effect.catch((error) =>
			json({ error }, error === "bad_request" ? 400 : 500),
		),
	);

const localIdentityApp = (auth: LanAuthServiceShape) =>
	Effect.gen(function* () {
		const { challenge } = yield* HttpServerRequest.schemaBodyJson(
			LocalIdentityRequest,
		).pipe(Effect.catch(() => Effect.fail("bad_request" as const)));
		if (challenge.length < 16 || challenge.length > 128) {
			return yield* json({ error: "bad_request" }, 400);
		}
		const keys = yield* auth.environmentKeys();
		const privateKey = yield* Effect.tryPromise(() =>
			importJWK(JSON.parse(keys.privateJwk), "EdDSA"),
		).pipe(Effect.orDie);
		const signature = yield* Effect.tryPromise(() =>
			new CompactSign(
				new TextEncoder().encode(`zuse-local-identity-v1|${challenge}`),
			)
				.setProtectedHeader({ alg: "EdDSA", typ: "zuse-local-identity+jws" })
				.sign(privateKey),
		).pipe(Effect.orDie);
		return yield* json({ publicKey: keys.publicJwk, signature }, 200);
	}).pipe(Effect.catch(() => json({ error: "internal_error" }, 500)));

/**
 * WebSocket RPC transport for the headless server.
 *
 * Protected mode owns the HTTP upgrade path so an unauthenticated client gets
 * a plain 401 response and never receives a live socket. Local mode preserves
 * the existing loopback developer behavior.
 */
export const wsServerProtocolLayer = (
	opts: WsServerProtocolOptions,
): Layer.Layer<RpcServer.Protocol, never, LanAuthService> =>
	Layer.effect(
		RpcServer.Protocol,
		Effect.gen(function* () {
			const auth = yield* LanAuthService;
			const log = opts.onDiagnostic ?? (() => {});
			yield* Effect.sync(() =>
				log("ws.bind.start", {
					host: opts.host ?? "127.0.0.1",
					port: opts.port,
					policy: auth.policy,
					pairingBootstrap: auth.pairingBootstrap,
				}),
			);

			const { protocol, httpEffect } =
				yield* RpcServer.makeProtocolWithHttpEffectWebsocket;

			const guarded = Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;
				const token = bearerFromRequest(request);
				yield* Effect.sync(() =>
					log("ws.request", {
						url: request.url,
						protected: auth.policy === "protected",
						hasToken: token !== null,
					}),
				);
				if (auth.policy === "protected") {
					const ok =
						token !== null &&
						(yield* auth
							.verifyToken(token)
							.pipe(Effect.orElseSucceed(() => false)));
					yield* Effect.sync(() =>
						log(ok ? "ws.auth.ok" : "ws.auth.fail", {
							url: request.url,
							hasToken: token !== null,
						}),
					);
					if (!ok) return yield* json({ error: "unauthorized" }, 401);
				}
				const requestUrl = new URL(request.url, "http://localhost");
				const receivedVersion = Number(
					requestUrl.searchParams.get("wireVersion"),
				);
				if (receivedVersion !== WIRE_PROTOCOL_VERSION) {
					log("ws.protocol.reject", {
						expectedVersion: WIRE_PROTOCOL_VERSION,
						receivedVersion: Number.isFinite(receivedVersion)
							? receivedVersion
							: null,
					});
					return yield* json(
						{
							error: "wire_protocol_mismatch",
							expectedVersion: WIRE_PROTOCOL_VERSION,
						},
						426,
					);
				}
				return yield* httpEffect;
			});

			const router = yield* HttpRouter.make;
			yield* router.add("GET", "/", guarded);
			// Existing relay deployments and previously linked environments may
			// still advertise `/rpc`. Keep accepting it while newer links use `/`.
			yield* router.add("GET", "/rpc", guarded);
			yield* router.add("POST", "/pair", pairApp(auth, log));
			yield* router.add(
				"POST",
				"/pair/challenge",
				nearbyPairChallengeApp(auth),
			);
			yield* router.add(
				"POST",
				"/pair/request",
				nearbyPairRequestApp(auth, log),
			);
			yield* router.add("POST", "/pair/status", nearbyPairStatusApp(auth));
			yield* router.add("POST", "/pair/identity", localIdentityApp(auth));

			yield* HttpServer.serveEffect(router.asHttpEffect()).pipe(
				Effect.forkScoped,
			);
			const server = yield* HttpServer.HttpServer;
			const listeningAddress =
				server.address._tag === "TcpAddress"
					? {
							host: server.address.hostname,
							port: server.address.port,
						}
					: null;
			yield* Effect.sync(() => {
				log("ws.bind.ok", {
					host: listeningAddress?.host ?? opts.host ?? "127.0.0.1",
					port: listeningAddress?.port ?? opts.port,
					policy: auth.policy,
				});
				if (listeningAddress !== null) opts.onListening?.(listeningAddress);
			});

			if (auth.policy === "protected" && auth.pairingBootstrap) {
				const pairing = yield* auth.createPairingCode();
				const redeemUrl = pairing.pairingUrl.replace(/^ws:/, "http:");
				yield* Effect.sync(() => {
					console.log("Zuse LAN pairing enabled");
					console.log(`QR: ${pairing.qrText}`);
					console.log(
						`Redeem with: POST ${redeemUrl}/pair {"code":"${pairing.code}"}`,
					);
				});
			}

			return protocol;
		}),
	).pipe(
		Layer.provide(
			NodeHttpServer.layer(
				() =>
					opts.tls === undefined
						? http.createServer()
						: https.createServer({ key: opts.tls.key, cert: opts.tls.cert }),
				{
					port: opts.port,
					host: opts.host ?? "127.0.0.1",
				},
			),
		),
		Layer.provide(RpcSerialization.layerJson),
		Layer.orDie,
	);
