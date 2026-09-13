import {
	type CloudControlRequest,
	makeCloudControlClient,
} from "@zuse/client-runtime/cloud-control-client";
import {
	ApiAccessToken,
	ApiConnectGrant,
	ApiEnvironmentList,
	ApiEnvironmentStatus,
	ApiPaths,
	CloudWorkspaceOpError,
} from "@zuse/contracts";
import { Effect, Schema } from "effect";

import { apiBaseUrl } from "../auth/config.ts";
import { devicePublicJwk, signDpopProof } from "../auth/dpop.ts";
import { getAccessToken as getWorkosToken } from "../auth/workos.ts";
import { normalizeApiError } from "./api-errors";
import {
	logConnectionDiagnostic,
	logConnectionProblem,
} from "./connection-diagnostics";

/**
 * Client for the account api's HTTP API. WorkOS-authenticated endpoints
 * (list) take the WorkOS bearer; DPoP-protected endpoints (status/connect/
 * register) take a api-minted access token + a fresh DPoP proof per request.
 */

type ApiAuthState = {
	accessToken: {
		readonly token: string;
		readonly expiresAtMs: number;
	} | null;
	refresh: Promise<string> | null;
	epoch: number;
};

const apiAuthStateKey = Symbol.for("@zuse/mobile/api-auth-state");
const apiAuthGlobal = globalThis as typeof globalThis & {
	[apiAuthStateKey]?: ApiAuthState;
};
const existingApiAuthState = apiAuthGlobal[apiAuthStateKey];
const apiAuthState: ApiAuthState = existingApiAuthState ?? {
	accessToken: null,
	refresh: null,
	epoch: 0,
};
if (existingApiAuthState === undefined) {
	apiAuthGlobal[apiAuthStateKey] = apiAuthState;
}

type CachedAccessToken = {
	readonly token: string;
	readonly expiresAtMs: number;
};

const decodeList = Schema.decodeUnknownPromise(ApiEnvironmentList);
const decodeStatus = Schema.decodeUnknownPromise(ApiEnvironmentStatus);
const decodeGrant = Schema.decodeUnknownPromise(ApiConnectGrant);
const decodeAccess = Schema.decodeUnknownPromise(ApiAccessToken);

const url = (path: string): string => `${apiBaseUrl()}${path}`;

const apiError = async (response: Response, prefix: string): Promise<Error> => {
	const text = await response.text().catch(() => "");
	return new Error(normalizeApiError(response.status, text, prefix));
};

const refreshAccessToken = async (epoch: number): Promise<string> => {
	logConnectionDiagnostic("api.dpop_token.refresh.start");
	const workosToken = await getWorkosToken();
	const target = url(ApiPaths.dpopToken);
	const response = await fetch(target, {
		method: "POST",
		headers: {
			authorization: `Bearer ${workosToken}`,
			dpop: await signDpopProof({ method: "POST", url: target }),
		},
	});
	if (!response.ok) {
		const error = await apiError(response, "api_dpop_token");
		logConnectionProblem("api.dpop_token.refresh.fail", {
			reason: error.message,
		});
		throw error;
	}
	const grant = await decodeAccess(await response.json());
	if (epoch !== apiAuthState.epoch) {
		throw new Error("api_access_token_reset");
	}
	const token: CachedAccessToken = {
		token: grant.accessToken,
		expiresAtMs: Date.now() + grant.expiresIn,
	};
	apiAuthState.accessToken = token;
	logConnectionDiagnostic("api.dpop_token.refresh.ok", {
		expiresIn: grant.expiresIn,
		expiresAtMs: token.expiresAtMs,
	});
	return grant.accessToken;
};

const ensureAccessToken = async (): Promise<string> => {
	const cached = apiAuthState.accessToken;
	if (cached !== null && cached.expiresAtMs - Date.now() > 30_000) {
		logConnectionDiagnostic("api.dpop_token.cache_hit", {
			expiresAtMs: cached.expiresAtMs,
		});
		return cached.token;
	}
	if (apiAuthState.refresh !== null) {
		logConnectionDiagnostic("api.dpop_token.refresh.join");
		return apiAuthState.refresh;
	}
	const refresh = refreshAccessToken(apiAuthState.epoch);
	apiAuthState.refresh = refresh;
	try {
		return await refresh;
	} finally {
		if (apiAuthState.refresh === refresh) apiAuthState.refresh = null;
	}
};

const dpopFetch = async (path: string, method: string): Promise<Response> => {
	const token = await ensureAccessToken();
	const target = url(path);
	logConnectionDiagnostic("api.request.start", { method, path });
	return fetch(target, {
		method,
		headers: {
			authorization: `DPoP ${token}`,
			dpop: await signDpopProof({ method, url: target }),
		},
	});
};

export const listEnvironments = async (): Promise<ApiEnvironmentList> => {
	const workosToken = await getWorkosToken();
	logConnectionDiagnostic("api.list.start");
	const response = await fetch(url(ApiPaths.environments), {
		headers: { authorization: `Bearer ${workosToken}` },
	});
	if (!response.ok) {
		const error = await apiError(response, "api_list");
		logConnectionProblem("api.list.fail", { reason: error.message });
		throw error;
	}
	const decoded = await decodeList(await response.json());
	logConnectionDiagnostic("api.list.ok", {
		environments: decoded.environments.length,
	});
	return decoded;
};

export const getEnvironmentStatus = async (
	environmentId: string,
): Promise<ApiEnvironmentStatus> => {
	const response = await dpopFetch(ApiPaths.status(environmentId), "POST");
	if (!response.ok) {
		const error = await apiError(response, "api_status");
		logConnectionProblem("api.status.fail", {
			environmentId,
			reason: error.message,
		});
		throw error;
	}
	const decoded = await decodeStatus(await response.json());
	logConnectionDiagnostic("api.status.ok", {
		environmentId,
		status: decoded.status,
		wsBaseUrl: decoded.endpoint.wsBaseUrl,
	});
	return decoded;
};

export const connectEnvironment = async (
	environmentId: string,
	localPairing?: {
		readonly serverNonce: string;
		readonly devicePublicKey: string;
		readonly transportCertificatePin: string;
	},
): Promise<ApiConnectGrant> => {
	const token = await ensureAccessToken();
	const target = url(ApiPaths.connect(environmentId));
	const response = await fetch(target, {
		method: "POST",
		headers: {
			authorization: `DPoP ${token}`,
			dpop: await signDpopProof({ method: "POST", url: target }),
			...(localPairing === undefined
				? {}
				: { "content-type": "application/json" }),
		},
		...(localPairing === undefined
			? {}
			: { body: JSON.stringify({ localPairing }) }),
	});
	if (!response.ok) {
		const error = await apiError(response, "api_connect");
		logConnectionProblem("api.connect.fail", {
			environmentId,
			reason: error.message,
		});
		throw error;
	}
	const decoded = await decodeGrant(await response.json());
	logConnectionDiagnostic("api.connect.ok", {
		environmentId,
		wsBaseUrl: decoded.endpoint.wsBaseUrl,
		expiresAt: decoded.expiresAt,
	});
	return decoded;
};

export const registerDevice = async (input: {
	readonly deviceId: string;
	readonly platform: "ios" | "android";
	readonly pushToken?: string;
}): Promise<void> => {
	const token = await ensureAccessToken();
	const target = url(ApiPaths.devices);
	const response = await fetch(target, {
		method: "POST",
		headers: {
			authorization: `DPoP ${token}`,
			dpop: await signDpopProof({ method: "POST", url: target }),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			deviceId: input.deviceId,
			platform: input.platform,
			pushToken: input.pushToken,
			dpopJwk: await devicePublicJwk(),
		}),
	});
	if (!response.ok) throw await apiError(response, "api_register");
	logConnectionDiagnostic("api.register_device.ok", {
		platform: input.platform,
		hasPushToken: input.pushToken !== undefined,
	});
};

/** Permanently delete the authenticated account and all api-owned data. */
export const deleteAccount = async (): Promise<void> => {
	const workosToken = await getWorkosToken();
	const response = await fetch(url(ApiPaths.account), {
		method: "DELETE",
		headers: { authorization: `Bearer ${workosToken}` },
	});
	if (!response.ok) throw await apiError(response, "account_delete");
	resetApiAccessToken();
};

export const resetApiAccessToken = (): void => {
	logConnectionDiagnostic("api.dpop_token.reset");
	apiAuthState.epoch += 1;
	apiAuthState.accessToken = null;
	apiAuthState.refresh = null;
};

/** Cloud control-plane access is account-owned, never proxied through a Mac. */
const cloudRequest: CloudControlRequest = (
	path,
	schema,
	method = "GET",
	body,
) =>
	Effect.gen(function* () {
		const epoch = apiAuthState.epoch;
		const token = yield* Effect.tryPromise({
			try: getWorkosToken,
			catch: () => new CloudWorkspaceOpError({ code: "not-allowed" }),
		});
		if (epoch !== apiAuthState.epoch)
			return yield* Effect.fail(
				new CloudWorkspaceOpError({ code: "not-allowed" }),
			);
		const response = yield* Effect.tryPromise({
			try: (signal) =>
				fetch(url(path), {
					method,
					signal,
					headers: {
						authorization: `Bearer ${token}`,
						...(body === undefined
							? {}
							: { "content-type": "application/json" }),
					},
					body: body === undefined ? undefined : JSON.stringify(body),
				}),
			catch: () => new CloudWorkspaceOpError({ code: "provider-unavailable" }),
		});
		if (epoch !== apiAuthState.epoch)
			return yield* Effect.fail(
				new CloudWorkspaceOpError({ code: "not-allowed" }),
			);
		const payload: unknown = yield* Effect.tryPromise({
			try: () => response.json(),
			catch: () => new CloudWorkspaceOpError({ code: "provider-unavailable" }),
		}).pipe(
			Effect.catch((cause) =>
				response.ok ? Effect.fail(cause) : Effect.succeed(null),
			),
		);
		if (!response.ok) {
			const error =
				typeof payload === "object" && payload !== null
					? (Reflect.get(payload, "error") ?? Reflect.get(payload, "code"))
					: null;
			const codes: Record<string, CloudWorkspaceOpError["code"]> = {
				cloud_beta_access_required: "beta-access-required",
				cloud_beta_access_unavailable: "beta-access-unavailable",
				cloud_entitlement_required: "entitlement-required",
				cloud_credential_connection_required: "credential-required",
				cloud_project_not_ready: "project-not-ready",
				cloud_image_rebuild_required: "project-not-ready",
				billing_hold: "billing-hold",
				entitlement_required: "entitlement-required",
				billing_approval_pending: "billing-hold",
			};
			return yield* Effect.fail(
				new CloudWorkspaceOpError({
					code:
						(typeof error === "string" ? codes[error] : undefined) ??
						(response.status === 401 || response.status === 403
							? "not-allowed"
							: response.status === 404
								? "not-found"
								: response.status === 409
									? "conflict"
									: response.status >= 500 || response.status === 429
										? "provider-unavailable"
										: "invalid-request"),
				}),
			);
		}
		return yield* Schema.decodeUnknownEffect(schema)(payload).pipe(
			Effect.mapError(
				() => new CloudWorkspaceOpError({ code: "invalid-request" }),
			),
		);
	});

// The server long-poll is bounded at 25s. Bound the native fetch too, so a
// half-open mobile network cannot pin catalog refresh or mailbox recovery.
export const cloudControlClient = makeCloudControlClient((...args) =>
	cloudRequest(...args).pipe(
		Effect.timeout("30 seconds"),
		Effect.mapError((cause) =>
			cause instanceof CloudWorkspaceOpError
				? cause
				: new CloudWorkspaceOpError({ code: "provider-unavailable" }),
		),
	),
);
