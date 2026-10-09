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
import { hostRuntimeVersion } from "../runtime-version.ts";
import { appendApiDiagnostic } from "./api-diagnostics.ts";
import {
	createDpopClientKey,
	type DpopClientKey,
	fetchDpopAccessToken,
	signDpopProof,
} from "./dpop-client.ts";
import { signEnvironmentLinkProof } from "./link-proof.ts";
import { ManagedTunnelRuntime } from "./managed-tunnel-runtime.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;
/** Quick retries after a failed heartbeat so a blip doesn't read as offline. */
const HEARTBEAT_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;
/** Granularity at which the heartbeat wait notices the host waking up. */
const HEARTBEAT_WAKE_CHECK_MS = 5_000;
/** Wall-clock drift beyond one wait tick that means this machine slept. */
const HEARTBEAT_WAKE_GAP_MS = 10_000;

/** Delay before the next heartbeat after `consecutiveFailures` failures. */
export const heartbeatDelayMs = (consecutiveFailures: number): number =>
	consecutiveFailures === 0
		? HEARTBEAT_INTERVAL_MS
		: (HEARTBEAT_RETRY_DELAYS_MS[consecutiveFailures - 1] ??
			HEARTBEAT_INTERVAL_MS);

/**
 * Wait up to `delayMs` before the next heartbeat, returning early when this
 * machine resumes from sleep. Timers freeze while the machine sleeps but the
 * wall clock keeps moving, so a large wall-clock jump across one short tick
 * means clients have seen this computer go stale and need a heartbeat now.
 */
export const waitForNextHeartbeat = (
	delayMs: number,
	wallClock: () => number = Date.now,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		let remaining = delayMs;
		while (remaining > 0) {
			const tick = Math.min(remaining, HEARTBEAT_WAKE_CHECK_MS);
			const before = wallClock();
			yield* Effect.sleep(tick);
			if (wallClock() - before > tick + HEARTBEAT_WAKE_GAP_MS) return;
			remaining -= tick;
		}
	});

/**
 * Heartbeat until interrupted: every 30s while healthy, quick retries after a
 * failure, and immediately after this machine wakes from sleep.
 */
export const heartbeatUntilInterrupted = <E>(
	beat: Effect.Effect<void, E>,
	options: {
		readonly wallClock?: () => number;
		readonly onFailure?: (error: E, failures: number) => Effect.Effect<void>;
		readonly onRecovered?: (failures: number) => Effect.Effect<void>;
	} = {},
): Effect.Effect<never> =>
	Effect.gen(function* () {
		let failures = 0;
		while (true) {
			const failed = yield* beat.pipe(
				Effect.as(null),
				Effect.catch((error) => Effect.succeed({ error })),
			);
			if (failed === null) {
				if (failures > 0) yield* options.onRecovered?.(failures) ?? Effect.void;
				failures = 0;
			} else {
				failures += 1;
				yield* options.onFailure?.(failed.error, failures) ?? Effect.void;
			}
			yield* waitForNextHeartbeat(
				heartbeatDelayMs(failures),
				options.wallClock,
			);
		}
	});
export const apiRuntimeMetadata = () =>
	({
		runtimeVersion: hostRuntimeVersion(),
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
				"device-commands-v1",
			],
		},
		serviceState: "healthy",
	}) as const;

export class ApiLinkError extends Data.TaggedError("ApiLinkError")<{
	readonly reason: string;
}> {}

/** The account already has as many linked computers as its plan allows. */
const COMPUTER_LIMIT_REASON = "api_409:computer_limit_reached";
const AUTO_LINK_LIMIT_RETRY_MS = 10 * 60_000;
const AUTO_LINK_MAX_RETRY_MS = 60_000;

/**
 * Delay before the next automatic link attempt. Transient failures back off
 * exponentially to a minute. A full account won't free up by itself soon, so
 * it waits ten minutes instead of polling the api every minute.
 */
export const autoLinkRetryDelayMs = (
	error: ApiLinkError,
	failures: number,
): number =>
	error.reason === COMPUTER_LIMIT_REASON
		? AUTO_LINK_LIMIT_RETRY_MS
		: Math.min(3_000 * 2 ** failures, AUTO_LINK_MAX_RETRY_MS);

/**
 * Keep trying to link until it sticks. Linking must never block or fail
 * server boot, and persistent causes (signed out, api down, a full account)
 * heal on a later attempt without a restart. A full account is reported once
 * with what to do, not as a warning every attempt.
 */
const RETIRE_RETRY_MAX_MS = 10 * 60_000;

/**
 * Keep retiring a saved registration until the account confirms it is gone.
 * Being signed out or offline at boot is normal; a later attempt finishes it.
 */
export const retireUntilRetired = (
	attempt: Effect.Effect<boolean, ApiLinkError>,
): Effect.Effect<void> => {
	const loop = (failures: number): Effect.Effect<void> =>
		attempt.pipe(
			Effect.asVoid,
			Effect.catch((error) =>
				(failures === 0
					? Effect.logInfo(
							"Removing this development copy from the account will retry",
							error,
						)
					: Effect.void
				).pipe(
					Effect.andThen(
						Effect.sleep(Math.min(5_000 * 2 ** failures, RETIRE_RETRY_MAX_MS)),
					),
					Effect.andThen(Effect.suspend(() => loop(failures + 1))),
				),
			),
		);
	return loop(0);
};

export const autoLinkUntilLinked = (
	attempt: Effect.Effect<void, ApiLinkError>,
): Effect.Effect<void> => {
	const loop = (
		failures: number,
		limitReported: boolean,
	): Effect.Effect<void> =>
		attempt.pipe(
			Effect.catch((error) => {
				const limit = error.reason === COMPUTER_LIMIT_REASON;
				const report = limit
					? limitReported
						? Effect.void
						: Effect.logInfo(
								"api auto-link paused: this account is at its computer limit. Remove an unused computer in Settings → Devices; linking resumes automatically.",
							)
					: Effect.logWarning("api auto-link attempt failed", error);
				// Jitter keeps parallel dev instances from retrying in lockstep.
				const delay =
					autoLinkRetryDelayMs(error, failures) * (0.8 + Math.random() * 0.4);
				return report.pipe(
					Effect.andThen(Effect.sleep(Math.round(delay))),
					Effect.andThen(
						Effect.suspend(() => loop(failures + 1, limit || limitReported)),
					),
				);
			}),
		);
	return loop(0, false);
};

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
		/**
		 * Remove this runtime's saved computer from the account, then forget it
		 * locally. Unlike `unlink`, the local link survives a failed request so a
		 * later attempt can still remove the account entry. Resolves `false` when
		 * nothing was linked.
		 */
		readonly retire: () => Effect.Effect<boolean, ApiLinkError>;
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
			retire: () => Effect.succeed(false),
			listEnvironments: disabled,
			connectEnvironment: disabled,
			listClients: disabled,
			revokeClient: disabled,
		}),
	);
};

/** The account no longer has this computer (or never did). */
const isApiNotFound = (error: ApiLinkError): boolean =>
	error.reason === "api_404" || error.reason.startsWith("api_404:");

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

const makeApiLinkService = (options: {
	readonly resumeExistingLink?: boolean;
}) =>
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
		let dpopKeyPromise: Promise<DpopClientKey> | null = null;
		const log = (event: string, fields?: Record<string, unknown>) =>
			appendApiDiagnostic(telemetry, event, fields);

		const dpopKey = () => {
			dpopKeyPromise ??= createDpopClientKey();
			return dpopKeyPromise;
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
				const response = await fetchDpopAccessToken({
					apiUrl,
					workosToken,
					key: await dpopKey(),
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
			init: { readonly method?: string; readonly body?: unknown } = {},
		): Promise<Response> => {
			const method = init.method ?? "POST";
			const target = `${apiUrl}${path}`;
			for (let attempt = 0; attempt < 2; attempt += 1) {
				const token = await ensureApiAccess(apiUrl);
				const response = await fetch(target, {
					method,
					headers: {
						authorization: `DPoP ${token}`,
						dpop: await signDpopProof(await dpopKey(), method, target),
						...(init.body === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					body: init.body === undefined ? undefined : JSON.stringify(init.body),
				});
				if (response.status !== 401 || attempt > 0) return response;
				apiAccess = null;
			}
			throw new Error("api_access_refresh_failed");
		};
		const dpopJson = <A>(
			apiUrl: string,
			path: string,
			init: { readonly method?: string; readonly body?: unknown } = {},
		): Effect.Effect<A, ApiLinkError> =>
			Effect.tryPromise({
				try: async () => {
					const response = await dpopRequest(apiUrl, path, init);
					if (!response.ok) throw new Error(await apiHttpErrorReason(response));
					return (await response.json()) as A;
				},
				catch: (cause) =>
					failApi(cause instanceof Error ? cause.message : String(cause)),
			});
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
					body: {
						deviceId: `desktop-${environmentId}`,
						platform: "desktop",
						dpopJwk: key.publicJwk,
					},
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
			heartbeatUntilInterrupted(heartbeatOnce(input), {
				// Report the start of an outage once, not every quick retry.
				onFailure: (error, failures) =>
					failures === 1
						? log("heartbeat.failed", {
								reason: error instanceof ApiLinkError ? error.reason : null,
							})
						: Effect.void,
				onRecovered: (failures) => log("heartbeat.recovered", { failures }),
			});

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
		const existing =
			options.resumeExistingLink === false
				? null
				: yield* auth.getApiConfig().pipe(Effect.orElseSucceed(() => null));
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
					yield* authService
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
					const challenge = yield* dpopJson<{
						readonly challengeId: string;
						readonly challenge: string;
						readonly apiIssuer: string;
					}>(input.apiUrl, ApiPaths.linkChallenges, {}).pipe(
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
					const linked = yield* dpopJson<{
						readonly environmentCredential: string;
						readonly apiIssuer: string;
						readonly mintPublicKey: string;
						readonly tunnelHostname?: string;
						readonly connectorToken?: string;
					}>(input.apiUrl, ApiPaths.links, {
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
					yield* authService
						.getAccessToken()
						.pipe(Effect.mapError(() => failApi("not_signed_in")));
					return yield* dpopJson<ApiEnvironmentList>(
						cfg.apiUrl,
						ApiPaths.environments,
						{ method: "GET" },
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
								body: {
									wireProtocolVersion: WIRE_PROTOCOL_VERSION,
									requireManaged: true,
								},
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
					yield* authService
						.getAccessToken()
						.pipe(Effect.mapError(() => failApi("not_signed_in")));
					return yield* dpopJson<ApiAuthorizedClientList>(
						cfg.apiUrl,
						ApiPaths.clients,
						{ method: "GET" },
					);
				}),
			revokeClient: (clientId) =>
				Effect.gen(function* () {
					const cfg = yield* auth
						.getApiConfig()
						.pipe(Effect.mapError((error) => failApi(error.reason)));
					if (cfg === null) return yield* Effect.fail(failApi("not_linked"));
					yield* authService
						.getAccessToken()
						.pipe(Effect.mapError(() => failApi("not_signed_in")));
					yield* dpopJson<{ readonly ok: boolean }>(
						cfg.apiUrl,
						ApiPaths.client(clientId),
						{ method: "DELETE" },
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
						yield* dpopJson<unknown>(cfg.apiUrl, ApiPaths.unlink, {
							body: { environmentId: cfg.environmentId },
						}).pipe(Effect.ignore);
						yield* log("unlink.api_deprovision.done", {
							environmentId: cfg.environmentId,
						});
					}
					yield* auth
						.clearApiConfig()
						.pipe(Effect.mapError((error) => failApi(error.reason)));
					yield* log("unlink.success");
				}),
			retire: () =>
				Effect.gen(function* () {
					const cfg = yield* auth
						.getApiConfig()
						.pipe(Effect.orElseSucceed(() => null));
					if (cfg === null) return false;
					yield* log("retire.start", { environmentId: cfg.environmentId });
					yield* authService
						.getAccessToken()
						.pipe(Effect.mapError(() => failApi("signed_out")));
					yield* dpopJson<unknown>(cfg.apiUrl, ApiPaths.unlink, {
						body: { environmentId: cfg.environmentId },
					}).pipe(
						Effect.catch((error) =>
							isApiNotFound(error) ? Effect.void : Effect.fail(error),
						),
					);
					yield* auth
						.clearApiConfig()
						.pipe(Effect.mapError((error) => failApi(error.reason)));
					yield* log("retire.success", { environmentId: cfg.environmentId });
					return true;
				}),
		});
	});

export const makeApiLinkServiceLive = (
	options: { readonly resumeExistingLink?: boolean } = {},
): Layer.Layer<
	ApiLinkService,
	never,
	| LanAuthService
	| LanAuthConfig
	| AuthService
	| AccountAccessService
	| ManagedTunnelRuntime
	| TelemetryStore
> => Layer.effect(ApiLinkService, makeApiLinkService(options));

export const ApiLinkServiceLive = makeApiLinkServiceLive();
