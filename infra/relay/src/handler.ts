import { RelayAuthTokenGrant } from "@zuse/contracts";
import { SandboxProviders } from "@zuse/sandbox-providers";
import { Clock, Effect, Redacted, Schema } from "effect";

import { AccountIdentity } from "./account-identity.ts";
import {
	mintAccessToken,
	RELAY_SCOPES,
	requireDpop,
	requireEnvironmentCredential,
	requireWorkos,
} from "./auth.ts";
import {
	type CloudWorkspaceRouteContext,
	routeCloudWorkspaceRequest,
} from "./cloud-workspace-routes.ts";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { RelayConfiguration } from "./config.ts";
import {
	parseJwk,
	randomToken,
	sha256Hex,
	signConnectToken,
	verifyEnvironmentLinkProof,
} from "./crypto.ts";
import {
	badRequest,
	conflict,
	gone,
	notFound,
	type RelayError,
	serviceUnavailable,
} from "./errors.ts";
import { requestMachineDestruction } from "./machine-lifecycle.ts";
import {
	type MachineRouteContext,
	routeMachineRequest,
} from "./machine-routes.ts";
import { MachineStore } from "./machine-store.ts";
import { ManagedTunnelProvider } from "./managed-tunnel.ts";
import { PushDelivery } from "./push.ts";
import type { SandboxOfferConfiguration } from "./sandbox-provider-module.ts";
import {
	type ActivityKind,
	type DevicePlatform,
	type EnvironmentRecord,
	type ProviderKind,
	RelayStore,
} from "./store.ts";
import { WorkosVerifier } from "./workos.ts";

const CLOUD_WORKSPACE_IDLE_MS = 60 * 60 * 1_000;

export type RelayContext =
	| AccountIdentity
	| WorkosVerifier
	| RelayStore
	| RelayConfiguration
	| ManagedTunnelProvider
	| PushDelivery
	| SandboxOfferConfiguration
	| CloudWorkspaceRouteContext
	| MachineRouteContext;

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const withBrowserCors = (
	response: Response,
	request: Request,
	allowedOrigins: ReadonlyArray<string>,
): Response => {
	const origin = request.headers.get("origin");
	if (origin === null || !allowedOrigins.includes(origin)) return response;
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", origin);
	headers.set("access-control-allow-credentials", "true");
	headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
	headers.set(
		"access-control-allow-headers",
		"authorization, content-type, dpop",
	);
	headers.set("vary", "Origin");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
};

const readJson = <A>(request: Request): Effect.Effect<A, RelayError> =>
	Effect.tryPromise({
		try: () => request.json() as Promise<A>,
		catch: () => badRequest("invalid_json"),
	});

const isProviderKind = (value: unknown): value is ProviderKind =>
	value === "desktop" || value === "ssh" || value === "cloud";

const isPlatform = (value: unknown): value is DevicePlatform =>
	value === "ios" ||
	value === "android" ||
	value === "web" ||
	value === "desktop";

const isServiceState = (
	value: unknown,
): value is EnvironmentRecord["serviceState"] =>
	value === "starting" ||
	value === "healthy" ||
	value === "degraded" ||
	value === "stopped" ||
	value === "updating";

const isCapabilityManifest = (
	value: unknown,
): value is {
	readonly version: 1;
	readonly features: ReadonlyArray<string>;
} => {
	if (value === null || typeof value !== "object") return false;
	const candidate = value as {
		readonly version?: unknown;
		readonly features?: unknown;
	};
	return (
		candidate.version === 1 &&
		Array.isArray(candidate.features) &&
		candidate.features.every(
			(feature) =>
				typeof feature === "string" &&
				feature.length > 0 &&
				feature.length <= 64,
		)
	);
};

const isActivityKind = (value: unknown): value is ActivityKind =>
	value === "approval-needed" ||
	value === "question-needed" ||
	value === "completed" ||
	value === "error" ||
	value === "running";

const isLoopbackOrigin = (
	value: unknown,
): value is {
	readonly localHttpHost: "127.0.0.1";
	readonly localHttpPort: number;
} => {
	if (value === null || typeof value !== "object") return false;
	const origin = value as {
		readonly localHttpHost?: unknown;
		readonly localHttpPort?: unknown;
	};
	return (
		origin.localHttpHost === "127.0.0.1" &&
		typeof origin.localHttpPort === "number" &&
		Number.isInteger(origin.localHttpPort) &&
		origin.localHttpPort >= 1 &&
		origin.localHttpPort <= 65_535
	);
};

const isPrivateNetworkHost = (hostname: string): boolean => {
	const normalized = hostname.replace(/^\[|\]$/gu, "");
	const octets = normalized.split(".").map(Number);
	if (
		octets.length === 4 &&
		octets.every(
			(octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
		)
	) {
		return (
			octets[0] === 100 && (octets[1] ?? 0) >= 64 && (octets[1] ?? 0) <= 127
		);
	}
	return normalized.toLowerCase().startsWith("fd7a:115c:a1e0:");
};

const isPrivateEndpoint = (value: {
	readonly httpBaseUrl?: unknown;
	readonly wsBaseUrl?: unknown;
}): value is { readonly httpBaseUrl: string; readonly wsBaseUrl: string } => {
	if (
		typeof value.httpBaseUrl !== "string" ||
		typeof value.wsBaseUrl !== "string"
	) {
		return false;
	}
	try {
		const http = new URL(value.httpBaseUrl);
		const ws = new URL(value.wsBaseUrl);
		return (
			http.protocol === "http:" &&
			ws.protocol === "ws:" &&
			http.hostname === ws.hostname &&
			isPrivateNetworkHost(http.hostname) &&
			http.port === "47837" &&
			ws.port === "47837" &&
			http.pathname === "/" &&
			ws.pathname === "/" &&
			http.username === "" &&
			http.password === "" &&
			ws.username === "" &&
			ws.password === "" &&
			http.search === "" &&
			ws.search === "" &&
			http.hash === "" &&
			ws.hash === ""
		);
	} catch {
		return false;
	}
};

const SENSITIVE_ACTIVITY_KEYS = new Set([
	"chatBytes",
	"command",
	"content",
	"filePath",
	"message",
	"messages",
	"output",
	"path",
	"text",
	"toolArgs",
	"toolInput",
]);

const hasSensitiveActivityKey = (value: unknown): boolean => {
	if (Array.isArray(value)) return value.some(hasSensitiveActivityKey);
	if (value === null || typeof value !== "object") return false;
	for (const [key, entry] of Object.entries(value)) {
		if (SENSITIVE_ACTIVITY_KEYS.has(key)) return true;
		if (hasSensitiveActivityKey(entry)) return true;
	}
	return false;
};

const publicEndpoint = (environment: EnvironmentRecord) =>
	environment.tunnelHostname !== undefined
		? {
				httpBaseUrl: `https://${environment.tunnelHostname}`,
				wsBaseUrl: `wss://${environment.tunnelHostname}`,
			}
		: {
				httpBaseUrl: environment.httpBaseUrl,
				wsBaseUrl: environment.wsBaseUrl,
			};

const hasManagedPublicEndpoint = (environment: EnvironmentRecord): boolean => {
	if (environment.tunnelHostname !== undefined) return true;
	try {
		const endpoint = new URL(environment.httpBaseUrl);
		const hostname = endpoint.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
		return (
			endpoint.protocol === "https:" &&
			hostname !== "localhost" &&
			hostname !== "127.0.0.1" &&
			hostname !== "::1"
		);
	} catch {
		return false;
	}
};

const endpointCandidates = (environment: EnvironmentRecord) => [
	...(environment.privateHttpBaseUrl !== undefined &&
	environment.privateWsBaseUrl !== undefined
		? [
				{
					kind: "private-network" as const,
					endpoint: {
						httpBaseUrl: environment.privateHttpBaseUrl,
						wsBaseUrl: environment.privateWsBaseUrl,
					},
				},
			]
		: []),
	{
		kind: "managed-tunnel" as const,
		endpoint: publicEndpoint(environment),
	},
];

/** Routes a request to the matching endpoint. Failures surface as RelayError. */
const route = (
	request: Request,
): Effect.Effect<Response, RelayError, RelayContext> =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		const path = url.pathname;
		const config = yield* RelayConfiguration;
		const store = yield* RelayStore;
		const push = yield* PushDelivery;
		const accountIdentity = yield* AccountIdentity;
		const workos = yield* WorkosVerifier;
		const nowMs = yield* Clock.currentTimeMillis;
		const machineResponse = yield* routeMachineRequest(request);
		if (machineResponse !== null) return machineResponse;
		const cloudWorkspaceResponse = yield* routeCloudWorkspaceRequest(request);
		if (cloudWorkspaceResponse !== null) return cloudWorkspaceResponse;

		if (method === "POST" && path === "/v1/auth/token") {
			const untrustedBody = yield* readJson<unknown>(request);
			const body = yield* Effect.try({
				try: () => Schema.decodeUnknownSync(RelayAuthTokenGrant)(untrustedBody),
				catch: () => badRequest("invalid_auth_grant"),
			});
			if (
				body.grantType === "authorization_code" &&
				typeof body.code === "string" &&
				body.code.length > 0 &&
				body.code.length <= 2_048 &&
				typeof body.codeVerifier === "string" &&
				body.codeVerifier.length >= 43 &&
				body.codeVerifier.length <= 128
			) {
				return json(
					yield* workos.exchangeToken({
						grantType: body.grantType,
						code: body.code,
						codeVerifier: body.codeVerifier,
					}),
				);
			}
			if (
				body.grantType === "refresh_token" &&
				typeof body.refreshToken === "string" &&
				body.refreshToken.length > 0 &&
				body.refreshToken.length <= 8_192
			) {
				return json(
					yield* workos.exchangeToken({
						grantType: body.grantType,
						refreshToken: body.refreshToken,
					}),
				);
			}
			return yield* Effect.fail(badRequest("invalid_auth_grant"));
		}

		// 1. Issue a link challenge (desktop, WorkOS-authenticated).
		if (
			method === "POST" &&
			path === "/v1/client/environment-link-challenges"
		) {
			const principal = yield* requireWorkos(request);
			const challengeId = yield* randomToken("chl");
			const challenge = yield* randomToken("nonce", 32);
			const expiresAtMs = nowMs + config.challengeTtlMs;
			yield* store.createChallenge({
				challengeId,
				accountId: principal.accountId,
				challenge,
				relayIssuer: config.relayIssuer,
				expiresAtMs,
			});
			return json({
				challengeId,
				challenge,
				relayIssuer: config.relayIssuer,
				expiresAt: expiresAtMs,
			});
		}

		// 2. Link an environment: verify the Ed25519 proof, mint a credential.
		if (method === "POST" && path === "/v1/client/environment-links") {
			const principal = yield* requireWorkos(request);
			const body = yield* readJson<{
				readonly challengeId?: string;
				readonly proof?: string;
				readonly environmentId?: string;
				readonly environmentPublicKey?: string;
				readonly providerKind?: string;
				readonly endpoint?: {
					readonly httpBaseUrl?: string;
					readonly wsBaseUrl?: string;
				};
				readonly label?: string;
				readonly runtimeVersion?: string;
				readonly wireProtocolVersion?: number;
				readonly capabilities?: unknown;
				readonly serviceState?: string;
				readonly managedTunnel?: boolean;
				readonly origin?: {
					readonly localHttpHost?: string;
					readonly localHttpPort?: number;
				};
			}>(request);

			if (
				typeof body.challengeId !== "string" ||
				typeof body.proof !== "string" ||
				typeof body.environmentId !== "string" ||
				typeof body.environmentPublicKey !== "string" ||
				!isProviderKind(body.providerKind) ||
				typeof body.endpoint?.httpBaseUrl !== "string" ||
				typeof body.endpoint?.wsBaseUrl !== "string"
			) {
				return yield* Effect.fail(badRequest("invalid_environment"));
			}
			if (
				(body.runtimeVersion !== undefined &&
					(typeof body.runtimeVersion !== "string" ||
						body.runtimeVersion.length > 64)) ||
				(body.wireProtocolVersion !== undefined &&
					(!Number.isInteger(body.wireProtocolVersion) ||
						body.wireProtocolVersion < 1)) ||
				(body.capabilities !== undefined &&
					!isCapabilityManifest(body.capabilities)) ||
				(body.serviceState !== undefined && !isServiceState(body.serviceState))
			) {
				return yield* Effect.fail(badRequest("invalid_environment_metadata"));
			}

			const challenge = yield* store.consumeChallenge(
				body.challengeId,
				principal.accountId,
			);
			if (challenge === null) {
				return yield* Effect.fail(gone("invalid_challenge"));
			}
			if (challenge.expiresAtMs <= nowMs) {
				return yield* Effect.fail(gone("expired_challenge"));
			}

			const publicJwk = yield* parseJwk(body.environmentPublicKey);
			yield* verifyEnvironmentLinkProof({
				proof: body.proof,
				environmentPublicJwk: publicJwk,
				expectedChallenge: challenge.challenge,
				expectedEnvironmentId: body.environmentId,
				relayIssuer: config.relayIssuer,
			});

			const registered = yield* store.registerEnvironment(
				{
					environmentId: body.environmentId,
					accountId: principal.accountId,
					orgId: principal.orgId,
					providerKind: body.providerKind,
					label: body.label,
					environmentPublicKey: body.environmentPublicKey,
					httpBaseUrl: body.endpoint.httpBaseUrl,
					wsBaseUrl: body.endpoint.wsBaseUrl,
					linkedAtMs: nowMs,
					runtimeVersion: body.runtimeVersion,
					wireProtocolVersion: body.wireProtocolVersion,
					capabilities: body.capabilities,
					serviceState: body.serviceState,
				},
				config.maxEnvironmentsPerAccount,
				"replace-same-account",
			);
			if (!registered) {
				return yield* Effect.fail(conflict("computer_limit_reached"));
			}

			const credentialSecret = yield* randomToken("zenv");
			const credentialId = yield* randomToken("cred", 8);
			const credentialHash = yield* sha256Hex(credentialSecret);
			yield* store.insertCredential({
				credentialId,
				environmentId: body.environmentId,
				accountId: principal.accountId,
				credentialHash,
				createdAtMs: nowMs,
			});

			// Provision a managed Cloudflare tunnel when requested and enabled, so the
			// environment is reachable from anywhere. On failure we don't fail the
			// link — the desktop keeps its LAN endpoint and can retry.
			const tunnel = yield* ManagedTunnelProvider;
			let tunnelHostname: string | undefined;
			let connectorToken: string | undefined;
			if (
				body.managedTunnel === true &&
				tunnel.enabled &&
				typeof body.origin?.localHttpHost === "string" &&
				typeof body.origin.localHttpPort === "number"
			) {
				const provisioned = yield* tunnel
					.provision({
						accountId: principal.accountId,
						environmentId: body.environmentId,
						origin: {
							localHttpHost: body.origin.localHttpHost,
							localHttpPort: body.origin.localHttpPort,
						},
					})
					.pipe(Effect.option);
				if (provisioned._tag === "Some") {
					yield* store.setTunnelAllocation(body.environmentId, {
						tunnelHostname: provisioned.value.tunnelHostname,
						tunnelId: provisioned.value.tunnelId,
						dnsRecordId: provisioned.value.dnsRecordId,
						tunnelStatus: "ready",
					});
					tunnelHostname = provisioned.value.tunnelHostname;
					connectorToken = provisioned.value.connectorToken;
				}
			}

			return json({
				environmentId: body.environmentId,
				endpoint:
					tunnelHostname !== undefined
						? {
								httpBaseUrl: `https://${tunnelHostname}`,
								wsBaseUrl: `wss://${tunnelHostname}`,
							}
						: {
								httpBaseUrl: body.endpoint.httpBaseUrl,
								wsBaseUrl: body.endpoint.wsBaseUrl,
							},
				relayIssuer: config.relayIssuer,
				environmentCredential: credentialSecret,
				mintPublicKey: config.mintPublicKey,
				tunnelHostname,
				connectorToken,
			});
		}

		// 2b. Unlink an environment (WorkOS-authenticated): deprovision its managed
		// tunnel and delete the record so it disappears from the account.
		if (method === "POST" && path === "/v1/client/environment-unlink") {
			const principal = yield* requireWorkos(request);
			const body = yield* readJson<{ readonly environmentId?: string }>(
				request,
			);
			if (typeof body.environmentId !== "string") {
				return yield* Effect.fail(badRequest("invalid_environment"));
			}
			const environment = yield* store.getEnvironment(body.environmentId);
			if (
				environment === null ||
				environment.accountId !== principal.accountId
			) {
				return yield* Effect.fail(notFound());
			}
			if (environment.tunnelId !== undefined) {
				const tunnel = yield* ManagedTunnelProvider;
				yield* tunnel
					.deprovision({
						tunnelId: environment.tunnelId,
						dnsRecordId: environment.dnsRecordId,
					})
					.pipe(Effect.ignore);
			}
			yield* store.deleteEnvironment(body.environmentId, principal.accountId);
			return json({ ok: true });
		}

		// 3. List the caller's environments (WorkOS-authenticated).
		if (method === "GET" && path === "/v1/environments") {
			const principal = yield* requireWorkos(request);
			const environments = yield* store.listEnvironments(principal.accountId);
			const machines = yield* MachineStore;
			const readyCloudEnvironmentIds = new Set(
				(yield* machines.listMachines(principal.accountId))
					.filter(
						(machine) =>
							machine.state === "ready" && machine.environmentId !== undefined,
					)
					.map((machine) => machine.environmentId),
			);
			return json({
				environments: environments
					.filter(
						(environment) =>
							environment.providerKind !== "cloud" ||
							readyCloudEnvironmentIds.has(environment.environmentId),
					)
					.map((environment) => ({
						environmentId: environment.environmentId,
						label: environment.label,
						providerKind: environment.providerKind,
						endpoint: publicEndpoint(environment),
						linkedAt: environment.linkedAtMs,
						runtimeVersion: environment.runtimeVersion,
						wireProtocolVersion: environment.wireProtocolVersion,
						capabilities: environment.capabilities,
						serviceState: environment.serviceState,
						endpointHealth: {
							lan: "unknown",
							managed:
								environment.tunnelStatus === "ready"
									? "available"
									: "unavailable",
							checkedAt: nowMs,
						},
						lastHeartbeat: environment.lastSeenAtMs,
						environmentPublicKey: environment.environmentPublicKey,
					})),
			});
		}

		// 4. DPoP token exchange.
		if (method === "POST" && path === "/v1/client/dpop-token") {
			const minted = yield* mintAccessToken(request, [
				RELAY_SCOPES.status,
				RELAY_SCOPES.connect,
				RELAY_SCOPES.register,
			]);
			return json({
				accessToken: minted.accessToken,
				expiresIn: minted.expiresInMs,
			});
		}

		// 5. Register a mobile device (DPoP-scoped).
		if (method === "POST" && path === "/v1/mobile/devices") {
			const principal = yield* requireDpop(request, RELAY_SCOPES.register);
			const body = yield* readJson<{
				readonly deviceId?: string;
				readonly platform?: string;
				readonly pushToken?: string;
				readonly dpopJwk?: unknown;
			}>(request);
			if (typeof body.deviceId !== "string" || !isPlatform(body.platform)) {
				return yield* Effect.fail(badRequest("invalid_device"));
			}
			const registered = yield* store.upsertDevice({
				deviceId: body.deviceId,
				accountId: principal.accountId,
				platform: body.platform,
				pushToken: body.pushToken,
				dpopJwk: body.dpopJwk,
				dpopThumbprint: principal.thumbprint,
				updatedAtMs: nowMs,
			});
			if (!registered) {
				return yield* Effect.fail(conflict("client_id_conflict"));
			}
			return json({ ok: true });
		}

		if (method === "GET" && path === "/v1/clients") {
			const principal = yield* requireWorkos(request);
			const devices = yield* store.listDevices(principal.accountId);
			return json({
				clients: devices.map((device) => ({
					clientId: device.deviceId,
					platform: device.platform,
					lastSeenAt: device.updatedAtMs,
				})),
			});
		}

		const clientMatch = /^\/v1\/clients\/([^/]+)$/.exec(path);
		if (method === "DELETE" && clientMatch !== null) {
			const principal = yield* requireWorkos(request);
			const clientId = decodeURIComponent(clientMatch[1] ?? "");
			const revoked = yield* store.revokeDevice(clientId, principal.accountId);
			if (!revoked) return yield* Effect.fail(notFound());
			return json({ ok: true });
		}

		// Permanently delete the authenticated account. Relay records and managed
		// infrastructure are removed first; a still-valid bearer can safely retry
		// if the final identity-provider request is temporarily unavailable.
		if (method === "DELETE" && path === "/v1/account") {
			const principal = yield* requireWorkos(request);
			const machineStore = yield* MachineStore;
			const cloudStore = yield* CloudWorkspaceStore;
			const machines = yield* machineStore.listMachines(principal.accountId);
			for (const machine of machines) {
				let destructionBase = machine;
				let destructionScheduled = machine.state === "destroyed";
				for (
					let attempt = 0;
					attempt < 3 && !destructionScheduled;
					attempt += 1
				) {
					destructionScheduled = yield* machineStore.compareAndSetMachine(
						requestMachineDestruction(destructionBase, nowMs, nowMs),
						destructionBase.revision,
					);
					if (!destructionScheduled) {
						const current = yield* machineStore.getMachine(machine.machineId);
						if (current === null || current.state === "destroyed") {
							destructionScheduled = true;
						} else {
							destructionBase = current;
						}
					}
				}
				if (!destructionScheduled) {
					return yield* Effect.fail(
						serviceUnavailable("machine_transition_contended"),
					);
				}
			}
			const cloudWorkspaces = yield* cloudStore.listWorkspaces(
				principal.accountId,
			);
			for (const workspace of cloudWorkspaces) {
				if (workspace.state === "deleted") continue;
				yield* cloudStore.saveWorkspace({
					...workspace,
					desiredState: "deleted",
					statusCode: "delete-queued",
					nextActionAtMs: nowMs,
					revision: workspace.revision + 1,
					updatedAtMs: nowMs,
				});
			}
			if (
				machines.some((machine) => machine.state !== "destroyed") ||
				cloudWorkspaces.some((workspace) => workspace.state !== "deleted")
			) {
				return json({ ok: true, cleanupPending: true }, 202);
			}
			const entitlements = yield* machineStore.listEntitlements(
				principal.accountId,
			);
			for (const entitlement of entitlements) {
				yield* machineStore.upsertEntitlement({
					...entitlement,
					status: "ended",
					endedAtMs: nowMs,
					updatedAtMs: nowMs,
				});
			}
			const cloudProjects = yield* cloudStore.listProjects(principal.accountId);
			const sandboxProviders = yield* SandboxProviders;
			for (const project of cloudProjects) {
				for (const build of yield* cloudStore.listBuilds(project.projectId)) {
					if (build.snapshotId === undefined) continue;
					const provider = yield* sandboxProviders
						.get(build.provider)
						.pipe(
							Effect.mapError(() =>
								serviceUnavailable("cloud_provider_unavailable"),
							),
						);
					yield* provider
						.deleteSnapshot(build.snapshotId)
						.pipe(
							Effect.mapError(() =>
								serviceUnavailable("cloud_snapshot_cleanup_failed"),
							),
						);
				}
			}
			yield* cloudStore.deleteAccountData(principal.accountId);
			const environments = yield* store.listEnvironments(principal.accountId);
			const tunnel = yield* ManagedTunnelProvider;
			yield* Effect.forEach(
				environments,
				(environment) =>
					environment.tunnelId === undefined
						? Effect.void
						: tunnel.deprovision({
								tunnelId: environment.tunnelId,
								dnsRecordId: environment.dnsRecordId,
							}),
				{ discard: true },
			);
			yield* store.deleteAccountData(principal.accountId);
			yield* accountIdentity.deleteUser(principal.accountId);
			return json({ ok: true, cleanupPending: false });
		}

		// Path-parameterised environment routes.
		const statusMatch = /^\/v1\/environments\/([^/]+)\/status$/.exec(path);
		if (method === "POST" && statusMatch !== null) {
			const environmentId = decodeURIComponent(statusMatch[1] ?? "");
			const principal = yield* requireDpop(request, RELAY_SCOPES.status);
			const environment = yield* store.getEnvironment(environmentId);
			if (
				environment === null ||
				environment.accountId !== principal.accountId
			) {
				return yield* Effect.fail(notFound());
			}
			const online =
				environment.lastSeenAtMs !== undefined &&
				nowMs - environment.lastSeenAtMs <= config.presenceStaleMs;
			return json({
				status: online ? "online" : "offline",
				endpoint: publicEndpoint(environment),
				endpointCandidates: endpointCandidates(environment),
				checkedAt: nowMs,
			});
		}

		const connectMatch = /^\/v1\/environments\/([^/]+)\/connect$/.exec(path);
		if (method === "POST" && connectMatch !== null) {
			const environmentId = decodeURIComponent(connectMatch[1] ?? "");
			const principal = yield* requireDpop(request, RELAY_SCOPES.connect);
			const environment = yield* store.getEnvironment(environmentId);
			if (
				environment === null ||
				environment.accountId !== principal.accountId
			) {
				return yield* Effect.fail(notFound());
			}
			const cloudWorkspace =
				yield* (yield* CloudWorkspaceStore).recordActivityByEnvironment(
					environmentId,
					principal.accountId,
					nowMs,
					nowMs + CLOUD_WORKSPACE_IDLE_MS,
				);
			if (cloudWorkspace?.state === "paused")
				return yield* Effect.fail(serviceUnavailable("workspace_resuming"));
			let requestedWireVersion: number | undefined;
			let requireManaged = false;
			let localPairing:
				| {
						readonly serverNonce: string;
						readonly devicePublicKey: string;
						readonly transportCertificatePin: string;
				  }
				| undefined;
			if (request.headers.get("content-type")?.includes("application/json")) {
				const body = yield* readJson<{
					readonly wireProtocolVersion?: unknown;
					readonly requireManaged?: unknown;
					readonly localPairing?: {
						readonly serverNonce?: unknown;
						readonly devicePublicKey?: unknown;
						readonly transportCertificatePin?: unknown;
					};
				}>(request);
				if (
					(body.wireProtocolVersion !== undefined &&
						(typeof body.wireProtocolVersion !== "number" ||
							!Number.isInteger(body.wireProtocolVersion) ||
							body.wireProtocolVersion < 1)) ||
					(body.requireManaged !== undefined &&
						typeof body.requireManaged !== "boolean")
				) {
					return yield* Effect.fail(badRequest("invalid_connect_request"));
				}
				requestedWireVersion =
					typeof body.wireProtocolVersion === "number"
						? body.wireProtocolVersion
						: undefined;
				requireManaged = body.requireManaged === true;
				if (body.localPairing !== undefined) {
					const { serverNonce, devicePublicKey, transportCertificatePin } =
						body.localPairing;
					if (
						typeof serverNonce !== "string" ||
						serverNonce.length < 8 ||
						serverNonce.length > 128 ||
						typeof devicePublicKey !== "string" ||
						devicePublicKey.length !== 43 ||
						!/^[A-Za-z0-9_-]+$/u.test(devicePublicKey) ||
						typeof transportCertificatePin !== "string" ||
						transportCertificatePin.length !== 43 ||
						!/^[A-Za-z0-9_-]+$/u.test(transportCertificatePin)
					) {
						return yield* Effect.fail(
							badRequest("invalid_local_pairing_binding"),
						);
					}
					localPairing = {
						serverNonce,
						devicePublicKey,
						transportCertificatePin,
					};
				}
			}
			if (
				requestedWireVersion !== undefined &&
				environment.wireProtocolVersion !== undefined &&
				requestedWireVersion !== environment.wireProtocolVersion
			) {
				return yield* Effect.fail(conflict("version_incompatible"));
			}
			if (
				environment.serviceState === "degraded" ||
				environment.serviceState === "stopped"
			) {
				return yield* Effect.fail(serviceUnavailable("service_unhealthy"));
			}
			if (requireManaged && !hasManagedPublicEndpoint(environment)) {
				return yield* Effect.fail(serviceUnavailable("tunnel_unavailable"));
			}
			const connectToken = yield* signConnectToken({
				mintPrivateJwk: yield* parseJwk(Redacted.value(config.mintPrivateKey)),
				issuer: config.relayIssuer,
				accountId: principal.accountId,
				environmentId,
				thumbprint: principal.thumbprint,
				ttlMs: config.connectTokenTtlMs,
				nowMs,
				localPairing,
			});
			return json({
				endpoint: publicEndpoint(environment),
				endpointCandidates: endpointCandidates(environment),
				connectToken,
				expiresAt: nowMs + config.connectTokenTtlMs,
			});
		}

		// 6. Heartbeat (desktop, environment-credential auth) — presence origin.
		const heartbeatMatch = /^\/v1\/environments\/([^/]+)\/heartbeat$/.exec(
			path,
		);
		if (method === "POST" && heartbeatMatch !== null) {
			const environmentId = decodeURIComponent(heartbeatMatch[1] ?? "");
			const principal = yield* requireEnvironmentCredential(
				request,
				environmentId,
			);
			let machineAction: "sanitize-credentials" | undefined;
			const hasJsonBody = request.headers
				.get("content-type")
				?.toLowerCase()
				.includes("application/json");
			if (hasJsonBody === true) {
				const body = yield* readJson<{
					readonly origin?: unknown;
					readonly privateEndpoint?: {
						readonly httpBaseUrl?: unknown;
						readonly wsBaseUrl?: unknown;
					};
					readonly runtimeVersion?: unknown;
					readonly wireProtocolVersion?: unknown;
					readonly capabilities?: unknown;
					readonly serviceState?: unknown;
					readonly credentialCleanupComplete?: unknown;
				}>(request);
				if (body.origin !== undefined && !isLoopbackOrigin(body.origin)) {
					return yield* Effect.fail(badRequest("invalid_tunnel_origin"));
				}
				if (
					(body.runtimeVersion !== undefined &&
						(typeof body.runtimeVersion !== "string" ||
							body.runtimeVersion.length > 64)) ||
					(body.wireProtocolVersion !== undefined &&
						(typeof body.wireProtocolVersion !== "number" ||
							!Number.isInteger(body.wireProtocolVersion))) ||
					(body.capabilities !== undefined &&
						!isCapabilityManifest(body.capabilities)) ||
					(body.serviceState !== undefined &&
						!isServiceState(body.serviceState)) ||
					(body.credentialCleanupComplete !== undefined &&
						typeof body.credentialCleanupComplete !== "boolean")
				) {
					return yield* Effect.fail(badRequest("invalid_environment_metadata"));
				}
				const environment = yield* store.getEnvironment(environmentId);
				if (
					environment === null ||
					environment.accountId !== principal.accountId
				) {
					return yield* Effect.fail(notFound());
				}
				if (body.origin !== undefined) {
					const tunnel = yield* ManagedTunnelProvider;
					if (!tunnel.enabled) {
						return yield* Effect.fail(badRequest("managed_tunnel_disabled"));
					}
					const provisioned = yield* tunnel.provision({
						accountId: principal.accountId,
						environmentId,
						origin: body.origin,
					});
					yield* store.setTunnelAllocation(environmentId, {
						tunnelHostname: provisioned.tunnelHostname,
						tunnelId: provisioned.tunnelId,
						dnsRecordId: provisioned.dnsRecordId,
						tunnelStatus: "ready",
					});
				}
				if (body.privateEndpoint !== undefined) {
					if (!isPrivateEndpoint(body.privateEndpoint)) {
						return yield* Effect.fail(badRequest("invalid_private_endpoint"));
					}
					yield* store.setPrivateEndpoint(environmentId, {
						httpBaseUrl: body.privateEndpoint.httpBaseUrl,
						wsBaseUrl: body.privateEndpoint.wsBaseUrl,
					});
				}
				yield* store.touchEnvironment(environmentId, nowMs, {
					runtimeVersion:
						typeof body.runtimeVersion === "string"
							? body.runtimeVersion
							: undefined,
					wireProtocolVersion:
						typeof body.wireProtocolVersion === "number"
							? body.wireProtocolVersion
							: undefined,
					capabilities: body.capabilities,
					serviceState: isServiceState(body.serviceState)
						? body.serviceState
						: undefined,
				});
				if (body.credentialCleanupComplete === true) {
					const machines = yield* MachineStore;
					const machine =
						yield* machines.findMachineByEnvironmentId(environmentId);
					if (
						machine !== null &&
						machine.accountId === principal.accountId &&
						machine.desiredState === "destroyed" &&
						machine.credentialCleanupRequestedAtMs !== undefined
					) {
						yield* machines.compareAndSetMachine(
							{
								...machine,
								credentialCleanupCompletedAtMs: nowMs,
								nextActionAtMs: nowMs,
								updatedAtMs: nowMs,
							},
							machine.revision,
						);
					}
				}
			}
			yield* store.touchEnvironment(environmentId, nowMs);
			yield* (yield* CloudWorkspaceStore).recordActivityByEnvironment(
				environmentId,
				principal.accountId,
				nowMs,
				nowMs + CLOUD_WORKSPACE_IDLE_MS,
			);
			const refreshed = yield* store.getEnvironment(environmentId);
			const machines = yield* MachineStore;
			const machine = yield* machines.findMachineByEnvironmentId(environmentId);
			if (
				machine !== null &&
				machine.accountId === principal.accountId &&
				machine.desiredState === "destroyed" &&
				machine.credentialCleanupRequestedAtMs !== undefined &&
				machine.credentialCleanupCompletedAtMs === undefined
			) {
				machineAction = "sanitize-credentials";
			}
			return json({
				ok: true,
				...(machineAction === undefined ? {} : { machineAction }),
				endpointCandidates:
					refreshed === null ? [] : endpointCandidates(refreshed),
			});
		}

		// 7. Agent activity (desktop, environment-credential auth) — never chat data.
		const activityMatch = /^\/v1\/environments\/([^/]+)\/agent-activity$/.exec(
			path,
		);
		if (method === "POST" && activityMatch !== null) {
			const environmentId = decodeURIComponent(activityMatch[1] ?? "");
			const principal = yield* requireEnvironmentCredential(
				request,
				environmentId,
			);
			const body = yield* readJson<{
				readonly sessionId?: string;
				readonly kind?: string;
				readonly title?: string;
			}>(request);
			if (hasSensitiveActivityKey(body)) {
				return yield* Effect.fail(badRequest("chat_data_not_allowed"));
			}
			if (typeof body.sessionId !== "string" || !isActivityKind(body.kind)) {
				return yield* Effect.fail(badRequest("invalid_activity"));
			}
			yield* (yield* CloudWorkspaceStore).recordActivityByEnvironment(
				environmentId,
				principal.accountId,
				nowMs,
				nowMs + CLOUD_WORKSPACE_IDLE_MS,
			);
			if (body.title !== undefined && typeof body.title !== "string") {
				return yield* Effect.fail(badRequest("invalid_activity"));
			}
			const activityKind = body.kind;
			yield* store.recordActivity({
				environmentId,
				accountId: principal.accountId,
				sessionId: body.sessionId,
				kind: activityKind,
				title: body.title,
				occurredAtMs: nowMs,
			});
			const devices = yield* store.listDevices(principal.accountId);
			const notifications = devices.flatMap((device) =>
				device.pushToken === undefined
					? []
					: [
							{
								to: device.pushToken,
								environmentId,
								kind: activityKind,
								title: body.title,
								target: `zuse://computers?environmentId=${encodeURIComponent(environmentId)}`,
							},
						],
			);
			yield* push.send(notifications).pipe(Effect.ignore);
			return json({ delivered: notifications.length });
		}

		return yield* Effect.fail(notFound());
	});

/** Public entrypoint: runs the router and maps failures to JSON responses. */
export const handleRequest = (
	request: Request,
): Effect.Effect<Response, never, RelayContext> =>
	Effect.gen(function* () {
		const config = yield* RelayConfiguration;
		if (request.method.toUpperCase() === "OPTIONS") {
			return withBrowserCors(
				new Response(null, { status: 204 }),
				request,
				config.allowedBrowserOrigins,
			);
		}
		const response = yield* route(request);
		return withBrowserCors(response, request, config.allowedBrowserOrigins);
	}).pipe(
		Effect.catch((error: RelayError) =>
			Effect.gen(function* () {
				const config = yield* RelayConfiguration;
				return withBrowserCors(
					json(
						error.detail === undefined
							? { error: error.code }
							: { error: error.code, detail: error.detail },
						error.status,
					),
					request,
					config.allowedBrowserOrigins,
				);
			}),
		),
		Effect.catchDefect((defect) =>
			Effect.sync(() => {
				const url = new URL(request.url);
				console.error("[zuse-relay] unhandled request defect", {
					method: request.method,
					path: url.pathname,
					defect:
						defect instanceof Error
							? { name: defect.name, message: defect.message }
							: String(defect),
				});
				return json({ error: "internal_error" }, 500);
			}),
		),
	);
