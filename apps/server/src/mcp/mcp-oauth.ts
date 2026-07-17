import * as http from "node:http";
import type { AddressInfo } from "node:net";

import {
	auth,
	type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { Effect } from "effect";

/**
 * Everything the MCP SDK's OAuthClientProvider needs to persist between
 * runs, serialized as one JSON keychain entry per server
 * (`mcpOAuth:<serverKey>`): the dynamic client registration, the token
 * set, and the in-flight PKCE verifier.
 */
interface McpOauthBundle {
	clientInformation?: OAuthClientInformationMixed;
	tokens?: OAuthTokens;
	codeVerifier?: string;
}

const parseBundle = (raw: string | null): McpOauthBundle => {
	if (raw === null) return {};
	try {
		return JSON.parse(raw) as McpOauthBundle;
	} catch {
		return {};
	}
};

export interface McpOauthStore {
	readonly load: () => Promise<string | null>;
	readonly save: (bundleJson: string) => Promise<void>;
}

class RedirectRequested extends Error {
	constructor(readonly url: string) {
		super("oauth redirect requested");
	}
}

const makeProvider = (options: {
	readonly bundle: McpOauthBundle;
	readonly redirectUrl: string | undefined;
	readonly persist: () => Promise<void>;
	readonly onRedirect: (url: string) => void;
}): OAuthClientProvider => ({
	get redirectUrl() {
		return options.redirectUrl;
	},
	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Zuse",
			redirect_uris:
				options.redirectUrl === undefined ? [] : [options.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	},
	clientInformation: () => options.bundle.clientInformation,
	saveClientInformation: async (clientInformation) => {
		options.bundle.clientInformation = clientInformation;
		await options.persist();
	},
	tokens: () => options.bundle.tokens,
	saveTokens: async (tokens) => {
		options.bundle.tokens = tokens;
		await options.persist();
	},
	redirectToAuthorization: (authorizationUrl) => {
		options.onRedirect(authorizationUrl.toString());
	},
	saveCodeVerifier: async (codeVerifier) => {
		options.bundle.codeVerifier = codeVerifier;
		await options.persist();
	},
	codeVerifier: () => options.bundle.codeVerifier ?? "",
});

const CALLBACK_PATH = "/callback";
const CALLBACK_PAGE = `<!doctype html><meta charset="utf-8"><title>Zuse</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<p>You're connected. You can close this tab and return to Zuse.</p></body>`;

/**
 * One loopback HTTP listener per flow, on an ephemeral 127.0.0.1 port —
 * the same shape the WorkOS dev flow uses. Resolves with the `code` query
 * param of the first `/callback` hit.
 */
const listenForCallback = (): Promise<{
	redirectUrl: string;
	waitForCode: Promise<string>;
	close: () => void;
}> =>
	new Promise((resolveListener, rejectListener) => {
		let resolveCode: (code: string) => void;
		let rejectCode: (error: Error) => void;
		const waitForCode = new Promise<string>((resolve, reject) => {
			resolveCode = resolve;
			rejectCode = reject;
		});
		const server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			if (url.pathname !== CALLBACK_PATH) {
				res.writeHead(404).end();
				return;
			}
			res.writeHead(200, { "content-type": "text/html" }).end(CALLBACK_PAGE);
			const code = url.searchParams.get("code");
			const error = url.searchParams.get("error");
			if (code !== null) resolveCode(code);
			else {
				rejectCode(
					new Error(
						error !== null
							? `authorization failed: ${error}`
							: "authorization response had no code",
					),
				);
			}
		});
		server.once("error", rejectListener);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as AddressInfo;
			resolveListener({
				redirectUrl: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
				waitForCode,
				close: () => server.close(),
			});
		});
	});

const CODE_TIMEOUT_MS = 300_000;

/**
 * Full OAuth 2.1 flow for a claude-source http server: metadata discovery,
 * dynamic client registration, PKCE, loopback redirect. The SDK's `auth()`
 * drives the protocol; we supply persistence (keychain via `store`) and
 * hand the authorization URL to `onAuthorizationUrl` (the renderer opens
 * the browser). Resolves once tokens are saved.
 */
export const runMcpOauthFlow = (options: {
	readonly serverUrl: string;
	readonly store: McpOauthStore;
	readonly onAuthorizationUrl: (url: string) => void;
}): Effect.Effect<void, Error> =>
	Effect.tryPromise({
		try: async () => {
			const bundle = parseBundle(await options.store.load());
			const listener = await listenForCallback();
			try {
				const provider = makeProvider({
					bundle,
					redirectUrl: listener.redirectUrl,
					persist: () => options.store.save(JSON.stringify(bundle)),
					onRedirect: options.onAuthorizationUrl,
				});
				const first = await auth(provider, { serverUrl: options.serverUrl });
				if (first === "AUTHORIZED") return;
				const code = await Promise.race([
					listener.waitForCode,
					new Promise<never>((_resolve, reject) =>
						setTimeout(
							() => reject(new Error("timed out waiting for the browser")),
							CODE_TIMEOUT_MS,
						),
					),
				]);
				const second = await auth(provider, {
					serverUrl: options.serverUrl,
					authorizationCode: code,
				});
				if (second !== "AUTHORIZED") {
					throw new Error("token exchange did not complete");
				}
			} finally {
				listener.close();
			}
		},
		catch: (cause) =>
			cause instanceof Error ? cause : new Error(String(cause)),
	});

/**
 * Returns a currently-valid access token for header injection at session
 * start / probe time, refreshing through the SDK when expired. Never
 * interactive: if a fresh authorization would be needed, resolves `null`
 * (the status layer then reports `needs-auth`).
 */
export const getValidMcpAccessToken = (options: {
	readonly serverUrl: string;
	readonly store: McpOauthStore;
}): Effect.Effect<string | null> =>
	Effect.tryPromise({
		try: async () => {
			const bundle = parseBundle(await options.store.load());
			if (bundle.tokens === undefined) return null;
			const provider = makeProvider({
				bundle,
				redirectUrl: undefined,
				persist: () => options.store.save(JSON.stringify(bundle)),
				onRedirect: (url) => {
					throw new RedirectRequested(url);
				},
			});
			try {
				const result = await auth(provider, { serverUrl: options.serverUrl });
				return result === "AUTHORIZED"
					? (bundle.tokens?.access_token ?? null)
					: null;
			} catch {
				// Refresh failed (revoked, expired refresh token, offline) — fall
				// back to the stored access token if present; the server will 401
				// and status will flip to needs-auth.
				return bundle.tokens?.access_token ?? null;
			}
		},
		catch: () => null,
	}).pipe(Effect.catch(() => Effect.succeed(null)));
