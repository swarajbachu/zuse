import { ApiPaths, PRODUCTION_API_URL, STAGING_API_URL } from "@zuse/contracts";
import { BROWSER_PAGE_HEADERS } from "@zuse/utils/browser-page";
import { githubInstallationSettingsUrl } from "@zuse/utils/github-installation";
import {
	type IntegrationPageInput,
	renderIntegrationPage,
} from "@zuse/utils/integration-page";
import { Clock, Effect, Redacted, Schema } from "effect";
import { decodeJwt, importJWK, importPKCS8, jwtVerify, SignJWT } from "jose";
import { githubRequest } from "./cloud-github-request.ts";
import {
	exchangeGithubUserToken,
	GithubUserAuthorization,
	prepareGithubUserAuthorization,
} from "./cloud-github-user.ts";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { parseJwk } from "./crypto.ts";
import {
	ApiError,
	badRequest,
	serviceUnavailable,
	unauthorized,
} from "./errors.ts";
import { renderGithubConnectedPage } from "./github-callback-page.ts";
import { json } from "./http.ts";
import { getOrganizationName } from "./organizations.ts";
import { resolveWorkspaceActorAccess } from "./workspace-authorization.ts";
import { workspaceScopeForOwner } from "./workspace-scope.ts";

const INSTALL_STATE_TTL_MS = 10 * 60_000;
const GithubInstallation = Schema.Struct({
	id: Schema.Number,
	account: Schema.Struct({
		id: Schema.Number,
		login: Schema.String,
		type: Schema.Literals(["User", "Organization"]),
		avatar_url: Schema.optionalKey(Schema.String),
	}),
	repository_selection: Schema.Literals(["all", "selected"]),
	suspended_at: Schema.NullOr(Schema.String),
});
const RSA_ALGORITHM_IDENTIFIER = Uint8Array.from([
	0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
	0x05, 0x00,
]);

const derLength = (length: number): Uint8Array => {
	if (length < 0x80) return Uint8Array.of(length);
	const bytes: Array<number> = [];
	for (let remaining = length; remaining > 0; remaining >>>= 8)
		bytes.unshift(remaining & 0xff);
	return Uint8Array.of(0x80 | bytes.length, ...bytes);
};

const derValue = (tag: number, value: Uint8Array): Uint8Array =>
	Uint8Array.from([tag, ...derLength(value.length), ...value]);

const pemBody = (pem: string): Uint8Array => {
	const encoded = pem.replace(/-----[^-]+-----|\s/gu, "");
	return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
};

const encodePem = (label: string, der: Uint8Array): string => {
	let binary = "";
	for (const byte of der) binary += String.fromCharCode(byte);
	const encoded =
		btoa(binary)
			.match(/.{1,64}/gu)
			?.join("\n") ?? "";
	return `-----BEGIN ${label}-----\n${encoded}\n-----END ${label}-----`;
};

/** GitHub currently downloads RSA keys as PKCS#1; jose imports PKCS#8. */
export const normalizeGithubPrivateKey = (pem: string): string => {
	if (pem.includes("-----BEGIN PRIVATE KEY-----")) return pem;
	if (!pem.includes("-----BEGIN RSA PRIVATE KEY-----"))
		throw new Error("unsupported_github_private_key");
	const privateKey = derValue(0x04, pemBody(pem));
	const body = Uint8Array.from([
		0x02,
		0x01,
		0x00,
		...RSA_ALGORITHM_IDENTIFIER,
		...privateKey,
	]);
	return encodePem("PRIVATE KEY", derValue(0x30, body));
};

/**
 * The GitHub App has one Setup URL. Production owns it and forwards a state
 * that claims the exact staging issuer to staging, where the signature is
 * actually verified. The unverified issuer is only an allowlisted routing
 * hint and can never select an arbitrary destination.
 */
export const githubInstallCallbackForwardUrl = (
	state: string,
	installationId: number,
	currentIssuer: string,
): string | null => {
	if (currentIssuer !== PRODUCTION_API_URL) return null;
	let issuer: unknown;
	try {
		issuer = decodeJwt(state).iss;
	} catch {
		return null;
	}
	if (issuer !== STAGING_API_URL) return null;
	const target = new URL(ApiPaths.cloudGithubCallback, STAGING_API_URL);
	target.searchParams.set("state", state);
	target.searchParams.set("installation_id", String(installationId));
	return target.toString();
};

const appJwt = Effect.fn("githubAppJwt")(function* (forceAppId = false) {
	const config = yield* ApiConfiguration;
	const github = config.githubApp;
	if (github === undefined)
		return yield* Effect.fail(serviceUnavailable("github_app_not_configured"));
	const now = Math.floor(Date.now() / 1_000);
	const key = yield* Effect.tryPromise({
		try: () =>
			importPKCS8(
				normalizeGithubPrivateKey(Redacted.value(github.privateKey)),
				"RS256",
			),
		catch: () => serviceUnavailable("github_app_key_invalid"),
	});
	return yield* Effect.promise(() =>
		new SignJWT({})
			.setProtectedHeader({ alg: "RS256" })
			// GitHub accepts either identifier, but recommends the client ID for
			// the JWT issuer. Keep App ID as a compatibility fallback.
			.setIssuer(forceAppId ? github.appId : (github.clientId ?? github.appId))
			.setIssuedAt(now - 60)
			.setExpirationTime(now + 9 * 60)
			.sign(key),
	);
});

const githubAppRequest = <A>(url: string, init?: RequestInit) =>
	Effect.gen(function* () {
		const github = (yield* ApiConfiguration).githubApp;
		const primaryJwt = yield* appJwt();
		const primary = githubRequest<A>(url, primaryJwt, init);
		if (github?.clientId === undefined) return yield* primary;
		return yield* primary.pipe(
			Effect.catch((error) =>
				error.detail !== "github_401"
					? Effect.fail(error)
					: Effect.gen(function* () {
							const fallbackJwt = yield* appJwt(true);
							return yield* githubRequest<A>(url, fallbackJwt, init);
						}),
			),
		);
	});

const readGithubInstallation = Effect.fn("readGithubInstallation")(function* (
	installationId: number,
) {
	const installation = yield* githubAppRequest<unknown>(
		`https://api.github.com/app/installations/${installationId}`,
		{ signal: AbortSignal.timeout(5_000) },
	).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(GithubInstallation)),
		Effect.mapError((error) =>
			error instanceof ApiError
				? error
				: serviceUnavailable("invalid_github_installation"),
		),
	);
	if (installation.id !== installationId)
		return yield* badRequest("github_installation_mismatch");
	return installation;
});

/** Read current GitHub state, not historical webhook payloads. Replays and
 * out-of-order events cannot re-enroll a disconnected workspace. */
export const refreshGithubInstallation = Effect.fn("refreshGithubInstallation")(
	function* (installationId: number) {
		const observedAtMs = yield* Clock.currentTimeMillis;
		const installation = yield* readGithubInstallation(installationId).pipe(
			Effect.catch((error) =>
				error.detail === "github_404"
					? Effect.succeed(null)
					: Effect.fail(error),
			),
		);
		yield* (yield* CloudWorkspaceStore).refreshGithubInstallation(
			installationId,
			installation === null
				? null
				: {
						githubAccountId: installation.account.id,
						accountLogin: installation.account.login,
						accountType: installation.account.type,
						avatarUrl: installation.account.avatar_url,
						repositorySelection: installation.repository_selection,
						suspended: installation.suspended_at !== null,
					},
			observedAtMs,
		);
	},
);

export const refreshGithubConnections = Effect.fn("refreshGithubConnections")(
	function* (accountId: string) {
		const store = yield* CloudWorkspaceStore;
		const nowMs = yield* Clock.currentTimeMillis;
		const connections = yield* store.listGithubInstallations(accountId);
		yield* Effect.forEach(
			connections.filter(
				(connection) => nowMs - connection.updatedAtMs >= 60_000,
			),
			(connection) => refreshGithubInstallation(connection.installationId),
			{ concurrency: 4 },
		);
		return yield* store.listGithubInstallations(accountId);
	},
);

export const githubWebhook = Effect.fn("githubWebhook")(function* (
	request: Request,
) {
	const github = (yield* ApiConfiguration).githubApp;
	if (
		!github?.webhookSecret ||
		Redacted.value(github.webhookSecret).length === 0
	)
		return yield* serviceUnavailable("github_webhook_not_configured");
	const secret = Redacted.value(github.webhookSecret);
	const signature = request.headers.get("x-hub-signature-256") ?? "";
	if (!/^sha256=[a-f0-9]{64}$/u.test(signature))
		return yield* unauthorized("invalid_github_signature");
	// Bound the body even when Content-Length is absent or dishonest.
	const body = yield* Effect.tryPromise({
		try: async () => {
			const reader = request.body?.getReader();
			if (!reader) throw badRequest("invalid_github_event");
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.length;
					if (size > 25 * 1024 * 1024) {
						await reader.cancel();
						throw new ApiError({ code: "github_event_too_large", status: 413 });
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			return bytes;
		},
		catch: (error) =>
			error instanceof ApiError ? error : badRequest("invalid_github_event"),
	});
	const valid = yield* Effect.promise(async () => {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		const digest = Uint8Array.from(
			signature.slice(7).match(/../gu) ?? [],
			(byte) => Number.parseInt(byte, 16),
		);
		return crypto.subtle.verify("HMAC", key, digest, body);
	});
	if (!valid) return yield* unauthorized("invalid_github_signature");
	const event = request.headers.get("x-github-event");
	if (event === "ping") return json({ accepted: true });
	if (event !== "installation" && event !== "installation_repositories")
		return json({ ignored: true });
	const payload = yield* Effect.try({
		try: (): unknown => JSON.parse(new TextDecoder().decode(body)),
		catch: () => badRequest("invalid_github_event"),
	}).pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(
				Schema.Struct({
					installation: Schema.Struct({
						id: Schema.Number,
						app_id: Schema.Number,
					}),
				}),
			),
		),
		Effect.mapError(() => badRequest("invalid_github_event")),
	);
	if (
		String(payload.installation.app_id) !== github.appId ||
		!Number.isSafeInteger(payload.installation.id) ||
		payload.installation.id <= 0
	)
		return yield* badRequest("invalid_github_installation");
	// No insert, tokens, or jobs: duplicate deliveries simply reconcile the same
	// existing links. Failed requests return non-2xx and are safe to redeliver.
	yield* refreshGithubInstallation(payload.installation.id);
	return json({ accepted: true });
});

const signGithubState = Effect.fn("signGithubState")(function* (
	accountId: string,
	actorId: string,
	nonce: string,
	installationId?: number,
	userAuthorization?: typeof GithubUserAuthorization.Type,
) {
	const config = yield* ApiConfiguration;
	const github = config.githubApp;
	if (github === undefined)
		return yield* Effect.fail(serviceUnavailable("github_app_not_configured"));
	const nowMs = yield* Clock.currentTimeMillis;
	const privateJwk = yield* parseJwk(Redacted.value(config.mintPrivateKey));
	const key = yield* Effect.tryPromise({
		try: () => importJWK(privateJwk, "EdDSA"),
		catch: () => serviceUnavailable("github_install_state_failed"),
	});
	const state = yield* Effect.promise(() =>
		new SignJWT({
			purpose: "github-install",
			actorId,
			installationId,
			userAuthorization,
		})
			.setProtectedHeader({ alg: "EdDSA", typ: "github-install+jwt" })
			.setIssuer(config.apiIssuer)
			.setAudience("github-app-install")
			.setSubject(accountId)
			.setJti(nonce)
			.setIssuedAt(Math.floor(nowMs / 1_000))
			.setExpirationTime(Math.floor((nowMs + INSTALL_STATE_TTL_MS) / 1_000))
			.sign(key),
	);
	return state;
});

export const makeGithubInstallUrl = Effect.fn("makeGithubInstallUrl")(
	function* (accountId: string, actorId = accountId) {
		const config = yield* ApiConfiguration;
		if (config.githubApp === undefined)
			return yield* serviceUnavailable("github_app_not_configured");
		const state = yield* signGithubState(
			accountId,
			actorId,
			crypto.randomUUID(),
		);
		return `https://github.com/apps/${encodeURIComponent(config.githubApp.slug)}/installations/new?state=${encodeURIComponent(state)}`;
	},
);

const verifyGithubState = Effect.fn("verifyGithubState")(function* (
	state: string,
) {
	const config = yield* ApiConfiguration;
	const publicJwk = yield* parseJwk(config.mintPublicKey);
	const key = yield* Effect.tryPromise({
		try: () => importJWK(publicJwk, "EdDSA"),
		catch: () => badRequest("invalid_github_install_state"),
	});
	const verified = yield* Effect.tryPromise({
		try: () =>
			jwtVerify(state, key, {
				issuer: config.apiIssuer,
				audience: "github-app-install",
				typ: "github-install+jwt",
			}),
		catch: () => badRequest("invalid_github_install_state"),
	});
	if (
		verified.payload.purpose !== "github-install" ||
		typeof verified.payload.sub !== "string" ||
		typeof verified.payload.actorId !== "string" ||
		typeof verified.payload.jti !== "string"
	)
		return yield* Effect.fail(badRequest("invalid_github_install_state"));
	const access = yield* resolveWorkspaceActorAccess(
		{ accountId: verified.payload.actorId, orgId: undefined },
		workspaceScopeForOwner(verified.payload.sub),
		"administration",
	);
	if (access.ownerId !== verified.payload.sub)
		return yield* badRequest("invalid_github_install_state");
	const userAuthorization =
		verified.payload.userAuthorization === undefined
			? undefined
			: yield* Schema.decodeUnknownEffect(GithubUserAuthorization)(
					verified.payload.userAuthorization,
				).pipe(
					Effect.mapError(() => badRequest("invalid_github_install_state")),
				);
	return {
		userAuthorization,
		accountId: verified.payload.sub,
		actorId: verified.payload.actorId,
		nonce: verified.payload.jti,
		installationId: verified.payload.installationId,
	};
});

export const completeGithubInstallation = Effect.fn(
	"completeGithubInstallation",
)(function* (state: string, installationId: number) {
	const verified = yield* verifyGithubState(state);
	// Only the OAuth-verified chooser can mint a state for a particular installation.
	if (
		verified.installationId !== installationId ||
		verified.userAuthorization === undefined
	)
		return yield* badRequest("invalid_github_install_state");
	const installation = yield* readGithubInstallation(installationId);
	const nowMs = yield* Clock.currentTimeMillis;
	const store = yield* CloudWorkspaceStore;
	const authorization = verified.userAuthorization;
	yield* store.withGithubUserLock(
		verified.accountId,
		Effect.gen(function* () {
			yield* store.saveGithubInstallation({
				accountId: verified.accountId,
				installationId,
				githubAccountId: installation.account.id,
				accountLogin: installation.account.login,
				accountType: installation.account.type,
				avatarUrl: installation.account.avatar_url,
				repositorySelection: installation.repository_selection,
				suspended: installation.suspended_at !== null,
				createdAtMs: nowMs,
				updatedAtMs: nowMs,
			});
			yield* store.saveGithubUser({
				accountId: verified.accountId,
				...authorization,
			});
		}),
	);
	return installation.account.login;
});

const GITHUB_STATE_COOKIE = "__Host-zuse-github";
const stateCookie = (nonce: string, maxAge = 600) =>
	`${GITHUB_STATE_COOKIE}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

export const githubAuthorizationUrl = (installUrl: string, issuer: string) => {
	const url = new URL(ApiPaths.cloudGithubCallback, issuer);
	url.searchParams.set(
		"state",
		new URL(installUrl).searchParams.get("state") ?? "",
	);
	url.searchParams.set("authorize", "1");
	return url.toString();
};

/** Installation setup does not always redirect on updates. OAuth always returns
 * here, and proves which existing installations the human can administer. */
export const githubAuthorizationCallback = Effect.fn(
	"githubAuthorizationCallback",
)(function* (request: Request) {
	const config = yield* ApiConfiguration;
	const stateHint = new URL(request.url).searchParams.get("state");
	const installationHint = Number(
		new URL(request.url).searchParams.get("installation_id"),
	);
	if (
		request.method === "GET" &&
		stateHint !== null &&
		Number.isSafeInteger(installationHint) &&
		installationHint > 0
	) {
		const forward = githubInstallCallbackForwardUrl(
			stateHint,
			installationHint,
			config.apiIssuer,
		);
		if (forward !== null)
			return new Response(null, {
				status: 302,
				headers: {
					location: forward,
					"cache-control": "no-store",
					"referrer-policy": "no-referrer",
				},
			});
	}
	const github = config.githubApp;
	if (github?.clientId === undefined || github.clientSecret === undefined)
		return yield* serviceUnavailable("github_app_oauth_not_configured");
	const url = new URL(request.url);
	if (url.searchParams.has("error"))
		return yield* badRequest("github_authorization_denied");
	const form =
		request.method === "POST"
			? yield* Effect.tryPromise({
					try: () => request.formData(),
					catch: () => badRequest("invalid_github_install_state"),
				})
			: null;
	const state = form?.get("csrf") ?? url.searchParams.get("state");
	if (typeof state !== "string")
		return yield* badRequest("invalid_github_install_state");
	const verified = yield* verifyGithubState(state);
	const callback = new URL(
		ApiPaths.cloudGithubCallback,
		config.publicApiOrigin ?? config.apiIssuer,
	).toString();
	const code = url.searchParams.get("code");
	if (request.method === "GET" && code === null) {
		const authorize = new URL("https://github.com/login/oauth/authorize");
		authorize.searchParams.set("client_id", github.clientId);
		authorize.searchParams.set("redirect_uri", callback);
		authorize.searchParams.set("state", state);
		return new Response(null, {
			status: 302,
			headers: {
				location: authorize.toString(),
				"set-cookie": stateCookie(verified.nonce),
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			},
		});
	}
	if (
		!(request.headers.get("cookie") ?? "")
			.split(";")
			.some(
				(value) => value.trim() === `${GITHUB_STATE_COOKIE}=${verified.nonce}`,
			)
	)
		return yield* badRequest("invalid_github_browser_state");
	if (request.method === "POST") {
		if (
			request.headers.get("origin") !== new URL(callback).origin ||
			typeof verified.installationId !== "number"
		)
			return yield* badRequest("invalid_github_install_state");
		const login = yield* completeGithubInstallation(
			state,
			verified.installationId,
		);
		return new Response(renderGithubConnectedPage(login), {
			headers: { ...BROWSER_PAGE_HEADERS, "set-cookie": stateCookie("", 0) },
		});
	}
	const credentials = yield* exchangeGithubUserToken({
		code: code ?? "",
		redirect_uri: callback,
	});
	const user = yield* prepareGithubUserAuthorization(
		verified.accountId,
		credentials,
	);
	const choices: Array<IntegrationPageInput["actions"][number]> = [];
	let hasInstallations = false;
	for (let page = 1; page <= 10; page++) {
		const result = yield* githubRequest<{
			installations: Array<{
				id: number;
				app_id: number;
				account: { id: number; login: string; type: string };
				suspended_at: string | null;
			}>;
		}>(
			`https://api.github.com/user/installations?per_page=100&page=${page}`,
			credentials.accessToken,
		);
		for (const installation of result.installations) {
			if (String(installation.app_id) === github.appId) hasInstallations = true;
			if (
				String(installation.app_id) !== github.appId ||
				installation.suspended_at !== null
			)
				continue;
			let canAdminister =
				installation.account.type === "User" &&
				installation.account.id === user.id;
			if (installation.account.type === "Organization") {
				const membership = yield* githubRequest<{
					role: string;
					state: string;
				}>(
					`https://api.github.com/user/memberships/orgs/${encodeURIComponent(installation.account.login)}`,
					credentials.accessToken,
				).pipe(
					Effect.catch((error) =>
						error.detail === "github_404" || error.detail === "github_403"
							? Effect.succeed(null)
							: Effect.fail(error),
					),
				);
				canAdminister =
					membership?.role === "admin" && membership.state === "active";
			}
			if (canAdminister)
				choices.push({
					label: "Use this account",
					accountName: installation.account.login,
					description:
						installation.account.type === "Organization"
							? "GitHub organization"
							: "Personal GitHub account",
					manageUrl: githubInstallationSettingsUrl(installation.id, {
						accountType: installation.account.type,
						accountLogin: installation.account.login,
					}),
					action: callback,
					csrf: yield* signGithubState(
						verified.accountId,
						verified.actorId,
						verified.nonce,
						installation.id,
						user.authorization,
					),
				});
		}
		if (result.installations.length < 100) break;
	}
	if (!hasInstallations)
		return new Response(null, {
			status: 302,
			headers: {
				location: yield* makeGithubInstallUrl(
					verified.accountId,
					verified.actorId,
				),
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
			},
		});
	const scope = workspaceScopeForOwner(verified.accountId);
	const workspaceName =
		scope.kind === "organization"
			? yield* getOrganizationName(scope.organizationId)
			: "Personal";
	return new Response(
		renderIntegrationPage({
			integration: "GitHub",
			title: "Choose a GitHub account",
			description: `For your ${workspaceName} workspace.`,
			status: "Connect",
			hint:
				choices.length === 0
					? "No installations you administer are available. Install the app, or ask your GitHub organization owner to connect it. Organization verification requires the app's Members read permission."
					: `Choose repositories on GitHub, then return to connect. ${scope.kind === "organization" ? "Selected repositories are shared with workspace members." : "Add them as projects in Zuse after connecting."}`,
			actions: [
				...choices,
				{
					label: "Add another GitHub account",
					href: yield* makeGithubInstallUrl(
						verified.accountId,
						verified.actorId,
					),
				},
			],
		}),
		{
			headers: {
				...BROWSER_PAGE_HEADERS,
				// no-referrer makes browser form POSTs send Origin: null, which
				// our CSRF check correctly rejects. Keep the origin, never the
				// callback path/query containing the OAuth code and signed state.
				"referrer-policy": "strict-origin",
				"content-security-policy": `${BROWSER_PAGE_HEADERS["content-security-policy"]}; form-action 'self'`,
			},
		},
	);
});

export interface GithubInstallationGrant {
	readonly installationId: number;
	readonly token: string;
	readonly expiresAt: string;
	readonly repositories: ReadonlyArray<{
		readonly fullName: string;
		readonly cloneUrl: string;
		readonly defaultBranch: string;
		readonly private: boolean;
		readonly description?: string;
		readonly ownerAvatarUrl?: string;
		readonly updatedAt: string;
	}>;
}

export const githubInstallationGrantForRepository = (
	grants: ReadonlyArray<GithubInstallationGrant>,
	repositoryIdentity: string,
): GithubInstallationGrant | null => {
	const repositoryName = repositoryIdentity
		.replace(/^github\.com\//u, "")
		.toLowerCase();
	return (
		grants.find((candidate) =>
			candidate.repositories.some(
				(repository) => repository.fullName.toLowerCase() === repositoryName,
			),
		) ?? null
	);
};

export const githubInstallationGrants = Effect.fn("githubInstallationGrants")(
	function* (accountId: string) {
		const store = yield* CloudWorkspaceStore;
		const installations = (yield* store.listGithubInstallations(
			accountId,
		)).filter((installation) => !installation.suspended);
		const grants = yield* Effect.forEach(
			installations,
			(installation) =>
				Effect.gen(function* () {
					const access = yield* githubAppRequest<{
						readonly token: string;
						readonly expires_at: string;
					}>(
						`https://api.github.com/app/installations/${installation.installationId}/access_tokens`,
						{ method: "POST" },
					).pipe(
						// Uninstalled connections can remain until the user reconnects.
						// They must not prevent other installations from granting access.
						Effect.catch((error) =>
							error.detail === "github_404"
								? Effect.succeed(null)
								: Effect.fail(error),
						),
					);
					if (access === null) return null;
					const repositories: Array<
						GithubInstallationGrant["repositories"][number]
					> = [];
					for (let page = 1; page <= 10; page += 1) {
						const result = yield* githubRequest<{
							readonly repositories: ReadonlyArray<{
								readonly full_name: string;
								readonly clone_url: string;
								readonly default_branch: string;
								readonly private: boolean;
								readonly description: string | null;
								readonly owner: { readonly avatar_url?: string };
								readonly updated_at: string;
							}>;
						}>(
							`https://api.github.com/installation/repositories?per_page=100&page=${page}`,
							access.token,
						);
						repositories.push(
							...result.repositories.map((repository) => ({
								fullName: repository.full_name,
								cloneUrl: repository.clone_url,
								defaultBranch: repository.default_branch,
								private: repository.private,
								description: repository.description ?? undefined,
								ownerAvatarUrl: repository.owner.avatar_url,
								updatedAt: repository.updated_at,
							})),
						);
						if (result.repositories.length < 100) break;
					}
					return {
						installationId: installation.installationId,
						token: access.token,
						expiresAt: access.expires_at,
						repositories,
					} satisfies GithubInstallationGrant;
				}),
			{ concurrency: 4 },
		);
		return grants.filter((grant) => grant !== null);
	},
);

export const githubInstallationCredentialForRepository = Effect.fn(
	"githubInstallationCredentialForRepository",
)(function* (accountId: string, repositoryIdentity: string) {
	const grants = yield* githubInstallationGrants(accountId);
	const grant = githubInstallationGrantForRepository(
		grants,
		repositoryIdentity,
	);
	if (grant === null) return null;
	const expiresAtMs = Date.parse(grant.expiresAt);
	if (!Number.isFinite(expiresAtMs))
		return yield* Effect.fail(
			serviceUnavailable("github_token_expiry_invalid"),
		);
	return { token: grant.token, expiresAtMs } as const;
});
