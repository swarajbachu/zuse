import { ApiPaths, PRODUCTION_API_URL, STAGING_API_URL } from "@zuse/contracts";
import { Clock, Effect, Redacted } from "effect";
import { decodeJwt, importJWK, importPKCS8, jwtVerify, SignJWT } from "jose";

import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { parseJwk } from "./crypto.ts";
import { badRequest, serviceUnavailable } from "./errors.ts";

const GITHUB_API_VERSION = "2026-03-10";
const INSTALL_STATE_TTL_MS = 10 * 60_000;
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

const githubRequest = <A>(url: string, token: string, init?: RequestInit) =>
	Effect.tryPromise({
		try: async () => {
			const response = await fetch(url, {
				...init,
				headers: {
					accept: "application/vnd.github+json",
					authorization: `Bearer ${token}`,
					"user-agent": "Zuse-GitHub-App/1.0",
					"x-github-api-version": GITHUB_API_VERSION,
					...init?.headers,
				},
			});
			if (!response.ok) {
				console.warn("[cloud-github] GitHub API request rejected", {
					endpoint: new URL(url).pathname,
					status: response.status,
				});
				throw new Error(`github_${response.status}`);
			}
			return (await response.json()) as A;
		},
		catch: () => serviceUnavailable("github_app_unavailable"),
	});

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
			Effect.catch(() =>
				Effect.gen(function* () {
					const fallbackJwt = yield* appJwt(true);
					return yield* githubRequest<A>(url, fallbackJwt, init);
				}),
			),
		);
	});

export const makeGithubInstallUrl = Effect.fn("makeGithubInstallUrl")(
	function* (accountId: string) {
		const config = yield* ApiConfiguration;
		const github = config.githubApp;
		if (github === undefined)
			return yield* Effect.fail(
				serviceUnavailable("github_app_not_configured"),
			);
		const nowMs = yield* Clock.currentTimeMillis;
		const privateJwk = yield* parseJwk(Redacted.value(config.mintPrivateKey));
		const key = yield* Effect.tryPromise({
			try: () => importJWK(privateJwk, "EdDSA"),
			catch: () => serviceUnavailable("github_install_state_failed"),
		});
		const state = yield* Effect.promise(() =>
			new SignJWT({ purpose: "github-install" })
				.setProtectedHeader({ alg: "EdDSA", typ: "github-install+jwt" })
				.setIssuer(config.apiIssuer)
				.setAudience("github-app-install")
				.setSubject(accountId)
				.setIssuedAt(Math.floor(nowMs / 1_000))
				.setExpirationTime(Math.floor((nowMs + INSTALL_STATE_TTL_MS) / 1_000))
				.sign(key),
		);
		return `https://github.com/apps/${encodeURIComponent(github.slug)}/installations/new?state=${encodeURIComponent(state)}`;
	},
);

export const completeGithubInstallation = Effect.fn(
	"completeGithubInstallation",
)(function* (state: string, installationId: number) {
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
		typeof verified.payload.sub !== "string"
	)
		return yield* Effect.fail(badRequest("invalid_github_install_state"));
	const installation = yield* githubAppRequest<{
		readonly id: number;
		readonly account: {
			readonly id: number;
			readonly login: string;
			readonly type: "User" | "Organization";
			readonly avatar_url?: string;
		};
		readonly repository_selection: "all" | "selected";
		readonly suspended_at: string | null;
	}>(`https://api.github.com/app/installations/${installationId}`);
	if (installation.id !== installationId)
		return yield* Effect.fail(badRequest("github_installation_mismatch"));
	const nowMs = yield* Clock.currentTimeMillis;
	yield* (yield* CloudWorkspaceStore).saveGithubInstallation({
		accountId: verified.payload.sub,
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
	return installation.account.login;
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

export const githubInstallationGrants = Effect.fn("githubInstallationGrants")(
	function* (accountId: string) {
		const store = yield* CloudWorkspaceStore;
		const installations = (yield* store.listGithubInstallations(
			accountId,
		)).filter((installation) => !installation.suspended);
		return yield* Effect.forEach(
			installations,
			(installation) =>
				Effect.gen(function* () {
					const access = yield* githubAppRequest<{
						readonly token: string;
						readonly expires_at: string;
					}>(
						`https://api.github.com/app/installations/${installation.installationId}/access_tokens`,
						{ method: "POST" },
					);
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
	},
);
