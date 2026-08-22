import {
	DEFAULT_LOCAL_DESKTOP_PORT,
	type EnvironmentId,
	type RelayAccessToken,
	type RelayAuthorizedClientList,
	type RelayConnectGrant,
	type RelayEnvironmentList,
	RelayPaths,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import { Clock, Context, Data, Effect, Fiber, Layer, Ref } from "effect";

import { AccountAccessService } from "../account-access/service.ts";
import { AuthService } from "../auth/services/auth-service.ts";
import { buildAdvertisedEndpoints } from "../lan-auth/advertised-endpoints.ts";
import { defaultEnvironmentLabel } from "../lan-auth/environment-label.ts";
import {
	LanAuthConfig,
	type LanAuthConfigShape,
	LanAuthService,
} from "../lan-auth/services/lan-auth-service.ts";
import { TelemetryStore } from "../observability/telemetry-store.ts";
import { signEnvironmentLinkProof } from "./link-proof.ts";
import { ManagedTunnelRuntime } from "./managed-tunnel-runtime.ts";
import { appendRelayDiagnostic } from "./relay-diagnostics.ts";

const HEARTBEAT_INTERVAL = "30 seconds";
export const relayRuntimeMetadata = () =>
	({
		runtimeVersion: process.env.ZUSE_RUNTIME_VERSION?.trim() || "0.0.0",
		wireProtocolVersion: WIRE_PROTOCOL_VERSION,
		capabilities: {
			version: 1,
			features: [
				"agents",
				"chats",
				"files",
				"diffs",
				"terminals",
				"approvals",
				"questions",
				"notifications",
			],
		},
		serviceState: "healthy",
	}) as const;

export class RelayLinkError extends Data.TaggedError("RelayLinkError")<{
	readonly reason: string;
}> {}

export interface RelayLinkStatusValue {
	readonly linked: boolean;
	readonly relayUrl?: string;
	readonly environmentId?: EnvironmentId;
	readonly label?: string;
	readonly heartbeatActive: boolean;
	readonly advertisedEndpoints?: ReturnType<typeof buildAdvertisedEndpoints>;
}

/**
 * Server-side orchestration of the account-relay link. The desktop is already
 * WorkOS-signed-in and holds the environment's Ed25519 identity, so it links
 * itself directly: get a challenge, sign the Ed25519 proof, submit it, persist
 * the returned credential, and heartbeat so the relay reports presence. The
 * renderer just calls `relay.*` RPCs.
 */
export class RelayLinkService extends Context.Service<
	RelayLinkService,
	{
		readonly link: (input: {
			readonly relayUrl: string;
			readonly label?: string;
		}) => Effect.Effect<RelayLinkStatusValue, RelayLinkError>;
		readonly status: () => Effect.Effect<RelayLinkStatusValue, RelayLinkError>;
		readonly unlink: () => Effect.Effect<void, RelayLinkError>;
		readonly listEnvironments: () => Effect.Effect<
			RelayEnvironmentList,
			RelayLinkError
		>;
		readonly connectEnvironment: (
			environmentId: EnvironmentId,
		) => Effect.Effect<RelayConnectGrant, RelayLinkError>;
		readonly listClients: () => Effect.Effect<
			RelayAuthorizedClientList,
			RelayLinkError
		>;
		readonly revokeClient: (
			clientId: string,
		) => Effect.Effect<void, RelayLinkError>;
	}
>()("zuse/RelayLinkService") {}

const failRelay = (reason: string) => new RelayLinkError({ reason });

/** Account relay is intentionally unavailable for explicit no-account runs. */
export const makeDisabledRelayLinkService = (
	config: LanAuthConfigShape,
): Layer.Layer<RelayLinkService> => {
	const disabled = () => Effect.fail(failRelay("account_disabled"));
	return Layer.succeed(
		RelayLinkService,
		RelayLinkService.of({
			link: disabled,
			status: () =>
				Effect.succeed({
					linked: false,
					heartbeatActive: false,
					advertisedEndpoints: buildAdvertisedEndpoints({ lan: config }),
				}),
			unlink: disabled,
			listEnvironments: disabled,
			connectEnvironment: disabled,
			listClients: disabled,
			revokeClient: disabled,
		}),
	);
};

const relayHttpErrorReason = async (response: Response): Promise<string> => {
	const fallback = `relay_${response.status}`;
	const text = await response.text().catch(() => "");
	if (text.trim().length === 0) return fallback;
	try {
		const body = JSON.parse(text) as { readonly error?: unknown };
		if (typeof body.error === "string") {
			if (response.status === 401 && body.error === "invalid_workos_token") {
				return "relay_auth_rejected";
			}
			return `relay_${response.status}:${body.error}`;
		}
	} catch {
		// Fall through to the status-only reason; relay bodies should be JSON.
	}
	return fallback;
};

const postJson = <A>(
	url: string,
	opts: { readonly bearer: string; readonly body?: unknown },
): Effect.Effect<A, RelayLinkError> =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${opts.bearer}`,
					...(opts.body === undefined
						? {}
						: { "content-type": "application/json" }),
				},
				body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
			});
			if (!response.ok) {
				throw new Error(await relayHttpErrorReason(response));
			}
			return (await response.json()) as A;
		},
		catch: (cause) =>
			failRelay(cause instanceof Error ? cause.message : String(cause)),
	});

const accountJson = <A>(
	url: string,
	opts: { readonly bearer: string; readonly method?: "GET" | "DELETE" },
): Effect.Effect<A, RelayLinkError> =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(url, {
				method: opts.method ?? "GET",
				headers: { authorization: `Bearer ${opts.bearer}` },
			});
			if (!response.ok) {
				throw new Error(await relayHttpErrorReason(response));
			}
			return (await response.json()) as A;
		},
		catch: (cause) =>
			failRelay(cause instanceof Error ? cause.message : String(cause)),
	});

const computeEndpoint = (config: LanAuthConfigShape) => {
	const host = config.advertisedHost ?? "127.0.0.1";
	const port = config.port ?? DEFAULT_LOCAL_DESKTOP_PORT;
	return {
		httpBaseUrl: `http://${host}:${port}`,
		wsBaseUrl: `ws://${host}:${port}`,
	};
};

const computeOrigin = (config: LanAuthConfigShape) => ({
	localHttpHost: "127.0.0.1",
	localHttpPort: config.port ?? DEFAULT_LOCAL_DESKTOP_PORT,
});

export const RelayLinkServiceLive: Layer.Layer<
	RelayLinkService,
	never,
	| LanAuthService
	| LanAuthConfig
	| AuthService
	| AccountAccessService
	| ManagedTunnelRuntime
	| TelemetryStore
> = Layer.effect(
	RelayLinkService,
	Effect.gen(function* () {
		const auth = yield* LanAuthService;
		const config = yield* LanAuthConfig;
		const authService = yield* AuthService;
		const accountAccess = yield* AccountAccessService;
		const tunnel = yield* ManagedTunnelRuntime;
		const telemetry = yield* TelemetryStore;
		const heartbeatRef = yield* Ref.make<Fiber.Fiber<void> | null>(null);
		let relayAccess: {
			readonly token: string;
			readonly expiresAt: number;
		} | null = null;
		let relayAccessRefresh: Promise<string> | null = null;
		let relayClientRegistration: {
			readonly key: string;
			readonly promise: Promise<void>;
		} | null = null;
		const createDpopKey = async () => {
			const generated = await crypto.subtle.generateKey(
				{ name: "ECDSA", namedCurve: "P-256" },
				true,
				["sign", "verify"],
			);
			return {
				privateKey: generated.privateKey,
				publicJwk: await crypto.subtle.exportKey("jwk", generated.publicKey),
			};
		};
		let dpopKeyPromise: ReturnType<typeof createDpopKey> | null = null;
		const log = (event: string, fields?: Record<string, unknown>) =>
			appendRelayDiagnostic(telemetry, event, fields);

		const base64url = (input: Uint8Array): string =>
			Buffer.from(input).toString("base64url");
		const dpopKey = () => {
			dpopKeyPromise ??= createDpopKey();
			return dpopKeyPromise;
		};
		const signDpopProof = async (
			method: string,
			url: string,
		): Promise<string> => {
			const key = await dpopKey();
			const header = base64url(
				new TextEncoder().encode(
					JSON.stringify({
						alg: "ES256",
						typ: "dpop+jwt",
						jwk: key.publicJwk,
					}),
				),
			);
			const payload = base64url(
				new TextEncoder().encode(
					JSON.stringify({
						htm: method,
						htu: url,
						jti: crypto.randomUUID(),
						iat: Math.floor(Date.now() / 1_000),
					}),
				),
			);
			const unsigned = `${header}.${payload}`;
			const signature = await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				key.privateKey,
				new TextEncoder().encode(unsigned),
			);
			return `${unsigned}.${base64url(new Uint8Array(signature))}`;
		};
		const ensureRelayAccess = async (relayUrl: string): Promise<string> => {
			if (relayAccess !== null && relayAccess.expiresAt - Date.now() > 30_000) {
				return relayAccess.token;
			}
			if (relayAccessRefresh !== null) return relayAccessRefresh;
			const refresh = (async () => {
				const workosToken = await Effect.runPromise(
					authService.getAccessToken(),
				);
				const target = `${relayUrl}${RelayPaths.dpopToken}`;
				const response = await fetch(target, {
					method: "POST",
					headers: {
						authorization: `Bearer ${workosToken}`,
						dpop: await signDpopProof("POST", target),
					},
				});
				if (!response.ok) throw new Error(await relayHttpErrorReason(response));
				const grant = (await response.json()) as RelayAccessToken;
				relayAccess = {
					token: grant.accessToken,
					expiresAt: Date.now() + grant.expiresIn,
				};
				return grant.accessToken;
			})();
			relayAccessRefresh = refresh;
			try {
				return await refresh;
			} finally {
				if (relayAccessRefresh === refresh) relayAccessRefresh = null;
			}
		};
		const dpopRequest = async (
			relayUrl: string,
			path: string,
			body?: unknown,
		): Promise<Response> => {
			const target = `${relayUrl}${path}`;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const token = await ensureRelayAccess(relayUrl);
				const response = await fetch(target, {
					method: "POST",
					headers: {
						authorization: `DPoP ${token}`,
						dpop: await signDpopProof("POST", target),
						...(body === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				});
				if (response.status !== 401 || attempt > 0) return response;
				relayAccess = null;
			}
			throw new Error("relay_access_refresh_failed");
		};
		const ensureRelayClient = async (
			relayUrl: string,
			environmentId: EnvironmentId,
		): Promise<void> => {
			const registrationKey = `${relayUrl}:${environmentId}`;
			if (relayClientRegistration?.key === registrationKey) {
				return relayClientRegistration.promise;
			}
			const registration = (async () => {
				const key = await dpopKey();
				const response = await dpopRequest(relayUrl, RelayPaths.devices, {
					deviceId: `desktop-${environmentId}`,
					platform: "desktop",
					dpopJwk: key.publicJwk,
				});
				if (!response.ok) throw new Error(await relayHttpErrorReason(response));
			})();
			relayClientRegistration = {
				key: registrationKey,
				promise: registration,
			};
			try {
				await registration;
			} catch (cause) {
				if (relayClientRegistration?.promise === registration) {
					relayClientRegistration = null;
				}
				throw cause;
			}
		};

		yield* log("service.boot", {
			lanPolicy: config.policy,
			lanPort: config.port ?? null,
			advertisedHost: config.advertisedHost ?? null,
		});

		const heartbeatOnce = (input: {
			readonly relayUrl: string;
			readonly environmentId: EnvironmentId;
			readonly credential: string;
		}) =>
			Effect.gen(function* () {
				const url = `${input.relayUrl}${RelayPaths.heartbeat(input.environmentId)}`;
				const response = yield* postJson<{
					readonly machineAction?: "sanitize-credentials";
				}>(url, { bearer: input.credential, body: relayRuntimeMetadata() });
				if (response.machineAction !== "sanitize-credentials") return;
				yield* accountAccess
					.sanitizeCredentials()
					.pipe(Effect.mapError((error) => failRelay(error.code)));
				yield* postJson(url, {
					bearer: input.credential,
					body: {
						...relayRuntimeMetadata(),
						credentialCleanupComplete: true,
					},
				});
				yield* accountAccess
					.requestRuntimeStop()
					.pipe(Effect.mapError((error) => failRelay(error.code)));
			});

		const heartbeatLoop = (input: {
			readonly relayUrl: string;
			readonly environmentId: EnvironmentId;
			readonly credential: string;
		}) =>
			heartbeatOnce(input).pipe(
				Effect.ignore,
				Effect.andThen(Effect.sleep(HEARTBEAT_INTERVAL)),
				Effect.forever,
			);

		const startHeartbeat = Effect.fn("RelayLinkService.startHeartbeat")(
			function* (input: {
				readonly relayUrl: string;
				readonly environmentId: EnvironmentId;
				readonly credential: string;
			}) {
				const existing = yield* Ref.get(heartbeatRef);
				if (existing !== null) yield* Fiber.interrupt(existing);
				const fiber = yield* Effect.forkDetach(heartbeatLoop(input));
				yield* Ref.set(heartbeatRef, fiber);
			},
		);

		const stopHeartbeat = Effect.fn("RelayLinkService.stopHeartbeat")(
			function* () {
				const existing = yield* Ref.get(heartbeatRef);
				if (existing !== null) yield* Fiber.interrupt(existing);
				yield* Ref.set(heartbeatRef, null);
			},
		);

		const reconcileTunnelOrigin = (input: {
			readonly relayUrl: string;
			readonly environmentId: EnvironmentId;
			readonly credential: string;
		}) =>
			postJson<{ readonly ok: boolean }>(
				`${input.relayUrl}${RelayPaths.heartbeat(input.environmentId)}`,
				{
					bearer: input.credential,
					body: { origin: computeOrigin(config), ...relayRuntimeMetadata() },
				},
			);

		// Resume heartbeating (and the managed-tunnel connector) on boot if linked.
		const existing = yield* auth
			.getRelayConfig()
			.pipe(Effect.orElseSucceed(() => null));
		if (existing !== null) {
			yield* log("service.existing_config", {
				environmentId: existing.environmentId,
				relayUrl: existing.relayUrl,
				hasConnectorToken: existing.connectorToken !== undefined,
				tunnelHostname: existing.tunnelHostname ?? null,
			});
			if (existing.connectorToken !== undefined) {
				// The desktop's HTTP port can change between app versions or dev
				// launches. Repair the existing tunnel ingress before starting its
				// connector so a successful WebSocket upgrade always reaches this
				// runtime rather than whatever now owns the old port.
				yield* log("service.existing_tunnel_reconcile", {
					environmentId: existing.environmentId,
					origin: computeOrigin(config),
				});
				yield* reconcileTunnelOrigin({
					relayUrl: existing.relayUrl,
					environmentId: existing.environmentId,
					credential: existing.environmentCredential,
				}).pipe(
					Effect.tap(() => log("service.existing_tunnel_reconcile.ok")),
					Effect.tapError((error) =>
						log("service.existing_tunnel_reconcile.fail", {
							reason: error.reason,
						}),
					),
					// Non-fatal on boot: presence and LAN access must still work while
					// the relay or tunnel control plane is temporarily unavailable.
					Effect.ignore,
				);
				// Non-fatal on boot: if cloudflared is missing the desktop still works
				// on LAN; the tunnel just won't come up until relinked.
				yield* log("service.existing_tunnel_start");
				yield* tunnel.start(existing.connectorToken).pipe(
					Effect.tap(() => log("service.existing_tunnel_start.ok")),
					Effect.tapError((error) =>
						log("service.existing_tunnel_start.fail", { reason: error.reason }),
					),
					Effect.ignore,
				);
			}
			yield* startHeartbeat({
				relayUrl: existing.relayUrl,
				environmentId: existing.environmentId,
				credential: existing.environmentCredential,
			});
		}

		return RelayLinkService.of({
			link: (input) =>
				Effect.gen(function* () {
					relayAccess = null;
					relayClientRegistration = null;
					yield* log("link.start", {
						relayUrl: input.relayUrl,
						hasLabel: input.label !== undefined && input.label.length > 0,
					});
					// Give relay-listed environments the same human name as LAN clients.
					const label = input.label ?? (yield* defaultEnvironmentLabel());
					const token = yield* authService
						.getAccessToken()
						.pipe(
							Effect.tap(() => log("link.access_token.ok")),
							Effect.tapError((error) =>
								log("link.access_token.fail", { error }),
							),
						)
						.pipe(Effect.mapError(() => failRelay("not_signed_in")));
					const keys = yield* auth
						.environmentKeys()
						.pipe(
							Effect.tap((value) =>
								log("link.environment_keys.ok", {
									environmentId: value.envId,
								}),
							),
							Effect.tapError((error) =>
								log("link.environment_keys.fail", { reason: error.reason }),
							),
						)
						.pipe(Effect.mapError((error) => failRelay(error.reason)));

					yield* log("link.challenge.post");
					const challenge = yield* postJson<{
						readonly challengeId: string;
						readonly challenge: string;
						readonly relayIssuer: string;
					}>(`${input.relayUrl}${RelayPaths.linkChallenges}`, {
						bearer: token,
					}).pipe(
						Effect.tap((value) =>
							log("link.challenge.ok", {
								challengeId: value.challengeId,
								relayIssuer: value.relayIssuer,
							}),
						),
						Effect.tapError((error) =>
							log("link.challenge.fail", { reason: error.reason }),
						),
					);

					const nowMs = yield* Clock.currentTimeMillis;
					const proof = yield* signEnvironmentLinkProof({
						privateJwk: keys.privateJwk,
						challenge: challenge.challenge,
						environmentId: keys.envId,
						relayIssuer: challenge.relayIssuer,
						nowMs,
					});
					yield* log("link.proof.ok", {
						environmentId: keys.envId,
						relayIssuer: challenge.relayIssuer,
					});

					yield* log("link.environment.post", {
						endpoint: computeEndpoint(config),
						origin: computeOrigin(config),
						managedTunnel: true,
					});
					const linked = yield* postJson<{
						readonly environmentCredential: string;
						readonly relayIssuer: string;
						readonly mintPublicKey: string;
						readonly tunnelHostname?: string;
						readonly connectorToken?: string;
					}>(`${input.relayUrl}${RelayPaths.links}`, {
						bearer: token,
						body: {
							challengeId: challenge.challengeId,
							proof,
							environmentId: keys.envId,
							environmentPublicKey: keys.publicJwk,
							providerKind: "desktop",
							endpoint: computeEndpoint(config),
							label,
							...relayRuntimeMetadata(),
							// Ask the relay to provision a managed Cloudflare tunnel so the
							// phone can reach this Mac from anywhere. If the relay has tunnels
							// disabled it simply returns no connector token and we stay on LAN.
							managedTunnel: true,
							origin: computeOrigin(config),
						},
					}).pipe(
						Effect.tap((value) =>
							log("link.environment.ok", {
								relayIssuer: value.relayIssuer,
								hasConnectorToken: value.connectorToken !== undefined,
								tunnelHostname: value.tunnelHostname ?? null,
							}),
						),
						Effect.tapError((error) =>
							log("link.environment.fail", { reason: error.reason }),
						),
					);

					// Launch the connector before persisting so a missing `cloudflared`
					// surfaces as a link error rather than a silently-dead tunnel.
					if (linked.connectorToken !== undefined) {
						yield* log("link.tunnel_start");
						yield* tunnel
							.start(linked.connectorToken)
							.pipe(
								Effect.tap(() =>
									log("link.tunnel_start.ok", {
										tunnelHostname: linked.tunnelHostname ?? null,
									}),
								),
								Effect.tapError((error) =>
									log("link.tunnel_start.fail", { reason: error.reason }),
								),
							)
							.pipe(Effect.mapError((error) => failRelay(error.reason)));
					}

					yield* log("link.save_config");
					yield* auth
						.saveRelayConfig({
							relayUrl: input.relayUrl,
							relayIssuer: linked.relayIssuer,
							environmentId: keys.envId,
							environmentCredential: linked.environmentCredential,
							label,
							connectorToken: linked.connectorToken,
							tunnelHostname: linked.tunnelHostname,
							mintPublicKey: linked.mintPublicKey,
						})
						.pipe(
							Effect.tap(() =>
								log("link.save_config.ok", {
									environmentId: keys.envId,
									tunnelHostname: linked.tunnelHostname ?? null,
									hasConnectorToken: linked.connectorToken !== undefined,
								}),
							),
							Effect.tapError((error) =>
								log("link.save_config.fail", { reason: error.reason }),
							),
						)
						.pipe(Effect.mapError((error) => failRelay(error.reason)));

					yield* startHeartbeat({
						relayUrl: input.relayUrl,
						environmentId: keys.envId,
						credential: linked.environmentCredential,
					});
					yield* log("link.heartbeat.started", { environmentId: keys.envId });

					yield* log("link.success", {
						environmentId: keys.envId,
						tunnelHostname: linked.tunnelHostname ?? null,
					});
					return {
						linked: true,
						relayUrl: input.relayUrl,
						environmentId: keys.envId,
						label,
						heartbeatActive: true,
						advertisedEndpoints: buildAdvertisedEndpoints({
							lan: config,
							relay: {
								linked: true,
								heartbeatActive: true,
								tunnelHostname: linked.tunnelHostname,
							},
						}),
					} satisfies RelayLinkStatusValue;
				}),
			status: () =>
				Effect.gen(function* () {
					const cfg = yield* auth
						.getRelayConfig()
						.pipe(Effect.mapError((error) => failRelay(error.reason)));
					const active = (yield* Ref.get(heartbeatRef)) !== null;
					if (cfg === null) {
						yield* log("status.unlinked", { heartbeatActive: active });
						return {
							linked: false,
							heartbeatActive: false,
							advertisedEndpoints: buildAdvertisedEndpoints({ lan: config }),
						} satisfies RelayLinkStatusValue;
					}
					yield* log("status.linked", {
						environmentId: cfg.environmentId,
						relayUrl: cfg.relayUrl,
						heartbeatActive: active,
						hasConnectorToken: cfg.connectorToken !== undefined,
						tunnelHostname: cfg.tunnelHostname ?? null,
					});
					return {
						linked: true,
						relayUrl: cfg.relayUrl,
						environmentId: cfg.environmentId,
						label: cfg.label,
						heartbeatActive: active,
						advertisedEndpoints: buildAdvertisedEndpoints({
							lan: config,
							relay: {
								linked: true,
								heartbeatActive: active,
								tunnelHostname: cfg.tunnelHostname,
							},
						}),
					} satisfies RelayLinkStatusValue;
				}),
			listEnvironments: () =>
				Effect.gen(function* () {
					const cfg = yield* auth
						.getRelayConfig()
						.pipe(Effect.mapError((error) => failRelay(error.reason)));
					if (cfg === null) return yield* Effect.fail(failRelay("not_linked"));
					const token = yield* authService
						.getAccessToken()
						.pipe(Effect.mapError(() => failRelay("not_signed_in")));
					return yield* accountJson<RelayEnvironmentList>(
						`${cfg.relayUrl}${RelayPaths.environments}`,
						{ bearer: token },
					);
				}),
			connectEnvironment: (environmentId) =>
				Effect.tryPromise({
					try: async () => {
						const cfg = await Effect.runPromise(auth.getRelayConfig());
						if (cfg === null) throw new Error("not_linked");
						await ensureRelayClient(cfg.relayUrl, cfg.environmentId);
						const response = await dpopRequest(
							cfg.relayUrl,
							RelayPaths.connect(environmentId),
							{
								wireProtocolVersion: WIRE_PROTOCOL_VERSION,
								requireManaged: true,
							},
						);
						if (!response.ok)
							throw new Error(await relayHttpErrorReason(response));
						return (await response.json()) as RelayConnectGrant;
					},
					catch: (cause) =>
						failRelay(cause instanceof Error ? cause.message : String(cause)),
				}),
			listClients: () =>
				Effect.gen(function* () {
					const cfg = yield* auth
						.getRelayConfig()
						.pipe(Effect.mapError((error) => failRelay(error.reason)));
					if (cfg === null) return yield* Effect.fail(failRelay("not_linked"));
					const token = yield* authService
						.getAccessToken()
						.pipe(Effect.mapError(() => failRelay("not_signed_in")));
					return yield* accountJson<RelayAuthorizedClientList>(
						`${cfg.relayUrl}${RelayPaths.clients}`,
						{ bearer: token },
					);
				}),
			revokeClient: (clientId) =>
				Effect.gen(function* () {
					const cfg = yield* auth
						.getRelayConfig()
						.pipe(Effect.mapError((error) => failRelay(error.reason)));
					if (cfg === null) return yield* Effect.fail(failRelay("not_linked"));
					const token = yield* authService
						.getAccessToken()
						.pipe(Effect.mapError(() => failRelay("not_signed_in")));
					yield* accountJson<{ readonly ok: boolean }>(
						`${cfg.relayUrl}${RelayPaths.client(clientId)}`,
						{ bearer: token, method: "DELETE" },
					);
				}),
			unlink: () =>
				Effect.gen(function* () {
					relayAccess = null;
					relayClientRegistration = null;
					yield* log("unlink.start");
					const cfg = yield* auth
						.getRelayConfig()
						.pipe(Effect.orElseSucceed(() => null));
					yield* stopHeartbeat();
					yield* tunnel
						.stop()
						.pipe(Effect.mapError((error) => failRelay(error.reason)));
					// Best-effort relay deprovision (tears down the Cloudflare tunnel +
					// removes the environment from the account). Local unlink proceeds
					// even if the relay is unreachable or we're signed out.
					if (cfg !== null) {
						yield* authService.getAccessToken().pipe(
							Effect.flatMap((token) =>
								postJson<unknown>(`${cfg.relayUrl}${RelayPaths.unlink}`, {
									bearer: token,
									body: { environmentId: cfg.environmentId },
								}),
							),
							Effect.ignore,
						);
						yield* log("unlink.relay_deprovision.done", {
							environmentId: cfg.environmentId,
						});
					}
					yield* auth
						.clearRelayConfig()
						.pipe(Effect.mapError((error) => failRelay(error.reason)));
					yield* log("unlink.success");
				}),
		});
	}),
);
