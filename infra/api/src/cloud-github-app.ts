import {
	invalidateGithubJoining,
	reconcileGithubMemberships,
	refreshGithubRosters,
} from "./github-membership.ts";
import { autoJoinInstallation } from "./github-organizations.ts";
import {
	githubAppRequest,
	githubRequest,
	readGithubInstallation,
} from "./github-transport.ts";

export { normalizeGithubPrivateKey } from "./github-transport.ts";

import { ApiPaths, PRODUCTION_API_URL, STAGING_API_URL } from "@zuse/contracts";
import { githubInstallationSettingsUrl } from "@zuse/utils/github-installation";
import {
	type IntegrationPageInput,
	renderIntegrationPage,
} from "@zuse/utils/integration-page";
import { Clock, Effect, Redacted, Schema } from "effect";

import { decodeJwt, importJWK, jwtVerify, SignJWT } from "jose";
import {
	exchangeGithubUserToken,
	GithubUserAuthorization,
	githubAuthorizationCredentials,
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
import {
	githubApprovalPageHeaders,
	githubCallbackPageHeaders,
	githubChooserPageHeaders,
	renderGithubConnectedPage,
	renderGithubSetupPage,
} from "./github-callback-page.ts";
import {
	githubLinkAccess,
	githubLinkAllowsRepository,
} from "./github-link-access.ts";
import { json } from "./http.ts";
import { getOrganizationName } from "./organizations.ts";
import { ApiStore } from "./store.ts";
import { resolveWorkspaceActorAccess } from "./workspace-authorization.ts";
import { workspaceScopeForOwner } from "./workspace-scope.ts";

const INSTALL_STATE_TTL_MS = 10 * 60_000;
const APPROVAL_STATE_TTL_MS = 24 * 60 * 60_000;
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
	if (
		event !== "installation" &&
		event !== "installation_repositories" &&
		event !== "organization"
	)
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
						app_id: Schema.optional(Schema.Number),
					}),
				}),
			),
		),
		Effect.mapError(() => badRequest("invalid_github_event")),
	);
	if (
		(event !== "organization" && payload.installation.app_id === undefined) ||
		(payload.installation.app_id !== undefined &&
			String(payload.installation.app_id) !== github.appId) ||
		!Number.isSafeInteger(payload.installation.id) ||
		payload.installation.id <= 0
	)
		return yield* badRequest("invalid_github_installation");
	// No insert, tokens, or jobs: duplicate deliveries simply reconcile the same
	// existing links. Failed requests return non-2xx and are safe to redeliver.
	yield* invalidateGithubJoining(payload.installation.id);
	yield* refreshGithubInstallation(payload.installation.id);
	yield* reconcileGithubMemberships(payload.installation.id);
	yield* refreshGithubRosters(payload.installation.id);
	// Linked members newly added on GitHub join organizations with auto-join on.
	yield* autoJoinInstallation(payload.installation.id).pipe(
		Effect.catch(() => Effect.void),
	);
	return json({ accepted: true });
});

const signGithubState = Effect.fn("signGithubState")(function* (
	accountId: string,
	actorId: string,
	nonce: string,
	installationId?: number,
	userAuthorization?: typeof GithubUserAuthorization.Type,
	ttlMs = INSTALL_STATE_TTL_MS,
	approvalBaseline?: readonly number[],
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
			approvalBaseline,
		})
			.setProtectedHeader({ alg: "EdDSA", typ: "github-install+jwt" })
			.setIssuer(config.apiIssuer)
			.setAudience("github-app-install")
			.setSubject(accountId)
			.setJti(nonce)
			.setIssuedAt(Math.floor(nowMs / 1_000))
			.setExpirationTime(Math.floor((nowMs + ttlMs) / 1_000))
			.sign(key),
	);
	return state;
});

export const makeGithubInstallUrl = Effect.fn("makeGithubInstallUrl")(
	function* (
		accountId: string,
		actorId = accountId,
		nonce = crypto.randomUUID(),
		userAuthorization?: typeof GithubUserAuthorization.Type,
		approvalBaseline?: readonly number[],
	) {
		const config = yield* ApiConfiguration;
		if (config.githubApp === undefined)
			return yield* serviceUnavailable("github_app_not_configured");
		const state = yield* signGithubState(
			accountId,
			actorId,
			nonce,
			undefined,
			userAuthorization,
			userAuthorization === undefined
				? INSTALL_STATE_TTL_MS
				: APPROVAL_STATE_TTL_MS,
			approvalBaseline,
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
		"content",
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
		approvalBaseline:
			verified.payload.approvalBaseline === undefined
				? undefined
				: yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Number))(
						verified.payload.approvalBaseline,
					).pipe(
						Effect.mapError(() => badRequest("invalid_github_install_state")),
					),
		accountId: verified.payload.sub,
		actorId: verified.payload.actorId,
		canManageInstallation:
			access.membership === null || access.membership.role.slug === "admin",
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
	const existing = (yield* store.listGithubInstallations(
		verified.accountId,
	)).find((item) => item.installationId === installationId && !item.suspended);
	let allowedRepositories = existing?.allowedRepositories;
	if (!verified.canManageInstallation) {
		if (!existing)
			return yield* badRequest("github_organization_installation_required");
	} else {
		const credentials = yield* githubAuthorizationCredentials(
			verified.actorId,
			authorization,
		);
		const profile = yield* githubRequest<{ id: number; login: string }>(
			"https://api.github.com/user",
			credentials.accessToken,
		);
		if (
			profile.login !== authorization.login ||
			!authorization.email.startsWith(`${profile.id}+`)
		)
			return yield* badRequest("github_user_identity_invalid");
		const access = yield* githubLinkAccess(
			installation,
			profile.id,
			credentials.accessToken,
		);
		if (
			installation.suspended_at !== null ||
			(!existing && access.kind !== "owner" && access.kind !== "member")
		)
			return yield* badRequest("github_organization_installation_required");
		if (access.kind === "owner") allowedRepositories = undefined;
		else if (!existing && access.kind === "member")
			allowedRepositories = access.repositories;
	}

	yield* store.withGithubUserLock(
		verified.actorId,
		Effect.gen(function* () {
			if (verified.canManageInstallation)
				yield* store.saveGithubInstallation({
					accountId: verified.accountId,
					installationId,
					githubAccountId: installation.account.id,
					accountLogin: installation.account.login,
					accountType: installation.account.type,
					avatarUrl: installation.account.avatar_url,
					repositorySelection: installation.repository_selection,
					allowedRepositories,
					suspended: installation.suspended_at !== null,
					createdAtMs: nowMs,
					updatedAtMs: nowMs,
				});
			yield* store.saveGithubUser({
				accountId: verified.actorId,
				...authorization,
			});
		}),
	);
	return installation.account.login;
});

const GITHUB_STATE_COOKIE = "__Host-zuse-github";
/** Whether a GitHub user was previously linked by this Zuse account. */
const isActorGithubUser = Effect.fn("isActorGithubUser")(function* (
	actorId: string,
	githubUserId: number,
) {
	const stored = yield* (yield* CloudWorkspaceStore).getGithubUser(actorId);
	// Stored commit emails are `${githubUserId}+${login}@users.noreply.github.com`.
	if (stored && Number(stored.email.split("+")[0]) === githubUserId)
		return true;
	const identity = yield* (yield* ApiStore).githubJoining.getIdentity(actorId);
	return identity?.githubUserId === githubUserId;
});

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
	const url = new URL(request.url);
	const stateHint = url.searchParams.get("state");
	// GitHub-side requests and approvals may reach Setup URL without a Zuse
	// connection link. They cannot select a workspace or authorize its actor.
	if (
		request.method === "GET" &&
		stateHint === null &&
		!url.searchParams.has("code") &&
		!url.searchParams.has("error")
	)
		return new Response(
			renderGithubSetupPage(url.searchParams.get("setup_action") === "request"),
			{ headers: githubCallbackPageHeaders },
		);
	const installationHint = Number(url.searchParams.get("installation_id"));
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
	if (
		request.method === "GET" &&
		url.searchParams.get("setup_action") === "request" &&
		!url.searchParams.has("code")
	) {
		const resume = new URL(
			ApiPaths.cloudGithubCallback,
			config.publicApiOrigin ?? config.apiIssuer,
		);
		resume.searchParams.set(
			"state",
			yield* signGithubState(
				verified.accountId,
				verified.actorId,
				verified.nonce,
				undefined,
				undefined,
				APPROVAL_STATE_TTL_MS,
			),
		);
		const browserMatches = (request.headers.get("cookie") ?? "")
			.split(";")
			.some(
				(value) => value.trim() === `${GITHUB_STATE_COOKIE}=${verified.nonce}`,
			);
		const approvalCheck =
			browserMatches && verified.userAuthorization !== undefined
				? { callback: resume.origin + resume.pathname, state }
				: undefined;
		return new Response(
			renderGithubSetupPage(true, resume.toString(), approvalCheck),
			{
				headers:
					approvalCheck === undefined
						? githubCallbackPageHeaders
						: {
								...githubApprovalPageHeaders,
								"set-cookie": stateCookie(
									verified.nonce,
									APPROVAL_STATE_TTL_MS / 1000,
								),
							},
			},
		);
	}
	const callback = new URL(
		ApiPaths.cloudGithubCallback,
		config.publicApiOrigin ?? config.apiIssuer,
	).toString();
	const code = url.searchParams.get("code");
	if (request.method === "GET" && code === null) {
		// Returning from installing an account carries its installation id.
		// Keep it through OAuth so that account links without another choice.
		const pending =
			typeof verified.installationId !== "number" &&
			Number.isSafeInteger(installationHint) &&
			installationHint > 0
				? installationHint
				: undefined;
		const authorize = new URL("https://github.com/login/oauth/authorize");
		authorize.searchParams.set("client_id", github.clientId);
		authorize.searchParams.set("redirect_uri", callback);
		authorize.searchParams.set(
			"state",
			pending === undefined
				? state
				: yield* signGithubState(
						verified.accountId,
						verified.actorId,
						verified.nonce,
						pending,
					),
		);
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
	const checkingApproval =
		request.method === "POST" && form?.get("action") === "check-approval";
	if (
		checkingApproval &&
		(request.headers.get("origin") !== new URL(callback).origin ||
			verified.userAuthorization === undefined ||
			!verified.canManageInstallation)
	)
		return yield* badRequest("invalid_github_install_state");
	if (request.method === "POST" && !checkingApproval) {
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
			headers: {
				...githubCallbackPageHeaders,
				"set-cookie": stateCookie("", 0),
			},
		});
	}
	const credentials =
		checkingApproval && verified.userAuthorization !== undefined
			? yield* githubAuthorizationCredentials(
					verified.actorId,
					verified.userAuthorization,
				).pipe(
					Effect.catch((error) =>
						error.code === "github_user_reconnect_required"
							? Effect.succeed(null)
							: Effect.fail(error),
					),
				)
			: yield* exchangeGithubUserToken({
					code: code ?? "",
					redirect_uri: callback,
				});
	if (credentials === null) return json({ ready: false, reauthorize: true });
	const user = yield* prepareGithubUserAuthorization(
		verified.actorId,
		credentials,
	);
	const choices: Array<IntegrationPageInput["actions"][number]> = [];
	let hasInstallations = false;
	let needsApproval = false;
	const linkable = new Set<number>();
	let organizationReady = false;
	const readyOrganizations = new Set<number>();
	const linkedInstallations =
		yield* (yield* CloudWorkspaceStore).listGithubInstallations(
			verified.accountId,
		);
	for (let page = 1; page <= 10; page++) {
		const result = yield* githubRequest<{
			installations: Array<{
				id: number;
				app_id: number;
				account: {
					id: number;
					login: string;
					type: string;
					avatar_url?: string;
				};
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
			const alreadyLinked = linkedInstallations.some(
				(item) => item.installationId === installation.id && !item.suspended,
			);
			const linkAccess = verified.canManageInstallation
				? yield* githubLinkAccess(
						installation,
						user.id,
						credentials.accessToken,
					)
				: { kind: "denied" as const };
			if (linkAccess.kind === "approval-required" && !alreadyLinked) {
				needsApproval = true;
				const resume = new URL(callback);
				resume.searchParams.set(
					"state",
					yield* signGithubState(
						verified.accountId,
						verified.actorId,
						verified.nonce,
						installation.id,
					),
				);
				choices.push({
					label: "Request approval",
					accountName: installation.account.login,
					avatarUrl: installation.account.avatar_url,
					description: "Organization · Needs approval",
					href: githubInstallationSettingsUrl(installation.id, {
						accountType: installation.account.type,
						accountLogin: installation.account.login,
					}),
					resumeHref: resume.toString(),
				});
			}
			if (
				alreadyLinked ||
				linkAccess.kind === "owner" ||
				linkAccess.kind === "member"
			)
				linkable.add(installation.id);
			if (linkable.has(installation.id)) {
				if (installation.account.type === "Organization") {
					readyOrganizations.add(installation.id);
					if (!verified.approvalBaseline?.includes(installation.id))
						organizationReady = true;
				}
				choices.push({
					label: "Use this account",
					accountName: installation.account.login,
					avatarUrl: installation.account.avatar_url,
					description:
						installation.account.type === "Organization"
							? linkAccess.kind === "member"
								? "Organization · Your writable repositories"
								: "Organization"
							: "Personal account",
					manageUrl:
						verified.canManageInstallation && linkAccess.kind === "owner"
							? githubInstallationSettingsUrl(installation.id, {
									accountType: installation.account.type,
									accountLogin: installation.account.login,
								})
							: undefined,
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
		}
		if (result.installations.length < 100) break;
	}
	if (checkingApproval) return json({ ready: organizationReady });
	// The person already chose this account (installed it, or approved it and
	// came back): link it now instead of asking them to choose it again.
	const chosen =
		typeof verified.installationId === "number"
			? verified.installationId
			: undefined;
	// The browser carries no Zuse session, so the chooser naming the workspace
	// is the confirmation. Skip it only when this GitHub account is already
	// known to be the actor's: a link minted for someone else's workspace then
	// still stops at the chooser instead of attaching this account to it.
	if (
		chosen !== undefined &&
		linkable.has(chosen) &&
		(yield* isActorGithubUser(verified.actorId, user.id))
	) {
		const login = yield* completeGithubInstallation(
			yield* signGithubState(
				verified.accountId,
				verified.actorId,
				verified.nonce,
				chosen,
				user.authorization,
			),
			chosen,
		);
		return new Response(renderGithubConnectedPage(login), {
			headers: {
				...githubCallbackPageHeaders,
				"set-cookie": stateCookie("", 0),
			},
		});
	}
	if (!hasInstallations && verified.canManageInstallation)
		return new Response(null, {
			status: 302,
			headers: {
				location: yield* makeGithubInstallUrl(
					verified.accountId,
					verified.actorId,
					verified.nonce,
					user.authorization,
					[],
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
			hint: needsApproval
				? "Ask your GitHub organization owner to approve Members read access for the app. They do not need Zuse. After approval, choose Check approval to refresh your available accounts."
				: !verified.canManageInstallation
					? "Connect your own GitHub identity to repositories already linked to this workspace. If none appear, ask an organization administrator to link the GitHub installation and confirm your repository access."
					: choices.length === 0
						? "Request installation from your GitHub organization owner, then choose Check approval. Your owner only needs GitHub. Existing installations can be connected when you have active membership and writable repository access."
						: `Choose repositories on GitHub, then return to connect. ${scope.kind === "organization" ? "Selected repositories are shared with workspace members." : "Add them as projects in Zuse after connecting."}`,
			actions: [
				...choices,
				{
					label: "Check approval",
					href: githubAuthorizationUrl(
						yield* makeGithubInstallUrl(
							verified.accountId,
							verified.actorId,
							verified.nonce,
							user.authorization,
							[...readyOrganizations],
						),
						callback,
					),
				},
				...(verified.canManageInstallation
					? [
							{
								label: "Add another GitHub account",
								href: yield* makeGithubInstallUrl(
									verified.accountId,
									verified.actorId,
									verified.nonce,
									user.authorization,
									[...readyOrganizations],
								),
							},
						]
					: []),
			],
		}),
		{
			headers: githubChooserPageHeaders,
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
		)).filter(
			(installation) =>
				!installation.suspended &&
				(installation.allowedRepositories === undefined ||
					installation.allowedRepositories.length > 0),
		);
		const grants = yield* Effect.forEach(
			installations,
			(installation) =>
				Effect.gen(function* () {
					const access = yield* githubAppRequest<{
						readonly token: string;
						readonly expires_at: string;
					}>(
						`https://api.github.com/app/installations/${installation.installationId}/access_tokens`,
						{
							method: "POST",
							...(installation.allowedRepositories === undefined
								? {}
								: {
										body: JSON.stringify({
											permissions: { contents: "read" },
											repositories: installation.allowedRepositories.map(
												(name) => name.split("/")[1],
											),
										}),
									}),
						},
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

/** Bot credentials are used only for work authenticated as a first-party integration. */
export const githubInstallationCredentialForRepository = Effect.fn(
	"githubInstallationCredentialForRepository",
)(function* (ownerId: string, repositoryIdentity: string) {
	const repository = repositoryIdentity.replace(/^github\.com\//u, "");
	if (!/^[\w.-]+\/[\w.-]+$/u.test(repository))
		return yield* badRequest("invalid_github_repository");
	const [owner, name] = repository.split("/");
	const installations =
		yield* (yield* CloudWorkspaceStore).listGithubInstallations(ownerId);
	const candidates = installations.filter(
		(item) =>
			!item.suspended &&
			githubLinkAllowsRepository(item.allowedRepositories, repository) &&
			item.accountLogin.toLowerCase() === owner?.toLowerCase(),
	);
	for (const installation of candidates) {
		const access = yield* githubAppRequest<{
			token: string;
			expires_at: string;
		}>(
			`https://api.github.com/app/installations/${installation.installationId}/access_tokens`,
			{
				method: "POST",
				body: JSON.stringify({
					repositories: [name],
					permissions: { contents: "write", pull_requests: "write" },
				}),
			},
		).pipe(
			Effect.catch((error) =>
				error.detail === "github_404"
					? Effect.succeed(null)
					: Effect.fail(error),
			),
		);
		if (access === null) continue;
		const expiresAtMs = Date.parse(access.expires_at);
		if (
			!access.token ||
			!Number.isFinite(expiresAtMs) ||
			expiresAtMs <= Date.now()
		)
			return yield* serviceUnavailable("github_token_expiry_invalid");
		return { token: access.token, expiresAtMs };
	}
	return null;
});

export const githubBotCredential = Effect.fn("githubBotCredential")(function* (
	ownerId: string,
	repositoryIdentity: string,
) {
	const config = yield* ApiConfiguration;
	if (config.githubApp === undefined)
		return yield* serviceUnavailable("github_app_not_configured");
	const credential = yield* githubInstallationCredentialForRepository(
		ownerId,
		repositoryIdentity,
	);
	if (credential === null)
		return yield* serviceUnavailable("github_installation_required");
	const login = `${config.githubApp.slug}[bot]`;
	const bot = yield* githubRequest<{ id: number; login: string }>(
		`https://api.github.com/users/${encodeURIComponent(login)}`,
		credential.token,
	);
	if (!Number.isSafeInteger(bot.id) || bot.id <= 0 || bot.login !== login)
		return yield* serviceUnavailable("github_bot_identity_invalid");

	return {
		...credential,
		identity: {
			name: login,
			email: `${bot.id}+${login}@users.noreply.github.com`,
		},
	};
});
