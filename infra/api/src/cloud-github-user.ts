import { Clock, Effect, Redacted, Schema } from "effect";
import { openApiString, sealApiString } from "./api-sealing.ts";
import { githubApiHeaders, githubRequest } from "./cloud-github-request.ts";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { badRequest, serviceUnavailable } from "./errors.ts";

const Credentials = Schema.Struct({
	accessToken: Schema.String,
	expiresAtMs: Schema.Number,
	refreshToken: Schema.optional(Schema.String),
	refreshExpiresAtMs: Schema.optional(Schema.Number),
});
const TokenResponse = Schema.Struct({
	access_token: Schema.NonEmptyString,
	expires_in: Schema.optional(Schema.Number),
	refresh_token: Schema.optional(Schema.NonEmptyString),
	refresh_token_expires_in: Schema.optional(Schema.Number),
});
const GithubUser = Schema.Struct({
	id: Schema.Number,
	login: Schema.NonEmptyString,
	name: Schema.NullOr(Schema.String),
});
const context = (accountId: string) => `github-user\n${accountId}`;

const oauthConfig = Effect.gen(function* () {
	const config = yield* ApiConfiguration;
	const github = config.githubApp;
	if (github?.clientId === undefined || github.clientSecret === undefined)
		return yield* Effect.fail(
			serviceUnavailable("github_user_auth_not_configured"),
		);
	return {
		clientId: github.clientId,
		clientSecret: Redacted.value(github.clientSecret),
	};
});

export const exchangeGithubUserToken = Effect.fn("exchangeGithubUserToken")(
	function* (parameters: Record<string, string>) {
		const config = yield* oauthConfig;
		const nowMs = yield* Clock.currentTimeMillis;
		const response = yield* Effect.tryPromise({
			try: async () => {
				const result = await fetch(
					"https://github.com/login/oauth/access_token",
					{
						method: "POST",
						headers: {
							accept: "application/json",
							"content-type": "application/json",
						},
						body: JSON.stringify({
							client_id: config.clientId,
							client_secret: config.clientSecret,
							...parameters,
						}),
						signal: AbortSignal.timeout(15_000),
					},
				);
				if (!result.ok) throw new Error("oauth_failed");
				return Schema.decodeUnknownSync(TokenResponse)(await result.json());
			},
			catch: () => serviceUnavailable("github_user_reconnect_required"),
		});
		if (
			response.expires_in !== undefined &&
			(!Number.isFinite(response.expires_in) || response.expires_in <= 0)
		)
			return yield* Effect.fail(
				serviceUnavailable("github_token_expiry_invalid"),
			);
		if (
			response.refresh_token !== undefined &&
			(response.refresh_token_expires_in === undefined ||
				!Number.isFinite(response.refresh_token_expires_in) ||
				response.refresh_token_expires_in <= 0)
		)
			return yield* Effect.fail(
				serviceUnavailable("github_token_expiry_invalid"),
			);
		return {
			accessToken: response.access_token,
			// Non-expiring tokens are rechecked by the broker once an hour.
			expiresAtMs:
				response.expires_in === undefined
					? Number.MAX_SAFE_INTEGER
					: nowMs + response.expires_in * 1_000,
			refreshToken: response.refresh_token,
			refreshExpiresAtMs:
				response.refresh_token_expires_in === undefined
					? undefined
					: nowMs + response.refresh_token_expires_in * 1_000,
		};
	},
);

export const GithubUserAuthorization = Schema.Struct({
	login: Schema.NonEmptyString,
	name: Schema.NonEmptyString,
	email: Schema.NonEmptyString,
	sealedCredentials: Schema.NonEmptyString,
});

/** Prepare encrypted credentials for the signed chooser; persist only after selection. */
export const prepareGithubUserAuthorization = Effect.fn(
	"prepareGithubUserAuthorization",
)(function* (accountId: string, credentials: typeof Credentials.Type) {
	const raw = yield* githubRequest<unknown>(
		"https://api.github.com/user",
		credentials.accessToken,
	);
	const user = yield* Schema.decodeUnknownEffect(GithubUser)(raw).pipe(
		Effect.mapError(() => badRequest("github_user_identity_invalid")),
	);
	if (
		!Number.isSafeInteger(user.id) ||
		user.id <= 0 ||
		!/^[a-zA-Z0-9-]+$/u.test(user.login)
	)
		return yield* Effect.fail(badRequest("github_user_identity_invalid"));
	const displayName = user.name?.trim() || user.login;
	// Git author identities cannot contain controls or angle brackets. A
	// GitHub profile may, so use the verified login for those profiles.
	const name =
		[...displayName].some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
		) || /[<>]/u.test(displayName)
			? user.login
			: displayName;
	const sealedCredentials = yield* sealApiString(
		context(accountId),
		JSON.stringify(credentials),
	);
	return {
		id: user.id,
		authorization: {
			login: user.login,
			name,
			email: `${user.id}+${user.login}@users.noreply.github.com`,
			sealedCredentials,
		},
	};
});

export const githubUserIdentity = Effect.fn("githubUserIdentity")(function* (
	accountId: string,
) {
	const user = yield* (yield* CloudWorkspaceStore).getGithubUser(accountId);
	return user === null
		? undefined
		: { login: user.login, name: user.name, email: user.email };
});

/** Caller holds the account lock while reading or rotating credentials. */
const readGithubUserCredentials = Effect.fn("readGithubUserCredentials")(
	function* (accountId: string) {
		const user = yield* (yield* CloudWorkspaceStore).getGithubUser(accountId);
		if (user === null) return null;
		const plaintext = yield* openApiString(
			context(accountId),
			user.sealedCredentials,
		);
		const credentials = yield* Effect.try({
			try: () => Schema.decodeUnknownSync(Credentials)(JSON.parse(plaintext)),
			catch: () => serviceUnavailable("github_user_reconnect_required"),
		});
		return { user, credentials };
	},
);
const refreshGithubUserCredentials = Effect.fn("refreshGithubUserCredentials")(
	function* (
		connection: NonNullable<
			Effect.Success<ReturnType<typeof readGithubUserCredentials>>
		>,
	) {
		const { user, credentials } = connection;
		const nowMs = yield* Clock.currentTimeMillis;
		if (
			credentials.refreshToken === undefined ||
			(credentials.refreshExpiresAtMs ?? 0) <= nowMs
		)
			return yield* Effect.fail(
				serviceUnavailable("github_user_reconnect_required"),
			);
		const refreshed = yield* exchangeGithubUserToken({
			grant_type: "refresh_token",
			refresh_token: credentials.refreshToken,
		});
		yield* (yield* CloudWorkspaceStore).saveGithubUser({
			...user,
			sealedCredentials: yield* sealApiString(
				context(user.accountId),
				JSON.stringify(refreshed),
			),
		});
		return refreshed;
	},
);

/** A connected user never falls back to installation permissions after auth failure. */
/** Control-plane GitHub identity/access checks reuse serialized native GitHub refresh. Never returns the parent token. */
export const githubUserApiRequest = Effect.fn("githubUserApiRequest")(
	function* (accountId: string, path: string) {
		if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
			return yield* badRequest("invalid_github_path");
		const store = yield* CloudWorkspaceStore;
		const token = yield* store.withGithubUserLock(
			accountId,
			Effect.gen(function* () {
				const connection = yield* readGithubUserCredentials(accountId);
				if (!connection)
					return yield* serviceUnavailable("github_user_reconnect_required");
				const credentials =
					connection.credentials.expiresAtMs <=
					(yield* Clock.currentTimeMillis) + 300_000
						? yield* refreshGithubUserCredentials(connection)
						: connection.credentials;
				return credentials.accessToken;
			}),
		);
		return yield* githubRequest<unknown>(
			`https://api.github.com${path}`,
			token,
		);
	},
);

export const githubUserCredential = Effect.fn("githubUserCredential")(
	function* (
		accountId: string,
		repositoryIdentity: string,
		installationOwnerId = accountId,
	) {
		const store = yield* CloudWorkspaceStore;
		// Commit rotated tokens before doing repository I/O: a later API error must not
		// roll back a successfully consumed refresh token.
		const credential = yield* store.withGithubUserLock(
			accountId,
			Effect.gen(function* () {
				const connection = yield* readGithubUserCredentials(accountId);
				if (connection === null) return null;
				const { user } = connection;
				const nowMs = yield* Clock.currentTimeMillis;
				const credentials =
					connection.credentials.expiresAtMs <= nowMs + 300_000
						? yield* refreshGithubUserCredentials(connection)
						: connection.credentials;
				return {
					token: credentials.accessToken,
					expiresAtMs: Math.min(credentials.expiresAtMs, nowMs + 3_600_000),
					identity: { name: user.name, email: user.email },
				};
			}),
		);
		if (credential === null) return null;
		const repository = repositoryIdentity.replace(/^github\.com\//u, "");
		if (!/^[\w.-]+\/[\w.-]+$/u.test(repository))
			return yield* Effect.fail(badRequest("invalid_github_repository"));
		const [owner, name] = repository.split("/");
		const installations =
			yield* store.listGithubInstallations(installationOwnerId);
		if (
			!installations.some(
				(installation) =>
					!installation.suspended &&
					installation.accountLogin.toLowerCase() === owner?.toLowerCase(),
			)
		)
			return yield* Effect.fail(
				serviceUnavailable("github_user_repository_access_required"),
			);
		const config = yield* oauthConfig;
		// GitHub enforces repository scope on the issued token. Never return the
		// account's parent token to a sandbox, including on scoping failures.
		const scoped = yield* Effect.tryPromise({
			try: async () => {
				const response = await fetch(
					`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token/scoped`,
					{
						method: "POST",
						signal: AbortSignal.timeout(15_000),
						headers: {
							...githubApiHeaders,
							"content-type": "application/json",
							authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
						},
						body: JSON.stringify({
							access_token: credential.token,
							target: owner,
							repositories: [name],
						}),
					},
				);
				if (!response.ok) throw new Error("scope_failed");
				return Schema.decodeUnknownSync(
					Schema.Struct({
						token: Schema.NonEmptyString,
						expires_at: Schema.NullOr(Schema.String),
					}),
				)(await response.json());
			},
			catch: () => serviceUnavailable("github_user_repository_access_required"),
		});
		if (scoped.token === credential.token)
			return yield* Effect.fail(
				serviceUnavailable("github_user_repository_access_required"),
			);
		const expiresAtMs =
			scoped.expires_at === null
				? credential.expiresAtMs
				: Math.min(Date.parse(scoped.expires_at), credential.expiresAtMs);
		if (
			!Number.isFinite(expiresAtMs) ||
			expiresAtMs <= (yield* Clock.currentTimeMillis)
		)
			return yield* Effect.fail(
				serviceUnavailable("github_token_expiry_invalid"),
			);
		return { ...credential, token: scoped.token, expiresAtMs };
	},
);

const disconnectGithubUserLocked = Effect.fn("disconnectGithubUserLocked")(
	function* (accountId: string) {
		const store = yield* CloudWorkspaceStore;
		const connection = yield* readGithubUserCredentials(accountId);
		if (connection === null) return;
		let { credentials } = connection;
		const nowMs = yield* Clock.currentTimeMillis;
		if (
			credentials.expiresAtMs <= nowMs &&
			credentials.refreshToken !== undefined &&
			(credentials.refreshExpiresAtMs ?? 0) > nowMs
		)
			credentials = yield* refreshGithubUserCredentials(connection);
		// An exhausted authorization has no usable credential to revoke remotely.
		if (credentials.expiresAtMs > nowMs) {
			const config = yield* oauthConfig;
			yield* Effect.tryPromise({
				try: async () => {
					const response = await fetch(
						`https://api.github.com/applications/${encodeURIComponent(config.clientId)}/grant`,
						{
							method: "DELETE",
							signal: AbortSignal.timeout(15_000),
							headers: {
								...githubApiHeaders,
								"content-type": "application/json",
								authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
							},
							body: JSON.stringify({ access_token: credentials.accessToken }),
						},
					);
					if (response.status !== 204 && response.status !== 404)
						throw new Error("revoke_failed");
				},
				catch: () => serviceUnavailable("github_user_disconnect_failed"),
			});
		}
		yield* store.removeGithubUser(accountId);
	},
);

/** Commit rotated credentials even if the subsequent remote revocation fails. */
const withGithubDisconnectLock = Effect.fn("withGithubDisconnectLock")(
	function* (accountId: string, installationId?: number) {
		const store = yield* CloudWorkspaceStore;
		const result = yield* store.withGithubUserLock(
			accountId,
			Effect.gen(function* () {
				if (installationId !== undefined) {
					const remaining = (yield* store.listGithubInstallations(
						accountId,
					)).filter(
						(installation) => installation.installationId !== installationId,
					);
					if (remaining.length === 0)
						yield* disconnectGithubUserLocked(accountId);
					yield* store.removeGithubInstallation(accountId, installationId);
				} else yield* disconnectGithubUserLocked(accountId);
			}).pipe(Effect.result),
		);
		if (result._tag === "Failure") return yield* Effect.fail(result.failure);
	},
);
export const disconnectGithubUser = (accountId: string) =>
	withGithubDisconnectLock(accountId);
export const disconnectGithubInstallation = (
	accountId: string,
	installationId: number,
) => withGithubDisconnectLock(accountId, installationId);
