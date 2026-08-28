import {
	type ApiAccessToken,
	type ApiAuthorizedClientList,
	type ApiConnectGrant,
	type ApiEnvironmentList,
	ApiPaths,
	DEFAULT_LOCAL_DESKTOP_PORT,
	type EnvironmentId,
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
import { appendApiDiagnostic } from "./api-diagnostics.ts";
import { signEnvironmentLinkProof } from "./link-proof.ts";
import { ManagedTunnelRuntime } from "./managed-tunnel-runtime.ts";

const HEARTBEAT_INTERVAL = "30 seconds";
export const apiRuntimeMetadata = () =>
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

export class ApiLinkError extends Data.TaggedError("ApiLinkError")<{
	readonly reason: string;
}> {}

export interface ApiLinkStatusValue {
	readonly linked: boolean;
	readonly apiUrl?: string;
	readonly environmentId?: EnvironmentId;
	readonly label?: string;
	readonly heartbeatActive: boolean;
	readonly advertisedEndpoints?: ReturnType<typeof buildAdvertisedEndpoints>;
}

/**
 * Server-side orchestration of the account-api link. The desktop is already
 * WorkOS-signed-in and holds the environment's Ed25519 identity, so it links
 * itself directly: get a challenge, sign the Ed25519 proof, submit it, persist
 * the returned credential, and heartbeat so the api reports presence. The
 * renderer just calls `api.*` RPCs.
 */
export class ApiLinkService extends Context.Service<
	ApiLinkService,
	{
		readonly link: (input: {
			readonly apiUrl: string;
			readonly label?: string;
		}) => Effect.Effect<ApiLinkStatusValue, ApiLinkError>;
		readonly status: () => Effect.Effect<ApiLinkStatusValue, ApiLinkError>;
		readonly unlink: () => Effect.Effect<void, ApiLinkError>;
		readonly listEnvironments: () => Effect.Effect<
			ApiEnvironmentList,
			ApiLinkError
		>;
		readonly connectEnvironment: (
			environmentId: EnvironmentId,
		) => Effect.Effect<ApiConnectGrant, ApiLinkError>;
		readonly listClients: () => Effect.Effect<
			ApiAuthorizedClientList,
			ApiLinkError
		>;
		readonly revokeClient: (
			clientId: string,
		) => Effect.Effect<void, ApiLinkError>;
	}
>()("zuse/ApiLinkService") {}

const failApi = (reason: string) => new ApiLinkError({ reason });

/** Account api is intentionally unavailable for explicit no-account runs. */
export const makeDisabledApiLinkService = (
	config: LanAuthConfigShape,
): Layer.Layer<ApiLinkService> => {
	const disabled = () => Effect.fail(failApi("account_disabled"));
	return Layer.succeed(
		ApiLinkService,
		ApiLinkService.of({
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

const apiHttpErrorReason = async (response: Response): Promise<string> => {
	const fallback = `api_${response.status}`;
	const text = await response.text().catch(() => "");
	if (text.trim().length === 0) return fallback;
	try {
		const body = JSON.parse(text) as { readonly error?: unknown };
		if (typeof body.error === "string") {
			if (response.status === 401 && body.error === "invalid_workos_token") {
				return "api_auth_rejected";
			}
			return `api_${response.status}:${body.error}`;
		}
	} catch {
		// Fall through to the status-only reason; api bodies should be JSON.
	}
	return fallback;
};

const postJson = <A>(
	url: string,
	opts: { readonly bearer: string; readonly body?: unknown },
): Effect.Effect<A, ApiLinkError> =>
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
				throw new Error(await apiHttpErrorReason(response));
			}
			return (await response.json()) as A;
		},
		catch: (cause) =>
			failApi(cause instanceof Error ? cause.message : String(cause)),
	});

const accountJson = <A>(
	url: string,
	opts: { readonly bearer: string; readonly method?: "GET" | "DELETE" },
): Effect.Effect<A, ApiLinkError> =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(url, {
				method: opts.method ?? "GET",
				headers: { authorization: `Bearer ${opts.bearer}` },
			});
			if (!response.ok) {
				throw new Error(await apiHttpErrorReason(response));
			}
			return (await response.json()) as A;
		},
		catch: (cause) =>
			failApi(cause instanceof Error ? cause.message : String(cause)),
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

export const ApiLinkServiceLive: Layer.Layer<
	ApiLinkService,
	never,
	| LanAuthService
	| LanAuthConfig
	| AuthService
	| AccountAccessService
	| ManagedTunnelRuntime
	| TelemetryStore
> = Layer.effect(
	ApiLinkService,
	Effect.gen(function* () {
		const auth = yield* LanAuthService;
		const config = yield* LanAuthConfig;
		const authService = yield* AuthService;
		const accountAccess = yield* AccountAccessService;
		const tunnel = yield* ManagedTunnelRuntime;
		const telemetry = yield* TelemetryStore;
		const heartbeatRef = yield* Ref.make<Fiber.Fiber<void> | null>(null);
		let apiAccess: {
			readonly token: string;
			readonly expiresAt: number;
		} | null = null;
		let apiAccessRefresh: Promise<string> | null = null;
		let apiClientRegistration: {
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
			appendApiDiagnostic(telemetry, event, fields);

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
		const ensureApiAccess = async (apiUrl: string): Promise<string> => {
			if (apiAccess !== null && apiAccess.expiresAt - Date.now() > 30_000) {
				return apiAccess.token;
			}
			if (apiAccessRefresh !== null) return apiAccessRefresh;
			const refresh = (async () => {
				const workosToken = await Effect.runPromise(
					authService.getAccessToken(),
				);
				const target = `${apiUrl}${ApiPaths.dpopToken}`;
				const response = await fetch(target, {
					method: "POST",
					headers: {
						authorization: `Bearer ${workosToken}`,
						dpop: await signDpopProof("POST", target),
					},
				});
				if (!response.ok) throw new Error(await apiHttpErrorReason(response));
				const grant = (await response.json()) as ApiAccessToken;
				apiAccess = {
					token: grant.accessToken,
					expiresAt: Date.now() + grant.expiresIn,
				};
				return grant.accessToken;
			})();
			apiAccessRefresh = refresh;
			try {
				return await refresh;
			} finally {
				if (apiAccessRefresh === refresh) apiAccessRefresh = null;
			}
		};
		const dpopRequest = async (
			apiUrl: string,
			path: string,
			body?: unknown,
		): Promise<Response> => {
			const target = `${apiUrl}${path}`;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const token = await ensureApiAccess(apiUrl);
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
				apiAccess = null;
			}
			throw new Error("api_access_refresh_failed");
		};
		const ensureApiClient = async (
			apiUrl: string,
			environmentId: EnvironmentId,
		): Promise<void> => {
			const registrationKey = `${apiUrl}:${environmentId}`;
			if (apiClientRegistration?.key === registrationKey) {
				return apiClientRegistration.promise;
			}
			const registration = (async () => {
				const key = await dpopKey();
				const response = await dpopRequest(apiUrl, ApiPaths.devices, {
					deviceId: `desktop-${environmentId}`,
					platform: "desktop",
					dpopJwk: key.publicJwk,
				});
				if (!response.ok) throw new Error(await apiHttpErrorReason(response));
			})();
			apiClientRegistration = {
				key: registrationKey,
				promise: registration,
			};
			try {
				await registration;
			} catch (cause) {
				if (apiClientRegistration?.promise === registration) {
					apiClientRegistration = null;
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
			readonly apiUrl: string;
			readonly environmentId: EnvironmentId;
			readonly credential: string;
		}) =>
			Effect.gen(function* () {
				const url = `${input.apiUrl}${ApiPaths.heartbeat(input.environmentId)}`;
				const response = yield* postJson<{
					readonly machineAction?: "sanitize-credentials";
				}>(url, { bearer: input.credential, body: apiRuntimeMetadata() });
				if (response.machineAction !== "sanitize-credentials") return;
				yield* accountAccess
					.sanitizeCredentials()
					.pipe(Effect.mapError((error) => failApi(error.code)));
				yield* postJson(url, {
					bearer: input.credential,
					body: {
						...apiRuntimeMetadata(),
						credentialCleanupComplete: true,
					},
				});
				yield* accountAccess
					.requestRuntimeStop()
					.pipe(Effect.mapError((error) => failApi(error.code)));
			});

		const heartbeatLoop = (input: {
			readonly apiUrl: string;
			readonly environmentId: EnvironmentId;
			readonly credential: string;
		}) =>
			heartbeatOnce(input).pipe(
				Effect.ignore,
				Effect.andThen(Effect.sleep(HEARTBEAT_INTERVAL)),
				Effect.forever,
			);

		const startHeartbeat = Effect.fn("ApiLinkService.startHeartbeat")(
			function* (input: {
				readonly apiUrl: string;
				readonly environmentId: EnvironmentId;
				readonly credential: string;
			}) {
				const existing = yield* Ref.get(heartbeatRef);
				if (existing !== null) yield* Fiber.interrupt(existing);
				const fiber = yield* Effect.forkDetach(heartbeatLoop(input));
				yield* Ref.set(heartbeatRef, fiber);
			},
		);

		const stopHeartbeat = Effect.fn("ApiLinkService.stopHeartbeat")(
			function* () {
				const existing = yield* Ref.get(heartbeatRef);
				if (existing !== null) yield* Fiber.interrupt(existing);
				yield* Ref.set(heartbeatRef, null);
			},
		);

		const reconcileTunnelOrigin = (input: {
			readonly apiUrl: string;
			readonly environmentId: EnvironmentId;
			readonly credential: string;
		}) =>
			postJson<{ readonly ok: boolean }>(
				`${input.apiUrl}${ApiPaths.heartbeat(input.environmentId)}`,
				{
					bearer: input.credential,
					body: { origin: computeOrigin(config), ...apiRuntimeMetadata() },
				},
			);

		// Resume heartbeating (and the managed-tunnel connector) on boot if linked.
		const existing = yield* auth
			.getApiConfig()
			.pipe(Effect.orElseSucceed(() => null));
		if (existing !== null) {
			yield* log("service.existing_config", {
				environmentId: existing.environmentId,
				apiUrl: existing.apiUrl,
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
					apiUrl: existing.apiUrl,
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
					// the api or tunnel control plane is temporarily unavailable.
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
				apiUrl: existing.apiUrl,
				environmentId: existing.environmentId,
				credential: existing.environmentCredential,
			});
		}

		return ApiLinkService.of({
			link: (input) =>
				Effect.gen(function* () {
					apiAccess = null;
					apiClientRegistration = null;
					yield* log("link.start", {
						apiUrl: input.apiUrl,
						hasLabel: input.label !== undefined && input.label.length > 0,
					});
					// Give api-listed environments the same human name as LAN clients.
					const label = input.label ?? (yield* defaultEnvironmentLabel());
					const token = yield* authService
						.getAccessToken()
						.pipe(
							Effect.tap(() => log("link.access_token.ok")),
							Effect.tapError((error) =>
								log("link.access_token.fail", { error }),
							),
						)
						.pipe(Effect.mapError(() => failApi("not_signed_in")));
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
						.pipe(Effect.mapError((error) => failApi(error.reason)));

					yield* log("link.challenge.post");
					const challenge = yield* postJson<{
						readonly challengeId: string;
						readonly challenge: string;
						readonly apiIssuer: string;
					}>(`${input.apiUrl}${ApiPaths.linkChallenges}`, {
						bearer: token,
					}).pipe(
						Effect.tap((value) =>
							log("link.challenge.ok", {
								challengeId: value.challengeId,
								apiIssuer: value.apiIssuer,
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
						apiIssuer: challenge.apiIssuer,
						nowMs,
					});
					yield* log("link.proof.ok", {
						environmentId: keys.envId,
						apiIssuer: challenge.apiIssuer,
					});

					yield* log("link.environment.post", {
						endpoint: computeEndpoint(config),
						origin: computeOrigin(config),
						managedTunnel: true,
					});
					const linked = yield* postJson<{
						readonly environmentCredential: string;
						readonly apiIssuer: string;
						readonly mintPublicKey: string;
						readonly tunnelHostname?: string;
						readonly connectorToken?: string;
					}>(`${input.apiUrl}${ApiPaths.links}`, {
						bearer: token,
						body: {
							challengeId: challenge.challengeId,
							proof,
							environmentId: keys.envId,
							environmentPublicKey: keys.publicJwk,
							providerKind: "desktop",
							endpoint: computeEndpoint(config),
							label,
							...apiRuntimeMetadata(),
							// Ask the api to provision a managed Cloudflare tunnel so the
							// phone can reach this Mac from anywhere. If the api has tunnels
							// disabled it simply returns no connector token and we stay on LAN.
							managedTunnel: true,
							origin: computeOrigin(config),
						},
					}).pipe(
						Effect.tap((value) =>
							log("link.environment.ok", {
								apiIssuer: value.apiIssuer,
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
							.pipe(Effect.mapError((error) => failApi(error.reason)));
					}

					yield* log("link.save_config");
					yield* auth
						.saveApiConfig({
							apiUrl: input.apiUrl,
							apiIssuer: linked.apiIssuer,
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
						.pipe(Effect.mapError((error) => failApi(error.reason)));

					yield* startHeartbeat({
						apiUrl: input.apiUrl,
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
						apiUrl: input.apiUrl,
						environmentId: keys.envId,
						label,
						heartbeatActive: true,
						advertisedEndpoints: buildAdvertisedEndpoints({
							lan: config,
							api: {
								linked: true,
								heartbeatActive: true,
								tunnelHostname: linked.tunnelHostname,
							},
						}),
					} satisfies ApiLinkStatusValue;
				}),
			status: () =>
				Effect.gen(function* () {
					const cfg = yield* auth
						.getApiConfig()
						.pipe(Effect.mapError((error) => failApi(error.reason)));
					const active = (yield* Ref.get(heartbeatRef)) !== null;
					if (cfg === null) {
						yield* log("status.unlinked", { heartbeatActive: active });
						return {
							linked: false,
							heartbeatActive: false,
							advertisedEndpoints: buildAdvertisedEndpoints({ lan: config }),
						} satisfies ApiLinkStatusValue;
					}
					yield* log("status.linked", {
						environmentId: cfg.environmentId,
						apiUrl: cfg.apiUrl,
						heartbeatActive: active,
						hasConnectorToken: cfg.connectorToken !== undefined,
						tunnelHostname: cfg.tunnelHostname ?? null,
					});
					return {
						linked: true,
						apiUrl: cfg.apiUrl,
						environmentId: cfg.environmentId,
						label: cfg.label,
						heartbeatActive: active,
						advertisedEndpoints: buildAdvertisedEndpoints({
							lan: config,
							api: {
								linked: true,
								heartbeatActive: active,
								tunnelHostname: cfg.tunnelHostname,
							},
						}),
					} satisfies ApiLinkStatusValue;
				}),
			listEnvironments: () =>
				Effect.gen(function* () {
					const cfg = yield* auth
						.getApiConfig()
						.pipe(Effect.mapError((error) => failApi(error.reason)));
					if (cfg === null) return yield* Effect.fail(failApi("not_linked"));
					const token = yield* authService
						.getAccessToken()
						.pipe(Effect.mapError(() => failApi("not_signed_in")));
					return yield* accountJson<ApiEnvironmentList>(
						`${cfg.apiUrl}${ApiPaths.environments}`,
						{ bearer: token },
					);
				}),
			connectEnvironment: (environmentId) =>
				Effect.tryPromise({
					try: async () => {
						const cfg = await Effect.runPromise(auth.getApiConfig());
						if (cfg === null) throw new Error("not_linked");
						await ensureApiClient(cfg.apiUrl, cfg.environmentId);
						const response = await dpopRequest(
							cfg.apiUrl,
							ApiPaths.connect(environmentId),
							{
								wireProtocolVersion: WIRE_PROTOCOL_VERSION,
								requireManaged: true,
							},
						);
						if (!response.ok)
							throw new Error(await apiHttpErrorReason(response));
						return (await response.json()) as ApiConnectGrant;
					},
					catch: (cause) =>
						failApi(cause instanceof Error ? cause.message : String(cause)),
				}),
			listClients: () =>
				Effect.gen(function* () {
					const cfg = yield* auth
						.getApiConfig()
						.pipe(Effect.mapError((error) => failApi(error.reason)));
					if (cfg === null) return yield* Effect.fail(failApi("not_linked"));
					const token = yield* authService
						.getAccessToken()
						.pipe(Effect.mapError(() => failApi("not_signed_in")));
					return yield* accountJson<ApiAuthorizedClientList>(
						`${cfg.apiUrl}${ApiPaths.clients}`,
						{ bearer: token },
					);
				}),
			revokeClient: (clientId) =>
				Effect.gen(function* () {
					const cfg = yield* auth
						.getApiConfig()
						.pipe(Effect.mapError((error) => failApi(error.reason)));
					if (cfg === null) return yield* Effect.fail(failApi("not_linked"));
					const token = yield* authService
						.getAccessToken()
						.pipe(Effect.mapError(() => failApi("not_signed_in")));
					yield* accountJson<{ readonly ok: boolean }>(
						`${cfg.apiUrl}${ApiPaths.client(clientId)}`,
						{ bearer: token, method: "DELETE" },
					);
				}),
			unlink: () =>
				Effect.gen(function* () {
					apiAccess = null;
					apiClientRegistration = null;
					yield* log("unlink.start");
					const cfg = yield* auth
						.getApiConfig()
						.pipe(Effect.orElseSucceed(() => null));
					yield* stopHeartbeat();
					yield* tunnel
						.stop()
						.pipe(Effect.mapError((error) => failApi(error.reason)));
					// Best-effort api deprovision (tears down the Cloudflare tunnel +
					// removes the environment from the account). Local unlink proceeds
					// even if the api is unreachable or we're signed out.
					if (cfg !== null) {
						yield* authService.getAccessToken().pipe(
							Effect.flatMap((token) =>
								postJson<unknown>(`${cfg.apiUrl}${ApiPaths.unlink}`, {
									bearer: token,
									body: { environmentId: cfg.environmentId },
								}),
							),
							Effect.ignore,
						);
						yield* log("unlink.api_deprovision.done", {
							environmentId: cfg.environmentId,
						});
					}
					yield* auth
						.clearApiConfig()
						.pipe(Effect.mapError((error) => failApi(error.reason)));
					yield* log("unlink.success");
				}),
		});
	}),
);
