import {
	type ApiAuthTokenGrant,
	type ApiConnectGrant,
	type ApiEnvironmentList,
	type ApiEnvironmentStatus,
	ApiPaths,
	AuthUser,
	WIRE_PROTOCOL_VERSION,
	WORKOS_PUBLIC_CLIENT_ID,
	WORKOS_STAGING_PUBLIC_CLIENT_ID,
	WORKSPACE_API_PREFIX,
	WORKSPACE_SCOPE_HEADER,
	WorkspaceScope,
} from "@zuse/contracts";
import { Schema } from "effect";

import { rendererApiUrl } from "./api-url.ts";
import {
	decodeHostedJwtPayload,
	type HostedSession,
	hostedAccountId,
	hostedAuthState,
	jwtExpiry,
	publishHostedAuth,
	readSession,
	SESSION_KEY,
	writeSession,
} from "./hosted-session.ts";
import {
	assertRendererAccountCurrent,
	rendererAccountSnapshot,
	subscribeRendererAccount,
} from "./renderer-account.ts";

export {
	hostedAccountId,
	hostedAuthState,
	subscribeHostedAuth,
} from "./hosted-session.ts";
export { isHostedProduct } from "./platform-capabilities.ts";

import { isHostedProduct } from "./platform-capabilities.ts";
export const hostedAccountUser = (): AuthUser | null =>
	readSession()?.user ?? null;
export const hostedCacheDatabaseName = (base: string): string =>
	isHostedProduct() ? `${base}:hosted:${hostedAccountId()}` : base;

let sessionEpoch = 0;

const WORKOS_API = "https://api.workos.com";
const PKCE_KEY = "zuse.hosted.pkce.v1";
const DEVICE_ID_KEY = "zuse.hosted.device-id.v1";
const DPOP_DATABASE = "zuse-hosted-device";
const DPOP_STORE = "keys";
const DPOP_KEY = "account";

type StoredDpopKey = {
	readonly privateKey: CryptoKey;
	readonly publicJwk: JsonWebKey;
};

let apiAccess: { readonly token: string; readonly expiresAt: number } | null =
	null;

export type HostedEndpointLease = {
	readonly select: (
		environmentId: string,
		initial?: () => Promise<string>,
	) => Promise<void>;
	readonly next: () => Promise<string>;
	readonly clear: () => void;
};

export const createHostedEndpointLease = (
	refresh: (environmentId: string) => Promise<string>,
): HostedEndpointLease => {
	let selected: { environmentId: string; endpoint: string | null } | null =
		null;
	const load = async (selection: NonNullable<typeof selected>) => {
		const endpoint = await refresh(selection.environmentId);
		if (selection !== selected) throw new Error("hosted_environment_changed");
		return endpoint;
	};
	return {
		select: async (environmentId, initial) => {
			const selection: NonNullable<typeof selected> = {
				environmentId,
				endpoint: null,
			};
			selected = selection;
			const endpoint =
				initial === undefined ? await load(selection) : await initial();
			if (selection !== selected) throw new Error("hosted_environment_changed");
			selection.endpoint = endpoint;
		},
		next: async () => {
			if (selected === null) {
				throw new Error("hosted_environment_not_selected");
			}
			const selection = selected;
			const leased = selection.endpoint;
			selection.endpoint = null;
			if (leased === null) return load(selection);
			return leased;
		},
		clear: () => {
			selected = null;
		},
	};
};

const rpcEndpointLease = createHostedEndpointLease((environmentId) =>
	fetchHostedEndpoint(environmentId),
);
const unsubscribeAccount = subscribeRendererAccount(() => {
	apiAccess = null;
	rpcEndpointLease.clear();
});
if (import.meta.hot) import.meta.hot.dispose(unsubscribeAccount);

const environment = (): Record<string, string | undefined> =>
	(import.meta as { readonly env?: Record<string, string | undefined> }).env ??
	{};

export const resolveHostedWorkosClientId = (
	configuredClientId: string | undefined,
	development: boolean,
): string =>
	configuredClientId?.trim() ||
	(development ? WORKOS_STAGING_PUBLIC_CLIENT_ID : WORKOS_PUBLIC_CLIENT_ID);

const clientId = (): string =>
	resolveHostedWorkosClientId(
		environment().VITE_WORKOS_CLIENT_ID,
		import.meta.env.DEV,
	);
const base64url = (input: Uint8Array): string => {
	let raw = "";
	for (const byte of input) raw += String.fromCharCode(byte);
	return btoa(raw)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
};

const randomBase64url = (bytes: number): string => {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return base64url(value);
};

const sha256 = async (value: string): Promise<string> =>
	base64url(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
	);

export const hostedAuthTokenEndpoint = (baseUrl = rendererApiUrl()): string =>
	`${baseUrl.replace(/\/$/u, "")}${ApiPaths.authToken}`;

/** Only authoritative credential rejection invalidates the persisted login. */
class HostedAuthRejection extends Error {
	constructor(
		readonly status: number,
		code: string,
	) {
		super(code);
	}
}
const clearHostedSession = (): void => {
	// A tombstone also prevents a still-open legacy tab from migrating old tokens.
	localStorage.setItem(SESSION_KEY, "null");
	sessionStorage.removeItem(SESSION_KEY);
	publishHostedAuth();
};

/** Reload account-owned state when another tab signs out or changes account. */
export const watchHostedAccountChanges = (): (() => void) => {
	const account = (raw: string | null): string | null => {
		try {
			const token = JSON.parse(raw ?? "null")?.accessToken;
			if (typeof token !== "string") return null;
			const subject = decodeHostedJwtPayload(token)?.sub;
			return typeof subject === "string" ? subject : null;
		} catch {
			return null;
		}
	};
	const onStorage = (event: StorageEvent) => {
		if (
			event.storageArea !== localStorage ||
			(event.key !== SESSION_KEY && event.key !== null)
		)
			return;
		if (
			event.key !== null &&
			account(event.oldValue) === account(event.newValue)
		)
			return;
		sessionEpoch++;
		sessionStorage.removeItem(SESSION_KEY);
		apiAccess = null;
		rpcEndpointLease.clear();
		window.location.replace("/");
	};
	window.addEventListener("storage", onStorage);
	return () => window.removeEventListener("storage", onStorage);
};

const authenticate = async (
	grant: ApiAuthTokenGrant,
): Promise<HostedSession> => {
	const epoch = sessionEpoch;
	const response = await fetch(hostedAuthTokenEndpoint(), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(grant),
		signal: AbortSignal.timeout(15_000),
	});
	const value = (await response.json().catch(() => ({}))) as {
		readonly access_token?: unknown;
		readonly refresh_token?: unknown;
		readonly user?: unknown;
		readonly error?: unknown;
	};
	if (
		!response.ok ||
		typeof value.access_token !== "string" ||
		typeof value.refresh_token !== "string"
	) {
		throw new HostedAuthRejection(
			response.status,
			typeof value.error === "string"
				? value.error
				: `workos_auth_${response.status}`,
		);
	}
	let user: AuthUser;
	try {
		user = Schema.decodeUnknownSync(AuthUser)(value.user);
	} catch {
		throw new Error("hosted_auth_profile_missing");
	}
	if (
		epoch !== sessionEpoch ||
		(grant.grantType === "refresh_token" &&
			readSession()?.refreshToken !== grant.refreshToken)
	)
		throw new Error("hosted_auth_changed");
	return writeSession({
		user,
		accessToken: value.access_token,
		refreshToken: value.refresh_token,
		expiresAt: jwtExpiry(value.access_token),
	});
};

export const beginHostedSignIn = async (
	screenHint: "sign-in" | "sign-up" = "sign-in",
): Promise<void> => {
	const configuredClientId = clientId();
	if (configuredClientId.length === 0) {
		throw new Error("hosted_auth_not_configured");
	}
	const verifier = randomBase64url(32);
	const state = randomBase64url(16);
	const returnPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
	sessionStorage.setItem(
		PKCE_KEY,
		JSON.stringify({ verifier, state, returnPath }),
	);
	const url = new URL(`${WORKOS_API}/user_management/authorize`);
	url.searchParams.set("client_id", configuredClientId);
	url.searchParams.set(
		"redirect_uri",
		`${window.location.origin}/auth/callback`,
	);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("provider", "authkit");
	url.searchParams.set("screen_hint", screenHint);
	url.searchParams.set("code_challenge", await sha256(verifier));
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	window.location.assign(url.toString());
};

export const completeHostedSignIn = async (): Promise<boolean> => {
	if (window.location.pathname !== "/auth/callback") return false;
	const query = new URLSearchParams(window.location.search);
	const code = query.get("code");
	const returnedState = query.get("state");
	const raw = sessionStorage.getItem(PKCE_KEY);
	if (code === null || returnedState === null || raw === null) {
		throw new Error("hosted_auth_callback_invalid");
	}
	const pending = JSON.parse(raw) as {
		readonly verifier?: unknown;
		readonly state?: unknown;
		readonly returnPath?: unknown;
	};
	if (typeof pending.verifier !== "string" || pending.state !== returnedState) {
		throw new Error("hosted_auth_state_mismatch");
	}
	await authenticate({
		grantType: "authorization_code",
		code,
		codeVerifier: pending.verifier,
	});
	sessionStorage.removeItem(PKCE_KEY);
	const returnPath =
		typeof pending.returnPath === "string" &&
		pending.returnPath.startsWith("/") &&
		!pending.returnPath.startsWith("//")
			? pending.returnPath
			: "/";
	window.history.replaceState(null, "", returnPath);
	return true;
};

let tokenRefresh: Promise<string | null> | null = null;
export const hostedAccessToken = async (): Promise<string | null> => {
	const current = readSession();
	if (current === null) return null;
	if (current.expiresAt - Date.now() > 60_000 && current.user !== undefined)
		return current.accessToken;
	if (tokenRefresh !== null) return tokenRefresh;
	const epoch = sessionEpoch;
	const refresh = async (): Promise<string | null> => {
		// Re-read after acquiring the origin-wide lock: another tab may have rotated it.
		const session = readSession();
		if (epoch !== sessionEpoch || session === null) return null;
		if (session.expiresAt - Date.now() > 60_000 && session.user !== undefined)
			return session.accessToken;
		try {
			return (
				await authenticate({
					grantType: "refresh_token",
					refreshToken: session.refreshToken,
				})
			).accessToken;
		} catch (cause) {
			if (
				epoch !== sessionEpoch ||
				readSession()?.refreshToken !== session.refreshToken
			)
				return null;
			if (
				cause instanceof HostedAuthRejection &&
				[400, 401, 403].includes(cause.status) &&
				[
					"invalid_grant",
					"invalid_refresh_token",
					"refresh_token_revoked",
					"session_revoked",
				].includes(cause.message)
			) {
				clearHostedSession();
				return null;
			}
			// Network errors, rate limits, and server failures are retryable, not sign-out.
			throw cause;
		}
	};
	tokenRefresh = (async () => {
		if (globalThis.navigator?.locks)
			return await navigator.locks.request(
				"zuse.hosted.session.refresh",
				refresh,
			);
		return refresh();
	})().finally(() => {
		tokenRefresh = null;
	});
	return tokenRefresh;
};

const openDpopDatabase = (): Promise<IDBDatabase> =>
	new Promise((resolve, reject) => {
		const request = indexedDB.open(DPOP_DATABASE, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(DPOP_STORE);
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});

const readDpopKey = async (): Promise<StoredDpopKey | null> => {
	const db = await openDpopDatabase();
	try {
		return await new Promise((resolve, reject) => {
			const request = db
				.transaction(DPOP_STORE, "readonly")
				.objectStore(DPOP_STORE)
				.get(DPOP_KEY);
			request.onsuccess = () =>
				resolve((request.result as StoredDpopKey | undefined) ?? null);
			request.onerror = () => reject(request.error);
		});
	} finally {
		db.close();
	}
};

const writeDpopKey = async (key: StoredDpopKey): Promise<void> => {
	const db = await openDpopDatabase();
	try {
		await new Promise<void>((resolve, reject) => {
			const request = db
				.transaction(DPOP_STORE, "readwrite")
				.objectStore(DPOP_STORE)
				.put(key, DPOP_KEY);
			request.onsuccess = () => resolve();
			request.onerror = () => reject(request.error);
		});
	} finally {
		db.close();
	}
};

const dpopKey = async (): Promise<StoredDpopKey> => {
	const existing = await readDpopKey();
	if (existing !== null) return existing;
	const generated = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);
	const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
	const publicJwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
	const privateKey = await crypto.subtle.importKey(
		"jwk",
		privateJwk,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const stored = { privateKey, publicJwk };
	await writeDpopKey(stored);
	return stored;
};

const signDpopProof = async (input: {
	readonly method: string;
	readonly url: string;
}): Promise<string> => {
	const key = await dpopKey();
	const header = base64url(
		new TextEncoder().encode(
			JSON.stringify({ alg: "ES256", typ: "dpop+jwt", jwk: key.publicJwk }),
		),
	);
	const payload = base64url(
		new TextEncoder().encode(
			JSON.stringify({
				htm: input.method,
				htu: input.url,
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

const apiFetch = async (
	path: string,
	init: {
		readonly method: "GET" | "POST" | "DELETE";
		readonly token?: string;
		readonly body?: unknown;
	},
): Promise<Response> => {
	const account = rendererAccountSnapshot();
	const target = `${rendererApiUrl()}${path}`;
	const proof = await signDpopProof({ method: init.method, url: target });
	assertRendererAccountCurrent(account);
	const workosToken =
		init.token === undefined ? await hostedAccessToken() : null;
	assertRendererAccountCurrent(account);
	if (init.token === undefined && workosToken === null) {
		throw new Error("hosted_signed_out");
	}
	const response = await fetch(target, {
		signal: AbortSignal.timeout(15_000),
		method: init.method,
		headers: {
			authorization:
				init.token === undefined
					? `Bearer ${workosToken}`
					: `DPoP ${init.token}`,
			dpop: proof,
			...(init.body === undefined
				? {}
				: { "content-type": "application/json" }),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	assertRendererAccountCurrent(account);
	return response;
};

const ensureApiAccess = async (): Promise<string> => {
	const account = rendererAccountSnapshot();
	if (apiAccess !== null && apiAccess.expiresAt - Date.now() > 60_000) {
		return apiAccess.token;
	}
	const response = await apiFetch(ApiPaths.dpopToken, { method: "POST" });
	const body = (await response.json().catch(() => ({}))) as {
		readonly accessToken?: unknown;
		readonly expiresIn?: unknown;
		readonly error?: unknown;
	};
	assertRendererAccountCurrent(account);
	if (!response.ok || typeof body.accessToken !== "string") {
		throw new Error(
			typeof body.error === "string"
				? body.error
				: `api_token_${response.status}`,
		);
	}
	apiAccess = {
		token: body.accessToken,
		expiresAt:
			Date.now() +
			(typeof body.expiresIn === "number" ? body.expiresIn : 30 * 60_000),
	};
	return apiAccess.token;
};

export const hostedSignedIn = async (): Promise<boolean> => {
	const signedIn = (await hostedAccessToken()) !== null;
	publishHostedAuth();
	return signedIn && hostedAuthState()._tag === "SignedIn";
};

export const hostedAccountRequest = async (
	path: string,
	body?: unknown,
	options?: {
		readonly method?: string;
		readonly workspace?: WorkspaceScope;
		readonly signal?: AbortSignal;
	},
): Promise<Response> => {
	const account = rendererAccountSnapshot();
	const scope =
		options?.workspace === undefined
			? undefined
			: Schema.decodeUnknownSync(WorkspaceScope)(options.workspace);
	const scopedPath =
		scope?.kind === "organization"
			? `${WORKSPACE_API_PREFIX}${scope.organizationId}${path}`
			: path;
	const token = await hostedAccessToken();
	assertRendererAccountCurrent(account);
	if (token === null) throw new Error("hosted_signed_out");
	const response = await fetch(`${rendererApiUrl()}${scopedPath}`, {
		method: options?.method ?? (body === undefined ? "GET" : "POST"),
		headers: {
			...(scope === undefined
				? {}
				: {
						[WORKSPACE_SCOPE_HEADER]:
							scope.kind === "personal"
								? "personal"
								: `organization:${scope.organizationId}`,
					}),
			authorization: `Bearer ${token}`,
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal:
			options?.signal === undefined
				? AbortSignal.timeout(30_000)
				: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
	});
	assertRendererAccountCurrent(account);
	return response;
};

export const listHostedEnvironments = async (): Promise<ApiEnvironmentList> => {
	const account = rendererAccountSnapshot();
	const token = await ensureApiAccess();
	const response = await apiFetch(ApiPaths.environments, {
		method: "GET",
		token,
	});
	if (!response.ok) throw new Error(`api_environments_${response.status}`);
	const environments = (await response.json()) as ApiEnvironmentList;
	assertRendererAccountCurrent(account);
	return environments;
};

/** Presence checks do not connect to or wake the runtime. */
export const getHostedComputerStatus = async (
	environmentId: string,
): Promise<ApiEnvironmentStatus> => {
	const token = await ensureApiAccess();
	const response = await apiFetch(ApiPaths.status(environmentId), {
		method: "POST",
		token,
	});
	if (!response.ok) throw new Error(`api_status_${response.status}`);
	return (await response.json()) as ApiEnvironmentStatus;
};

export const removeHostedComputer = async (
	environmentId: string,
): Promise<void> => {
	const account = rendererAccountSnapshot();
	const token = await ensureApiAccess();
	assertRendererAccountCurrent(account);
	const response = await apiFetch(ApiPaths.unlink, {
		method: "POST",
		token,
		body: { environmentId },
	});
	if (!response.ok && response.status !== 404)
		throw new Error(`api_unlink_${response.status}`);
};

export const registerHostedClient = async (): Promise<void> => {
	const account = rendererAccountSnapshot();
	const token = await ensureApiAccess();
	assertRendererAccountCurrent(account);
	const key = await dpopKey();
	assertRendererAccountCurrent(account);
	let deviceId = localStorage.getItem(DEVICE_ID_KEY);
	if (deviceId === null) {
		deviceId = crypto.randomUUID();
		localStorage.setItem(DEVICE_ID_KEY, deviceId);
	}
	const response = await apiFetch(ApiPaths.devices, {
		method: "POST",
		token,
		body: {
			deviceId,
			platform: "web",
			dpopJwk: key.publicJwk,
		},
	});
	if (!response.ok) throw new Error(`api_device_${response.status}`);
};

export const hostedConnectGrantEndpoint = (grant: ApiConnectGrant): string => {
	const url = new URL(grant.endpoint.wsBaseUrl);
	url.searchParams.set("token", grant.connectToken);
	url.searchParams.set("wireVersion", String(WIRE_PROTOCOL_VERSION));
	return url.toString();
};

const fetchHostedGrant = async (
	environmentId: string,
): Promise<ApiConnectGrant> => {
	const account = rendererAccountSnapshot();
	const token = await ensureApiAccess();
	assertRendererAccountCurrent(account);
	const response = await apiFetch(ApiPaths.connect(environmentId), {
		method: "POST",
		token,
		body: {
			wireProtocolVersion: WIRE_PROTOCOL_VERSION,
			requireManaged: window.location.protocol === "https:",
		},
	});
	const body = (await response.json().catch(() => ({}))) as
		| ApiConnectGrant
		| { readonly error?: unknown };
	assertRendererAccountCurrent(account);
	if (!response.ok || !("connectToken" in body)) {
		throw new Error(
			"error" in body && typeof body.error === "string"
				? body.error
				: `api_connect_${response.status}`,
		);
	}
	return body;
};

const fetchHostedEndpoint = async (environmentId: string): Promise<string> =>
	hostedConnectGrantEndpoint(await fetchHostedGrant(environmentId));

export const connectHostedEnvironment = async (
	environmentId: string,
	options: { lease?: boolean } = {},
): Promise<ApiConnectGrant> => {
	if (options.lease === false) return fetchHostedGrant(environmentId);
	const grant = fetchHostedGrant(environmentId);
	await rpcEndpointLease.select(environmentId, async () =>
		hostedConnectGrantEndpoint(await grant),
	);
	return grant;
};

export const nextHostedRpcEndpoint = (): Promise<string> =>
	rpcEndpointLease.next();

export const signOutHostedProduct = async (): Promise<void> => {
	const accountId = hostedAccountId();
	const deviceId = localStorage.getItem(DEVICE_ID_KEY);
	// Mint the DPoP-bound token and pre-sign the revocation proof while the
	// session and the device key still exist; the teardown below clears both.
	const revokeDevice =
		deviceId === null
			? null
			: await (async () => {
					try {
						const accessToken = await ensureApiAccess();
						const target = `${rendererApiUrl()}${ApiPaths.client(deviceId)}`;
						const proof = await signDpopProof({
							method: "DELETE",
							url: target,
						});
						return () =>
							fetch(target, {
								method: "DELETE",
								signal: AbortSignal.timeout(5_000),
								headers: {
									authorization: `DPoP ${accessToken}`,
									dpop: proof,
								},
							});
					} catch {
						return null;
					}
				})();
	sessionEpoch++;
	clearHostedSession();
	const { resetSessionTimelineClientBus } = await import(
		"./session-timeline-client-bus.ts"
	);
	await resetSessionTimelineClientBus({ clearAccount: true });
	if (typeof indexedDB.databases === "function") {
		const databases = await indexedDB.databases();
		for (const database of databases) {
			if (database.name?.endsWith(`:hosted:${accountId}`))
				indexedDB.deleteDatabase(database.name);
		}
	}

	sessionStorage.removeItem(SESSION_KEY);
	publishHostedAuth();
	if (revokeDevice !== null) {
		await revokeDevice().catch(() => undefined);
	}
	sessionStorage.removeItem(PKCE_KEY);
	localStorage.removeItem(DEVICE_ID_KEY);
	apiAccess = null;
	rpcEndpointLease.clear();
	await new Promise<void>((resolve) => {
		const request = indexedDB.deleteDatabase(DPOP_DATABASE);
		request.onsuccess = () => resolve();
		request.onerror = () => resolve();
		request.onblocked = () => resolve();
	});
	window.location.assign("/");
};
