import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { decodeJwt } from "jose";

import { APP_SCHEME, WORKOS_API, workosClientId } from "./config.ts";

/**
 * WorkOS AuthKit sign-in on mobile, mirroring the desktop's public-client PKCE
 * flow (see apps/server/src/auth/layers/workos.ts): authorize with a
 * code_challenge, then exchange the code + code_verifier at
 * `/user_management/authenticate`. No client secret ships in the app.
 */
const SESSION_KEY = "zuse.mobile.workos.session.v1";
const REFRESH_SKEW_MS = 60_000;

// WorkOS refresh tokens are single-use. Callers that race on an expiring
// token must share one refresh, or every loser fails with invalid_grant and
// surfaces as a spurious sign-in error.
let refreshFlight: Promise<string> | null = null;
// Bumped on sign-in/out so a refresh that finishes afterwards cannot
// resurrect or overwrite the replaced session.
let sessionGeneration = 0;
const expiryListeners = new Set<() => void>();

/** Notified when WorkOS rejects the stored refresh token and the session is gone. */
export const onSessionExpired = (listener: () => void): (() => void) => {
	expiryListeners.add(listener);
	return () => {
		expiryListeners.delete(listener);
	};
};

/** A failed WorkOS authenticate call, with the OAuth `error` code if any. */
class WorkosAuthenticateError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | undefined,
	) {
		super(`workos_authenticate_${status}`);
	}
}

// Only `invalid_grant` means the refresh token itself is dead; retrying cannot
// recover, so stop presenting the account as signed in. A malformed request,
// server error or network failure keeps the session for a later retry.
const isRejectedRefresh = (cause: unknown): boolean =>
	cause instanceof WorkosAuthenticateError && cause.code === "invalid_grant";

export interface WorkosAccount {
	readonly id: string;
	readonly email: string | undefined;
}

interface StoredSession {
	readonly accessToken: string;
	readonly refreshToken: string;
	readonly expiresAtMs: number;
	readonly account: WorkosAccount;
}

const discovery: AuthSession.DiscoveryDocument = {
	authorizationEndpoint: `${WORKOS_API}/user_management/authorize`,
};

const redirectUri = (): string =>
	AuthSession.makeRedirectUri({ scheme: APP_SCHEME, path: "auth" });

const readSession = async (): Promise<StoredSession | null> => {
	const raw = await SecureStore.getItemAsync(SESSION_KEY);
	return raw === null ? null : (JSON.parse(raw) as StoredSession);
};

const writeSession = (session: StoredSession): Promise<void> =>
	SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));

const expiryOf = (accessToken: string): number => {
	try {
		const exp = decodeJwt(accessToken).exp;
		return typeof exp === "number" ? exp * 1000 : Date.now();
	} catch {
		return Date.now();
	}
};

interface AuthenticateResponse {
	readonly access_token: string;
	readonly refresh_token: string;
	readonly user?: { readonly id?: string; readonly email?: string };
}

const authenticate = async (
	body: Record<string, string>,
): Promise<StoredSession> => {
	const response = await fetch(`${WORKOS_API}/user_management/authenticate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: workosClientId(), ...body }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			readonly error?: unknown;
		} | null;
		throw new WorkosAuthenticateError(
			response.status,
			typeof body?.error === "string" ? body.error : undefined,
		);
	}
	const data = (await response.json()) as AuthenticateResponse;
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAtMs: expiryOf(data.access_token),
		account: { id: data.user?.id ?? "", email: data.user?.email },
	};
};

/** Run the interactive PKCE sign-in. Returns the signed-in account. */
export const signIn = async (): Promise<WorkosAccount> => {
	const clientId = workosClientId();
	if (clientId.trim().length === 0) {
		throw new Error("Remote access is not configured in this build.");
	}
	const request = new AuthSession.AuthRequest({
		clientId,
		redirectUri: redirectUri(),
		scopes: ["openid", "profile", "email", "offline_access"],
		usePKCE: true,
		extraParams: { provider: "authkit" },
	});
	await request.makeAuthUrlAsync(discovery);
	const result = await request.promptAsync(discovery);
	if (result.type !== "success" || result.params.code === undefined) {
		throw new Error("workos_sign_in_cancelled");
	}
	const session = await authenticate({
		grant_type: "authorization_code",
		code: result.params.code,
		code_verifier: request.codeVerifier ?? "",
	});
	sessionGeneration += 1;
	refreshFlight = null;
	await writeSession(session);
	return session.account;
};

export const signOut = async (): Promise<void> => {
	sessionGeneration += 1;
	refreshFlight = null;
	await SecureStore.deleteItemAsync(SESSION_KEY);
};

export const currentAccount = async (): Promise<WorkosAccount | null> => {
	const session = await readSession();
	return session?.account ?? null;
};

const refreshSession = async (
	session: StoredSession,
	generation: number,
): Promise<string> => {
	const refreshed = await authenticate({
		grant_type: "refresh_token",
		refresh_token: session.refreshToken,
	}).catch(async (cause: unknown) => {
		if (isRejectedRefresh(cause) && generation === sessionGeneration) {
			sessionGeneration += 1;
			await SecureStore.deleteItemAsync(SESSION_KEY);
			for (const listener of expiryListeners) listener();
			throw new Error("not_signed_in");
		}
		throw cause;
	});
	if (generation !== sessionGeneration) throw new Error("not_signed_in");
	await writeSession(refreshed);
	return refreshed.accessToken;
};

/** A valid WorkOS access token, refreshing when close to expiry. */
export const getAccessToken = async (): Promise<string> => {
	if (refreshFlight !== null) return refreshFlight;
	const generation = sessionGeneration;
	const session = await readSession();
	if (session === null) throw new Error("not_signed_in");
	if (session.expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
		return session.accessToken;
	}
	// Another caller may have started the refresh while this one read storage.
	if (refreshFlight !== null) return refreshFlight;
	const flight = refreshSession(session, generation).finally(() => {
		if (refreshFlight === flight) refreshFlight = null;
	});
	refreshFlight = flight;
	return flight;
};
