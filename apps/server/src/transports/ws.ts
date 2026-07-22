import { randomUUID } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";
import { NodeHttpServer } from "@effect/platform-node";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
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
import {
	BROWSER_SECURITY_HEADERS,
	type BrowserRequestSecurity,
	browserCookieName,
	browserSessionCookie,
	clearedBrowserSessionCookie,
	hasValidRequestOrigin,
	isSecureRequest,
	PairingRateLimiter,
	readStaticAsset,
	requestRequiresAuthentication,
	WebSocketTicketStore,
} from "./browser-http.ts";

const PairRequest = Schema.Struct({
	code: Schema.String,
	deviceId: Schema.optional(Schema.String),
	deviceLabel: Schema.optional(Schema.String),
});

const BrowserSessionRequest = Schema.Struct({
	credential: Schema.String,
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
	readonly onPairing?: (pairing: {
		readonly browserUrl: string;
		readonly expiresAt: Date;
	}) => void;
	/** Production client root. Missing files fall back to index.html for the SPA. */
	readonly staticDir?: string;
	/** In development, browser navigations are redirected to this Vite origin. */
	readonly devServerUrl?: string;
	/** Honor forwarding headers only when the listener is behind a trusted proxy. */
	readonly trustProxy?: boolean;
	readonly tls?: {
		readonly key: string | Buffer;
		readonly cert: string | Buffer;
	};
};

const json = (body: unknown, status: number) =>
	HttpServerResponse.json(body, { status }).pipe(Effect.orDie);

const jsonWithHeaders = (
	body: unknown,
	status: number,
	headers: Readonly<Record<string, string>>,
) => HttpServerResponse.json(body, { status, headers }).pipe(Effect.orDie);

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

const requestClientKey = (
	request: HttpServerRequest.HttpServerRequest,
	trustProxy: boolean,
): string =>
	(trustProxy
		? request.headers["x-forwarded-for"]?.split(",")[0]?.trim()
		: undefined) ??
	request.headers["user-agent"] ??
	"unknown";

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

const sessionCredential = (
	request: HttpServerRequest.HttpServerRequest,
	cookieName: string,
): string | null => request.cookies[cookieName] ?? null;

const browserSessionStatusApp = (
	auth: LanAuthServiceShape,
	cookieName: string,
	security: BrowserRequestSecurity,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const authRequired = requestRequiresAuthentication(
			auth.policy,
			request.headers,
			security.trustProxy,
		);
		if (!authRequired) {
			return yield* jsonWithHeaders(
				{ authenticated: true, authRequired: false },
				200,
				{ "cache-control": "no-store" },
			);
		}
		const credential = sessionCredential(request, cookieName);
		const authenticated =
			credential !== null &&
			(yield* auth
				.verifyToken(credential)
				.pipe(Effect.orElseSucceed(() => false)));
		return yield* jsonWithHeaders({ authenticated, authRequired: true }, 200, {
			"cache-control": "no-store",
		});
	});

const browserSessionExchangeApp = (
	auth: LanAuthServiceShape,
	cookieName: string,
	rateLimiter: PairingRateLimiter,
	log: WsDiagnostic,
	security: BrowserRequestSecurity,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (!hasValidRequestOrigin(request.headers, security)) {
			return yield* json({ error: "invalid_origin" }, 403);
		}
		if (!rateLimiter.allow(requestClientKey(request, security.trustProxy))) {
			return yield* json({ error: "rate_limited" }, 429);
		}
		const body = yield* HttpServerRequest.schemaBodyJson(
			BrowserSessionRequest,
		).pipe(Effect.catch(() => Effect.fail("bad_request" as const)));
		if (body.credential.length < 8 || body.credential.length > 256) {
			return yield* Effect.fail("bad_request" as const);
		}
		const redeemed = yield* auth
			.redeemPairingCode(body.credential, {
				id: `browser_${randomUUID()}`,
				label: "Browser",
			})
			.pipe(
				Effect.mapError((error) =>
					error instanceof PairingRedeemError ? error.reason : "internal",
				),
			);
		log("browser.auth.paired", { environmentId: redeemed.environmentId });
		return yield* jsonWithHeaders(
			{
				authenticated: true,
				authRequired: requestRequiresAuthentication(
					auth.policy,
					request.headers,
					security.trustProxy,
				),
				environmentId: redeemed.environmentId,
			},
			200,
			{
				"set-cookie": browserSessionCookie(
					cookieName,
					redeemed.token,
					isSecureRequest(request.headers, security),
				),
				"cache-control": "no-store",
			},
		);
	}).pipe(
		Effect.catch((error) => {
			if (error === "expired_code") return json({ error }, 410);
			if (error === "invalid_code") return json({ error }, 401);
			if (error === "bad_request") return json({ error }, 400);
			return json({ error: "internal_error" }, 500);
		}),
	);

const websocketTicketApp = (
	auth: LanAuthServiceShape,
	cookieName: string,
	tickets: WebSocketTicketStore,
	security: BrowserRequestSecurity,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (!hasValidRequestOrigin(request.headers, security)) {
			return yield* json({ error: "invalid_origin" }, 403);
		}
		if (
			!requestRequiresAuthentication(
				auth.policy,
				request.headers,
				security.trustProxy,
			)
		) {
			return yield* json(tickets.issue("local"), 200);
		}
		const credential = sessionCredential(request, cookieName);
		const authenticated =
			credential !== null &&
			(yield* auth
				.verifyToken(credential)
				.pipe(Effect.orElseSucceed(() => false)));
		if (!authenticated || credential === null) {
			return yield* json({ error: "unauthorized" }, 401);
		}
		return yield* json(tickets.issue(credential), 200);
	});

const browserLogoutApp = (
	cookieName: string,
	security: BrowserRequestSecurity,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (!hasValidRequestOrigin(request.headers, security)) {
			return yield* json({ error: "invalid_origin" }, 403);
		}
		return yield* jsonWithHeaders({ authenticated: false }, 200, {
			"set-cookie": clearedBrowserSessionCookie(
				cookieName,
				isSecureRequest(request.headers, security),
			),
			"cache-control": "no-store",
		});
	});

const browserClientApp = (
	request: HttpServerRequest.HttpServerRequest,
	opts: Pick<WsServerProtocolOptions, "devServerUrl" | "staticDir">,
) =>
	Effect.promise(async () => {
		if (opts.devServerUrl !== undefined) {
			const destination = new URL(request.url, opts.devServerUrl);
			return HttpServerResponse.redirect(destination, { status: 307 });
		}
		const pathname = new URL(request.url, "http://localhost").pathname;
		const asset = await readStaticAsset(opts.staticDir ?? "", pathname);
		if (asset === "invalid") {
			return HttpServerResponse.jsonUnsafe(
				{ error: "bad_request" },
				{ status: 400 },
			);
		}
		if (asset === null) {
			return HttpServerResponse.jsonUnsafe(
				{ error: "not_found" },
				{ status: 404 },
			);
		}
		return HttpServerResponse.uint8Array(asset.body, {
			contentType: asset.contentType,
			headers: { "cache-control": asset.cacheControl },
		});
	});

/**
 * WebSocket RPC transport for the headless server.
 *
 * Protected mode owns the HTTP upgrade path so an unauthenticated client gets
 * a plain 401 response and never receives a live socket. Local mode preserves
 * the existing loopback developer behavior.
 */
export const wsServerProtocolLayer = (
	opts: WsServerProtocolOptions,
): Layer.Layer<RpcServer.Protocol, never, LanAuthService | AttachmentService> =>
	Layer.effect(
		RpcServer.Protocol,
		Effect.gen(function* () {
			const auth = yield* LanAuthService;
			const attachments = yield* AttachmentService;
			const log = opts.onDiagnostic ?? (() => {});
			const environmentId = yield* auth.environmentId();
			const relay = yield* auth
				.getRelayConfig()
				.pipe(Effect.orElseSucceed(() => null));
			const browserSecurity: BrowserRequestSecurity = {
				tls: opts.tls !== undefined,
				// Forwarding headers are security-sensitive and are honored only for
				// the managed relay connection configured by this environment.
				trustProxy: opts.trustProxy ?? relay?.tunnelHostname !== undefined,
			};
			const cookieName = browserCookieName(environmentId);
			const tickets = new WebSocketTicketStore();
			const pairingRateLimiter = new PairingRateLimiter();
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
				if (
					request.headers.upgrade?.toLowerCase() !== "websocket" &&
					(opts.staticDir !== undefined || opts.devServerUrl !== undefined)
				) {
					return yield* browserClientApp(request, opts);
				}
				const requestUrl = new URL(request.url, "http://localhost");
				const ticket = requestUrl.searchParams.get("ticket");
				const ticketCredential =
					ticket === null ? null : tickets.consume(ticket);
				const token =
					ticketCredential === "local"
						? null
						: (ticketCredential ?? bearerFromRequest(request));
				yield* Effect.sync(() =>
					log("ws.request", {
						url: request.url,
						protected: auth.policy === "protected",
						hasToken: token !== null,
					}),
				);
				if (
					requestRequiresAuthentication(
						auth.policy,
						request.headers,
						browserSecurity.trustProxy,
					)
				) {
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
			yield* router.add(
				"GET",
				"/auth/session",
				browserSessionStatusApp(auth, cookieName, browserSecurity),
			);
			yield* router.add(
				"POST",
				"/auth/browser-session",
				browserSessionExchangeApp(
					auth,
					cookieName,
					pairingRateLimiter,
					log,
					browserSecurity,
				),
			);
			yield* router.add(
				"POST",
				"/auth/websocket-ticket",
				websocketTicketApp(auth, cookieName, tickets, browserSecurity),
			);
			yield* router.add(
				"POST",
				"/auth/logout",
				browserLogoutApp(cookieName, browserSecurity),
			);
			yield* router.add("GET", "/assets/attachments/*", (request) =>
				Effect.gen(function* () {
					const credential = sessionCredential(request, cookieName);
					if (
						requestRequiresAuthentication(
							auth.policy,
							request.headers,
							browserSecurity.trustProxy,
						)
					) {
						const authenticated =
							credential !== null &&
							(yield* auth
								.verifyToken(credential)
								.pipe(Effect.orElseSucceed(() => false)));
						if (!authenticated) {
							return yield* json({ error: "unauthorized" }, 401);
						}
					}
					const pathname = new URL(request.url, "http://localhost").pathname;
					let id: string;
					try {
						id = decodeURIComponent(
							pathname.slice("/assets/attachments/".length),
						);
					} catch {
						return yield* json({ error: "bad_request" }, 400);
					}
					if (!/^[a-zA-Z0-9_-]{1,180}$/u.test(id)) {
						return yield* json({ error: "bad_request" }, 400);
					}
					const asset = yield* attachments.read(id);
					if (asset === null) return yield* json({ error: "not_found" }, 404);
					return HttpServerResponse.uint8Array(asset.bytes, {
						contentType: asset.mimeType,
						headers: { "cache-control": "private, max-age=3600" },
					});
				}),
			);

			if (opts.staticDir !== undefined || opts.devServerUrl !== undefined) {
				yield* router.add("GET", "*", (request) =>
					browserClientApp(request, opts),
				);
			}
			yield* router.addGlobalMiddleware((response) =>
				response.pipe(
					Effect.map(HttpServerResponse.setHeaders(BROWSER_SECURITY_HEADERS)),
				),
			);

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

			if (
				(auth.policy === "protected" || relay?.tunnelHostname !== undefined) &&
				auth.pairingBootstrap
			) {
				const pairing = yield* auth.createPairingCode();
				const browserUrl =
					relay?.tunnelHostname === undefined
						? pairing.browserUrl
						: `https://${relay.tunnelHostname}/#pair=${encodeURIComponent(pairing.code)}`;
				const redeemUrl = pairing.pairingUrl.replace(/^ws:/, "http:");
				yield* Effect.sync(() => {
					console.log("Zuse browser pairing enabled");
					console.log(`Browser: ${browserUrl}`);
					console.log(`Expires: ${pairing.expiresAt.toISOString()}`);
					console.log(
						`Remote access: ${relay?.tunnelHostname === undefined ? "inactive" : "active"}`,
					);
					console.log(`QR: ${pairing.qrText}`);
					console.log(
						`Redeem with: POST ${redeemUrl}/pair {"code":"${pairing.code}"}`,
					);
					opts.onPairing?.({ browserUrl, expiresAt: pairing.expiresAt });
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
