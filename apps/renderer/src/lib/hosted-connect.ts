import {
	type RelayConnectGrant,
	type RelayEnvironmentList,
	RelayPaths,
	WIRE_PROTOCOL_VERSION,
	WORKOS_PUBLIC_CLIENT_ID,
} from "@zuse/contracts";

const WORKOS_API = "https://api.workos.com";
const SESSION_KEY = "zuse.hosted.session.v1";
const PKCE_KEY = "zuse.hosted.pkce.v1";
const DEVICE_ID_KEY = "zuse.hosted.device-id.v1";
const DPOP_DATABASE = "zuse-hosted-device";
const DPOP_STORE = "keys";
const DPOP_KEY = "account";

type HostedSession = {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly expiresAt: number;
};

type StoredDpopKey = {
	readonly privateKey: CryptoKey;
	readonly publicJwk: JsonWebKey;
};

let rpcEndpoint: string | null = null;
let relayAccess: { readonly token: string; readonly expiresAt: number } | null =
	null;

const environment = (): Record<string, string | undefined> =>
	(import.meta as { readonly env?: Record<string, string | undefined> }).env ??
	{};

export const isHostedProduct = (): boolean =>
	environment().VITE_ZUSE_HOSTED === "1" ||
	window.location.hostname === "app.zuse.sh";

const clientId = (): string =>
	environment().VITE_WORKOS_CLIENT_ID?.trim() || WORKOS_PUBLIC_CLIENT_ID;
const relayUrl = (): string =>
	(
		environment().VITE_ZUSE_RELAY_URL?.trim() || "https://relay.stuff.md"
	).replace(/\/$/u, "");

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

const jwtExpiry = (token: string): number => {
	try {
		const encoded = token.split(".")[1];
		if (encoded === undefined) return Date.now() + 5 * 60_000;
		const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
		const payload = JSON.parse(atob(normalized)) as { readonly exp?: unknown };
		return typeof payload.exp === "number"
			? payload.exp * 1_000
			: Date.now() + 5 * 60_000;
	} catch {
		return Date.now() + 5 * 60_000;
	}
};

const readSession = (): HostedSession | null => {
	try {
		const raw = sessionStorage.getItem(SESSION_KEY);
		if (raw === null) return null;
		const value = JSON.parse(raw) as Partial<HostedSession>;
		return typeof value.accessToken === "string" &&
			typeof value.refreshToken === "string" &&
			typeof value.expiresAt === "number"
			? (value as HostedSession)
			: null;
	} catch {
		return null;
	}
};

const writeSession = (session: HostedSession): HostedSession => {
	sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
	return session;
};

const authenticate = async (
	body: Record<string, string>,
): Promise<HostedSession> => {
	const response = await fetch(`${WORKOS_API}/user_management/authenticate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(15_000),
	});
	const value = (await response.json().catch(() => ({}))) as {
		readonly access_token?: unknown;
		readonly refresh_token?: unknown;
		readonly error?: unknown;
	};
	if (
		!response.ok ||
		typeof value.access_token !== "string" ||
		typeof value.refresh_token !== "string"
	) {
		throw new Error(
			typeof value.error === "string"
				? value.error
				: `workos_auth_${response.status}`,
		);
	}
	return writeSession({
		accessToken: value.access_token,
		refreshToken: value.refresh_token,
		expiresAt: jwtExpiry(value.access_token),
	});
};

export const beginHostedSignIn = async (): Promise<void> => {
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
		client_id: clientId(),
		grant_type: "authorization_code",
		code,
		code_verifier: pending.verifier,
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

const accessToken = async (): Promise<string | null> => {
	const session = readSession();
	if (session === null) return null;
	if (session.expiresAt - Date.now() > 60_000) return session.accessToken;
	try {
		return (
			await authenticate({
				client_id: clientId(),
				grant_type: "refresh_token",
				refresh_token: session.refreshToken,
			})
		).accessToken;
	} catch {
		sessionStorage.removeItem(SESSION_KEY);
		return null;
	}
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

const relayFetch = async (
	path: string,
	init: {
		readonly method: "POST";
		readonly token?: string;
		readonly body?: unknown;
	},
): Promise<Response> => {
	const target = `${relayUrl()}${path}`;
	const proof = await signDpopProof({ method: init.method, url: target });
	const workosToken = init.token === undefined ? await accessToken() : null;
	if (init.token === undefined && workosToken === null) {
		throw new Error("hosted_signed_out");
	}
	return fetch(target, {
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
};

const ensureRelayAccess = async (): Promise<string> => {
	if (relayAccess !== null && relayAccess.expiresAt - Date.now() > 60_000) {
		return relayAccess.token;
	}
	const response = await relayFetch(RelayPaths.dpopToken, { method: "POST" });
	const body = (await response.json().catch(() => ({}))) as {
		readonly accessToken?: unknown;
		readonly expiresIn?: unknown;
		readonly error?: unknown;
	};
	if (!response.ok || typeof body.accessToken !== "string") {
		throw new Error(
			typeof body.error === "string"
				? body.error
				: `relay_token_${response.status}`,
		);
	}
	relayAccess = {
		token: body.accessToken,
		expiresAt:
			Date.now() +
			(typeof body.expiresIn === "number" ? body.expiresIn : 30 * 60_000),
	};
	return relayAccess.token;
};

export const hostedSignedIn = async (): Promise<boolean> =>
	(await accessToken()) !== null;

export const listHostedEnvironments =
	async (): Promise<RelayEnvironmentList> => {
		const token = await accessToken();
		if (token === null) throw new Error("hosted_signed_out");
		const response = await fetch(`${relayUrl()}${RelayPaths.environments}`, {
			headers: { authorization: `Bearer ${token}` },
		});
		if (!response.ok) throw new Error(`relay_environments_${response.status}`);
		return (await response.json()) as RelayEnvironmentList;
	};

export const registerHostedClient = async (): Promise<void> => {
	const token = await ensureRelayAccess();
	const key = await dpopKey();
	let deviceId = localStorage.getItem(DEVICE_ID_KEY);
	if (deviceId === null) {
		deviceId = crypto.randomUUID();
		localStorage.setItem(DEVICE_ID_KEY, deviceId);
	}
	const target = `${relayUrl()}${RelayPaths.devices}`;
	const response = await fetch(target, {
		method: "POST",
		headers: {
			authorization: `DPoP ${token}`,
			dpop: await signDpopProof({ method: "POST", url: target }),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			deviceId,
			platform: "web",
			dpopJwk: key.publicJwk,
		}),
	});
	if (!response.ok) throw new Error(`relay_device_${response.status}`);
};

export const connectHostedEnvironment = async (
	environmentId: string,
): Promise<RelayConnectGrant> => {
	const token = await ensureRelayAccess();
	const response = await relayFetch(RelayPaths.connect(environmentId), {
		method: "POST",
		token,
		body: {
			wireProtocolVersion: WIRE_PROTOCOL_VERSION,
			requireManaged: window.location.protocol === "https:",
		},
	});
	const body = (await response.json().catch(() => ({}))) as
		| RelayConnectGrant
		| { readonly error?: unknown };
	if (!response.ok || !("connectToken" in body)) {
		throw new Error(
			"error" in body && typeof body.error === "string"
				? body.error
				: `relay_connect_${response.status}`,
		);
	}
	const url = new URL(body.endpoint.wsBaseUrl);
	url.searchParams.set("token", body.connectToken);
	url.searchParams.set("wireVersion", String(WIRE_PROTOCOL_VERSION));
	rpcEndpoint = url.toString();
	return body;
};

export const hostedRpcEndpoint = (): string | null => rpcEndpoint;

export const signOutHostedProduct = async (): Promise<void> => {
	const token = await accessToken();
	const deviceId = localStorage.getItem(DEVICE_ID_KEY);
	if (token !== null && deviceId !== null) {
		await fetch(`${relayUrl()}${RelayPaths.client(deviceId)}`, {
			method: "DELETE",
			headers: { authorization: `Bearer ${token}` },
		}).catch(() => undefined);
	}
	sessionStorage.removeItem(SESSION_KEY);
	sessionStorage.removeItem(PKCE_KEY);
	localStorage.removeItem(DEVICE_ID_KEY);
	relayAccess = null;
	rpcEndpoint = null;
	await new Promise<void>((resolve) => {
		const request = indexedDB.deleteDatabase(DPOP_DATABASE);
		request.onsuccess = () => resolve();
		request.onerror = () => resolve();
		request.onblocked = () => resolve();
	});
	window.location.assign("/");
};
