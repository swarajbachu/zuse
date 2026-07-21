import { Clock, Effect, Redacted } from "effect";

import { AccountIdentity } from "./account-identity.ts";

import {
	mintAccessToken,
	RELAY_SCOPES,
	requireDpop,
	requireEnvironmentCredential,
	requireWorkos,
} from "./auth.ts";
import { RelayConfiguration } from "./config.ts";
import {
	parseJwk,
	randomToken,
	sha256Hex,
	signConnectToken,
	verifyEnvironmentLinkProof,
} from "./crypto.ts";
import { badRequest, gone, notFound, type RelayError } from "./errors.ts";
import { ManagedTunnelProvider } from "./managed-tunnel.ts";
import { PushDelivery } from "./push.ts";
import {
	type ActivityKind,
	type DevicePlatform,
	type EnvironmentRecord,
	type ProviderKind,
	RelayStore,
} from "./store.ts";
import type { WorkosVerifier } from "./workos.ts";

export type RelayContext =
	| AccountIdentity
	| WorkosVerifier
	| RelayStore
	| RelayConfiguration
	| ManagedTunnelProvider
	| PushDelivery;

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const readJson = <A>(request: Request): Effect.Effect<A, RelayError> =>
	Effect.tryPromise({
		try: () => request.json() as Promise<A>,
		catch: () => badRequest("invalid_json"),
	});

const isProviderKind = (value: unknown): value is ProviderKind =>
	value === "desktop" || value === "ssh" || value === "cloud";

const isPlatform = (value: unknown): value is DevicePlatform =>
	value === "ios" || value === "android" || value === "web";

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
		const nowMs = yield* Clock.currentTimeMillis;

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

			yield* store.upsertEnvironment({
				environmentId: body.environmentId,
				accountId: principal.accountId,
				orgId: principal.orgId,
				providerKind: body.providerKind,
				label: body.label,
				environmentPublicKey: body.environmentPublicKey,
				httpBaseUrl: body.endpoint.httpBaseUrl,
				wsBaseUrl: body.endpoint.wsBaseUrl,
				linkedAtMs: nowMs,
			});

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
			return json({
				environments: environments.map((environment) => ({
					environmentId: environment.environmentId,
					label: environment.label,
					providerKind: environment.providerKind,
					endpoint: publicEndpoint(environment),
					linkedAt: environment.linkedAtMs,
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
			yield* store.upsertDevice({
				deviceId: body.deviceId,
				accountId: principal.accountId,
				platform: body.platform,
				pushToken: body.pushToken,
				dpopJwk: body.dpopJwk,
				updatedAtMs: nowMs,
			});
			return json({ ok: true });
		}

		// Permanently delete the authenticated account. Relay records and managed
		// infrastructure are removed first; a still-valid bearer can safely retry
		// if the final identity-provider request is temporarily unavailable.
		if (method === "DELETE" && path === "/v1/account") {
			const principal = yield* requireWorkos(request);
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
			return json({ ok: true });
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
			let localPairing:
				| {
						readonly serverNonce: string;
						readonly devicePublicKey: string;
						readonly transportCertificatePin: string;
				  }
				| undefined;
			if (request.headers.get("content-type")?.includes("application/json")) {
				const body = yield* readJson<{
					readonly localPairing?: {
						readonly serverNonce?: unknown;
						readonly devicePublicKey?: unknown;
						readonly transportCertificatePin?: unknown;
					};
				}>(request);
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
			const hasJsonBody = request.headers
				.get("content-type")
				?.toLowerCase()
				.includes("application/json");
			if (hasJsonBody === true) {
				const body = yield* readJson<{ readonly origin?: unknown }>(request);
				if (!isLoopbackOrigin(body.origin)) {
					return yield* Effect.fail(badRequest("invalid_tunnel_origin"));
				}
				const environment = yield* store.getEnvironment(environmentId);
				if (
					environment === null ||
					environment.accountId !== principal.accountId
				) {
					return yield* Effect.fail(notFound());
				}
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
			yield* store.touchEnvironment(environmentId, nowMs);
			return json({ ok: true });
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
	route(request).pipe(
		Effect.catch((error: RelayError) =>
			Effect.succeed(
				json(
					error.detail === undefined
						? { error: error.code }
						: { error: error.code, detail: error.detail },
					error.status,
				),
			),
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
