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
		throw new Error(`workos_authenticate_${response.status}`);
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
	await writeSession(session);
	return session.account;
};

export const signOut = async (): Promise<void> => {
	await SecureStore.deleteItemAsync(SESSION_KEY);
};

export const currentAccount = async (): Promise<WorkosAccount | null> => {
	const session = await readSession();
	return session?.account ?? null;
};

/** A valid WorkOS access token, refreshing when close to expiry. */
export const getAccessToken = async (): Promise<string> => {
	const session = await readSession();
	if (session === null) throw new Error("not_signed_in");
	if (session.expiresAtMs - Date.now() > REFRESH_SKEW_MS) {
		return session.accessToken;
	}
	const refreshed = await authenticate({
		grant_type: "refresh_token",
		refresh_token: session.refreshToken,
	});
	await writeSession(refreshed);
	return refreshed.accessToken;
};
