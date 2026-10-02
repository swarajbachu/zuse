import {
	type CloudControlRequest,
	makeCloudControlClient,
} from "@zuse/client-runtime/cloud-control-client";
import {
	type AccountControlRequest,
	makeAccountControlRequest,
} from "@zuse/client-runtime/cloud-control-request";
import {
	cloudControlError,
	organizationControlError,
} from "@zuse/client-runtime/control-api-error";
import { makeOrganizationControlClient } from "@zuse/client-runtime/organization-control-client";
import {
	ApiAccessToken,
	ApiConnectGrant,
	ApiEnvironmentList,
	ApiEnvironmentStatus,
	ApiPaths,
	CloudWorkspaceOpError,
	type MachineErrorCode,
	OrganizationError,
	WORKSPACE_API_PREFIX,
	WORKSPACE_SCOPE_HEADER,
	WorkspaceScope,
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

/** Revocation is idempotent so an interrupted logout can safely retry. */
export const revokeMobileDevice = async (deviceId: string): Promise<void> => {
	const token = await getWorkosToken();
	const response = await fetch(
		url(`/v1/clients/${encodeURIComponent(deviceId)}`),
		{
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok && response.status !== 404)
		throw await apiError(response, "device_revoke");
};

/** Permanently delete the authenticated account and all api-owned data. */
export const deleteAccount = async (): Promise<{ cleanupPending: boolean }> => {
	const workosToken = await getWorkosToken();
	const response = await fetch(url(ApiPaths.account), {
		method: "DELETE",
		headers: { authorization: `Bearer ${workosToken}` },
	});
	if (!response.ok) throw await apiError(response, "account_delete");
	const result = (await response.json()) as { cleanupPending?: boolean };
	resetApiAccessToken();
	return {
		cleanupPending: response.status === 202 || result.cleanupPending === true,
	};
};

export const resetApiAccessToken = (): void => {
	logConnectionDiagnostic("api.dpop_token.reset");
	apiAuthState.epoch += 1;
	apiAuthState.accessToken = null;
	apiAuthState.refresh = null;
};

/** Cloud control-plane access is account-owned, never proxied through a Mac. */
const accountControlRequest =
	<E>(
		scope: WorkspaceScope,
		toError: (code: MachineErrorCode) => E,
		accountEpoch?: number,
	): AccountControlRequest<E> =>
	(path, schema, method, body) =>
		Effect.gen(function* () {
			const epoch = accountEpoch ?? apiAuthState.epoch;
			if (epoch !== apiAuthState.epoch)
				return yield* Effect.fail(toError("not-allowed"));
			const token = yield* Effect.tryPromise({
				try: getWorkosToken,
				catch: () => toError("not-allowed"),
			});
			return yield* makeAccountControlRequest({
				isCurrent: () => epoch === apiAuthState.epoch,
				toError,
				send: (path, method, body, signal) =>
					fetch(
						url(
							scope.kind === "organization"
								? `${WORKSPACE_API_PREFIX}${scope.organizationId}${path}`
								: path,
						),
						{
							method,
							signal,
							headers: {
								[WORKSPACE_SCOPE_HEADER]:
									scope.kind === "personal"
										? "personal"
										: `organization:${scope.organizationId}`,
								authorization: `Bearer ${token}`,
								...(body === undefined
									? {}
									: { "content-type": "application/json" }),
							},
							body: body === undefined ? undefined : JSON.stringify(body),
						},
					),
			})(path, schema, method, body);
		});

// The server long-poll is bounded at 25s. Bound the native fetch too, so a
// half-open mobile network cannot pin catalog refresh or mailbox recovery.
const boundedCloudClient = (request: CloudControlRequest) =>
	makeCloudControlClient((...args) =>
		request(...args).pipe(
			Effect.timeout("30 seconds"),
			Effect.mapError((cause) =>
				cause instanceof CloudWorkspaceOpError
					? cause
					: new CloudWorkspaceOpError({ code: "provider-unavailable" }),
			),
		),
	);

/** Legacy callers remain Personal-only until their catalogs and routes are scoped. */
export const cloudControlClient = boundedCloudClient(
	accountControlRequest({ kind: "personal" }, cloudControlError),
);

/** Retained runtime clients keep their workspace and cannot cross an account reset. */
export const cloudControlClientForWorkspace = (scope: WorkspaceScope) =>
	boundedCloudClient(
		accountControlRequest(
			Schema.decodeUnknownSync(WorkspaceScope)(scope),
			cloudControlError,
			apiAuthState.epoch,
		),
	);

/** Organization administration uses account endpoints, never a selected-host transport. */
export const organizationControlClientForAccount = () => {
	const request = accountControlRequest(
		{ kind: "personal" },
		organizationControlError,
		apiAuthState.epoch,
	);
	return makeOrganizationControlClient((path, schema, body) =>
		request(path, schema, body === undefined ? "GET" : "POST", body).pipe(
			Effect.timeout("30 seconds"),
			Effect.mapError((cause) =>
				cause instanceof OrganizationError
					? cause
					: organizationControlError("provider-unavailable"),
			),
		),
	);
};
