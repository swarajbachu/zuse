import {
	ApiPaths,
	OrganizationGithubInput,
	OrganizationGithubPolicyInput,
	OrganizationGithubRestoreInput,
} from "@zuse/contracts";
import { BROWSER_PAGE_HEADERS } from "@zuse/utils/browser-page";
import {
	INTEGRATION_PAGE_HEADERS,
	renderIntegrationPage,
} from "@zuse/utils/integration-page";
import { Clock, Effect, Schema } from "effect";
import { requireWorkos } from "./auth.ts";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import {
	badRequest,
	conflict,
	forbidden,
	notFound,
	serviceUnavailable,
} from "./errors.ts";
import { githubMemberEligible } from "./github-membership.ts";
import {
	exchangeGithubCode,
	githubRequest,
	readGithubInstallation,
} from "./github-transport.ts";
import { decodeBody, json } from "./http.ts";
import {
	organizationAccessAllowed,
	requireOrganizationRollout,
} from "./organization-rollout.ts";
import {
	admitOrganizationMember,
	membershipsFor,
	organizationSeatsFull,
	requestWorkos,
	WorkosMember,
	WorkosOrganization,
	WorkosUser,
} from "./organization-workos.ts";
import { requireOrganizationMember } from "./organizations.ts";
import { ApiStore } from "./store.ts";

const cookieName = "zuse_github_join";
/** The confirmation form posts back here; keep the Origin header for its check. */
const confirmationPageHeaders = {
	...INTEGRATION_PAGE_HEADERS,
	"referrer-policy": "strict-origin",
	"content-security-policy": `${INTEGRATION_PAGE_HEADERS["content-security-policy"]}; form-action 'self'`,
};
const callbackUrl = Effect.gen(function* () {
	const config = yield* ApiConfiguration;
	return new URL(
		ApiPaths.organizationGithubCallback,
		config.publicApiOrigin ?? config.apiIssuer,
	).toString();
});

/**
 * Admit an eligible GitHub member, reserving the seat before calling WorkOS.
 * Resolves true only when this call admitted (or re-admitted) the member.
 */
export const joinGithubOrganization = Effect.fn("joinGithubOrganization")(
	function* (
		accountId: string,
		githubUserId: number,
		input: { readonly organizationId: string; readonly installationId: number },
	) {
		yield* requireOrganizationRollout(input.organizationId);
		const store = yield* ApiStore;
		const joining = store.githubJoining;
		// Commit enrollment intent and its seat reservation before calling WorkOS.
		// This uses the existing one-connection transaction lock without a second
		// database connection or a transaction spanning both durable writes.
		const prepared = yield* store.withOrganizationLock(
			input.organizationId,
			Effect.gen(function* () {
				const policy = (yield* joining.listPolicies({
					organizationId: input.organizationId,
				})).find(
					(p) =>
						p.organizationId === input.organizationId &&
						p.installationId === input.installationId &&
						p.enabled,
				);
				const enrollment = yield* joining.getEnrollment(
					input.organizationId,
					accountId,
				);
				if (
					!policy ||
					enrollment?.blocked ||
					!(yield* githubMemberEligible(policy, githubUserId))
				)
					return yield* forbidden("organization_access_denied");
				const memberships = yield* membershipsFor(
					accountId,
					input.organizationId,
				);
				const active = memberships.find((m) => m.status === "active");
				if (active) return null; // Never convert a manually admitted membership.
				if (!enrollment && memberships.length > 0)
					return yield* forbidden("organization_access_denied");
				if (yield* organizationSeatsFull(input.organizationId, accountId))
					return yield* conflict("organization_member_limit_reached");
				const pending = {
					organizationId: input.organizationId,
					accountId,
					githubUserId,
					installationId: policy.installationId,
					githubOrgId: policy.githubOrgId,
					blocked: false,
					memberId: enrollment?.memberId ?? null,
					reservedUntil: (yield* Clock.currentTimeMillis) + 600_000,
					revision: crypto.randomUUID(),
				};
				yield* joining.saveEnrollment(pending);
				return pending;
			}),
		);
		if (!prepared) return false;
		return yield* store.withOrganizationLock(
			input.organizationId,
			Effect.gen(function* () {
				const enrollment = yield* joining.getEnrollment(
					input.organizationId,
					accountId,
				);
				const policy = (yield* joining.listPolicies({
					organizationId: input.organizationId,
				})).find(
					(p) =>
						p.organizationId === input.organizationId &&
						p.installationId === input.installationId &&
						p.enabled,
				);
				if (
					!enrollment ||
					enrollment.installationId !== input.installationId ||
					enrollment.blocked ||
					!policy ||
					!(yield* githubMemberEligible(policy, githubUserId))
				)
					return yield* forbidden("organization_access_denied");
				const memberships = yield* membershipsFor(
					accountId,
					input.organizationId,
				);
				const active = memberships.find((m) => m.status === "active");
				if (active) {
					yield* joining.saveEnrollment({
						...enrollment,
						memberId: active.id,
						reservedUntil: 0,
					});
					return false;
				}
				if (yield* organizationSeatsFull(input.organizationId, accountId))
					return yield* conflict("organization_member_limit_reached");
				const member = yield* admitOrganizationMember(
					input.organizationId,
					accountId,
					memberships,
				);
				yield* joining.saveEnrollment({
					...enrollment,
					memberId: member.id,
					reservedUntil: 0,
				});
				return true;
			}),
		);
	},
);

/** Joins one organization; skips blocked, already joined and full cases. */
const autoJoin = (
	accountId: string,
	githubUserId: number,
	policy: { readonly organizationId: string; readonly installationId: number },
) =>
	Effect.gen(function* () {
		if (!(yield* organizationAccessAllowed(policy.organizationId)))
			return false;
		const enrollment = yield* (yield* ApiStore).githubJoining.getEnrollment(
			policy.organizationId,
			accountId,
		);
		if (enrollment?.blocked) return false;
		// A finished enrollment whose membership is still active needs nothing.
		// One that lost access (left GitHub, then returned) is re-admitted.
		if (
			enrollment?.memberId &&
			!enrollment.reservedUntil &&
			(yield* membershipsFor(accountId, policy.organizationId).pipe(
				Effect.map((rows) => rows.some((m) => m.status === "active")),
				Effect.catch(() => Effect.succeed(true)),
			))
		)
			return false;
		// One organization failing (full, removed, GitHub unavailable) never
		// blocks the others or the caller.
		return yield* joinGithubOrganization(accountId, githubUserId, policy).pipe(
			Effect.catch(() => Effect.succeed(false)),
		);
	});

/**
 * Join every organization whose admins turned on auto-join for a GitHub
 * organization this account's linked GitHub account belongs to. Returns the
 * organizations joined now.
 */
export const syncGithubAutoJoin = Effect.fn("syncGithubAutoJoin")(function* (
	accountId: string,
) {
	const joining = (yield* ApiStore).githubJoining;
	const identity = yield* joining.getIdentity(accountId);
	if (!identity) return [];
	const installationIds = yield* joining.installationsWithMember(
		identity.githubUserId,
	);
	if (installationIds.length === 0) return [];
	const joined: string[] = [];
	for (const policy of yield* joining.listPolicies({ installationIds })) {
		if (!policy.enabled || joined.includes(policy.organizationId)) continue;
		if (yield* autoJoin(accountId, identity.githubUserId, policy))
			joined.push(policy.organizationId);
	}
	return joined;
});

/**
 * Join every linked account in an installation's roster to the organizations
 * with auto-join on for it. Runs when auto-join turns on and when GitHub
 * reports membership changes, so members join without opening Zuse.
 */
export const autoJoinInstallation = Effect.fn("autoJoinInstallation")(
	function* (installationId: number) {
		const joining = (yield* ApiStore).githubJoining;
		const identities = yield* joining.identitiesInRoster(installationId);
		for (const policy of yield* joining.listPolicies({ installationId })) {
			if (!policy.enabled) continue;
			for (const identity of identities) {
				if (yield* organizationSeatsFull(policy.organizationId)) break;
				yield* autoJoin(identity.accountId, identity.githubUserId, policy);
			}
		}
	},
);

export const routeGithubOrganizationRequest = Effect.fn(
	"routeGithubOrganizationRequest",
)(function* (request: Request) {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(`${ApiPaths.organizations}/github/`))
		return null;
	const config = yield* ApiConfiguration;
	if (!config.organizationWorkspacesEnabled)
		return yield* forbidden("organization_workspaces_disabled");
	const store = yield* ApiStore;
	const joining = store.githubJoining;
	if (
		url.pathname === ApiPaths.organizationGithubCallback &&
		request.method === "GET"
	) {
		const state = url.searchParams.get("state");
		if (!state || !/^user_[A-Za-z0-9]+:[0-9a-f-]{36}$/u.test(state))
			return yield* badRequest("invalid_github_join_state");
		const callback = yield* callbackUrl;
		const code = url.searchParams.get("code");
		if (!code && !url.searchParams.has("error")) {
			if (!config.githubApp?.clientId)
				return yield* serviceUnavailable("github_app_oauth_not_configured");
			const authorize = new URL("https://github.com/login/oauth/authorize");
			authorize.searchParams.set("client_id", config.githubApp.clientId);
			authorize.searchParams.set("redirect_uri", callback);
			authorize.searchParams.set("state", state);
			return new Response(null, {
				status: 302,
				headers: {
					...BROWSER_PAGE_HEADERS,
					location: authorize.toString(),
					"set-cookie": `${cookieName}=${state}; HttpOnly; Secure; SameSite=Lax; Path=${ApiPaths.organizationGithubCallback}; Max-Age=600`,
				},
			});
		}
		if (
			!(request.headers.get("cookie") ?? "")
				.split(";")
				.some((c) => c.trim() === `${cookieName}=${state}`)
		)
			return yield* badRequest("invalid_github_browser_state");
		const [accountId, nonce] = state.split(":");
		if (!accountId || !nonce)
			return yield* badRequest("invalid_github_join_state");
		const challenge = yield* store.consumeChallenge(
			`github-join:${nonce}`,
			accountId,
		);
		if (
			!challenge ||
			challenge.challenge !== state ||
			challenge.apiIssuer !== config.apiIssuer ||
			challenge.expiresAtMs <= (yield* Clock.currentTimeMillis)
		)
			return yield* badRequest("invalid_github_join_state");
		if (!code || url.searchParams.has("error"))
			return yield* badRequest("github_authorization_denied");
		const token = yield* exchangeGithubCode(code, callback);
		const raw = yield* githubRequest<unknown>(
			"https://api.github.com/user",
			token.access_token,
			{ signal: AbortSignal.timeout(5_000) },
		);
		const user = yield* Schema.decodeUnknownEffect(
			Schema.Struct({
				id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
				login: Schema.String,
			}),
		)(raw).pipe(Effect.mapError(() => badRequest("github_identity_invalid")));
		const organizationIds: number[] = [];
		for (let page = 1; ; page++) {
			if (page > 100)
				return yield* serviceUnavailable("github_roster_too_large");
			const rawMemberships = yield* githubRequest<unknown>(
				`https://api.github.com/user/memberships/orgs?per_page=100&page=${page}`,
				token.access_token,
				{ signal: AbortSignal.timeout(5_000) },
			);
			const memberships = yield* Schema.decodeUnknownEffect(
				Schema.Array(
					Schema.Struct({
						state: Schema.String,
						organization: Schema.Struct({ id: Schema.Number }),
					}),
				),
			)(rawMemberships).pipe(
				Effect.mapError(() => serviceUnavailable("github_members_invalid")),
			);
			organizationIds.push(
				...memberships
					.filter((m) => m.state === "active")
					.map((m) => m.organization.id),
			);
			if (memberships.length < 100) break;
		}
		// The browser carries no Zuse session, so a link minted for another
		// account must not attach this GitHub account silently. Hold the
		// verified identity and ask the person to confirm the named account.
		yield* store.createChallenge({
			challengeId: `github-join-confirm:${nonce}`,
			accountId,
			challenge: JSON.stringify({
				githubUserId: user.id,
				login: user.login,
				organizationIds,
			}),
			apiIssuer: config.apiIssuer,
			expiresAtMs: (yield* Clock.currentTimeMillis) + 600_000,
		});
		const target = yield* requestWorkos(
			`/user_management/users/${encodeURIComponent(accountId)}`,
			WorkosUser,
		);
		return new Response(
			renderIntegrationPage({
				integration: "GitHub",
				title: "Link your GitHub account",
				status: "Confirm",
				description: `Link GitHub @${user.login} to the Zuse account ${target.email}?`,
				hint: `Only continue if ${target.email} is your Zuse account. If you didn't start this from Zuse, close this tab.`,
				actions: [
					{
						label: `Link @${user.login}`,
						action: callback,
						csrf: nonce,
					},
				],
			}),
			{ headers: confirmationPageHeaders },
		);
	}
	if (
		url.pathname === ApiPaths.organizationGithubCallback &&
		request.method === "POST"
	) {
		const callback = yield* callbackUrl;
		if (request.headers.get("origin") !== new URL(callback).origin)
			return yield* badRequest("invalid_github_join_state");
		const form = yield* Effect.tryPromise({
			try: () => request.formData(),
			catch: () => badRequest("invalid_github_join_state"),
		});
		const nonce = form.get("csrf");
		const cookieState = (request.headers.get("cookie") ?? "")
			.split(";")
			.map((c) => c.trim())
			.find((c) => c.startsWith(`${cookieName}=`))
			?.slice(cookieName.length + 1);
		const [accountId, cookieNonce] = (cookieState ?? "").split(":");
		if (
			typeof nonce !== "string" ||
			!accountId ||
			!/^user_[A-Za-z0-9]+$/u.test(accountId) ||
			cookieNonce !== nonce
		)
			return yield* badRequest("invalid_github_browser_state");
		const pending = yield* store.consumeChallenge(
			`github-join-confirm:${nonce}`,
			accountId,
		);
		if (
			!pending ||
			pending.apiIssuer !== config.apiIssuer ||
			pending.expiresAtMs <= (yield* Clock.currentTimeMillis)
		)
			return yield* badRequest("invalid_github_join_state");
		const user = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(
				Schema.Struct({
					githubUserId: Schema.Number,
					login: Schema.String,
					organizationIds: Schema.Array(Schema.Number),
				}),
			),
		)(pending.challenge).pipe(
			Effect.mapError(() => badRequest("invalid_github_join_state")),
		);
		if (
			!(yield* joining.saveIdentity({
				accountId,
				githubUserId: user.githubUserId,
				organizationIds: user.organizationIds,
				verificationId: nonce,
				login: user.login,
			}))
		)
			return yield* conflict("github_identity_already_linked");
		const joined = yield* syncGithubAutoJoin(accountId).pipe(
			Effect.flatMap((ids) =>
				Effect.forEach(ids, (id) =>
					requestWorkos(
						`/organizations/${encodeURIComponent(id)}`,
						WorkosOrganization,
					).pipe(Effect.map((org) => org.name)),
				),
			),
			Effect.catch(() => Effect.succeed([] as string[])),
		);
		return new Response(
			renderIntegrationPage({
				integration: "GitHub",
				title: "GitHub connected",
				status: "Connected",
				description:
					joined.length > 0
						? `@${user.login} is connected. You joined ${joined.join(", ")}.`
						: `@${user.login} is connected. Teams that turn on auto-join for your GitHub organizations add you automatically.`,
				hint: "You can close this tab.",
				actions: [],
			}),
			{
				headers: {
					...BROWSER_PAGE_HEADERS,
					"set-cookie": `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=${ApiPaths.organizationGithubCallback}; Max-Age=0`,
				},
			},
		);
	}
	const { accountId } = yield* requireWorkos(request);
	if (request.method !== "POST") return yield* notFound();
	if (url.pathname === ApiPaths.organizationGithubConnection) {
		const identity = yield* joining.getIdentity(accountId);
		return json(
			identity
				? { connected: true, login: identity.login }
				: { connected: false },
		);
	}
	if (url.pathname === ApiPaths.organizationGithubAuthorize) {
		if (!config.githubApp?.clientId || !config.githubApp.clientSecret)
			return yield* serviceUnavailable("github_app_oauth_not_configured");
		const nonce = crypto.randomUUID();
		const state = `${accountId}:${nonce}`;
		yield* store.createChallenge({
			challengeId: `github-join:${nonce}`,
			accountId,
			challenge: state,
			apiIssuer: config.apiIssuer,
			expiresAtMs: (yield* Clock.currentTimeMillis) + 600_000,
		});
		const target = new URL(yield* callbackUrl);
		target.searchParams.set("state", state);
		return json({ url: target.toString(), attemptId: nonce });
	}

	if (url.pathname === ApiPaths.organizationGithubSettings) {
		const { organizationId } = yield* decodeBody(
			OrganizationGithubInput,
			request,
		);
		yield* requireOrganizationMember(accountId, organizationId, true);
		const connections =
			yield* (yield* CloudWorkspaceStore).listGithubInstallations(
				`organization:${organizationId}`,
			);
		const policies = yield* joining.listPolicies({ organizationId });
		const blockedMembers = yield* Effect.forEach(
			(yield* joining.listEnrollments(organizationId)).filter((e) => e.blocked),
			(e) =>
				requestWorkos(
					`/user_management/users/${encodeURIComponent(e.accountId)}`,
					WorkosUser,
				).pipe(
					Effect.map((user) => ({
						accountId: e.accountId,
						displayName: user.email,
					})),
				),
			{ concurrency: 4 },
		);
		return json({
			installations: connections
				.filter((c) => c.accountType === "Organization")
				.map((c) => ({
					installationId: c.installationId,
					login: c.accountLogin,
					...(c.avatarUrl ? { avatarUrl: c.avatarUrl } : {}),
					suspended: c.suspended,
					enabled: policies.some(
						(p) =>
							p.organizationId === organizationId &&
							p.installationId === c.installationId &&
							p.enabled,
					),
				})),
			blockedMembers,
		});
	}
	if (url.pathname === ApiPaths.organizationGithubPolicy) {
		const input = yield* decodeBody(OrganizationGithubPolicyInput, request);
		yield* store.withOrganizationLock(
			input.organizationId,
			Effect.gen(function* () {
				yield* requireOrganizationMember(accountId, input.organizationId, true);
				const connection =
					(yield* (yield* CloudWorkspaceStore).listGithubInstallations(
						`organization:${input.organizationId}`,
					)).find(
						(c) =>
							c.installationId === input.installationId &&
							c.accountType === "Organization",
					);
				if (!connection)
					return yield* forbidden("github_installation_not_connected");
				const installation = yield* readGithubInstallation(
					input.installationId,
				);
				if (
					installation.account.id !== connection.githubAccountId ||
					installation.account.type !== "Organization" ||
					(input.enabled && installation.suspended_at !== null)
				)
					return yield* forbidden("github_installation_unavailable");
				const policy = {
					organizationId: input.organizationId,
					installationId: input.installationId,
					githubOrgId: connection.githubAccountId,
					login: installation.account.login,
					enabled: input.enabled,
					revision: crypto.randomUUID(),
				};
				// A complete roster read proves Members permission and stores the roster.
				if (input.enabled) yield* githubMemberEligible(policy, -1);
				yield* joining.savePolicy(policy);
			}),
		);
		if (input.enabled)
			yield* autoJoinInstallation(input.installationId).pipe(
				Effect.catch(() => Effect.void),
			);
		return json({ ok: true });
	}
	if (url.pathname === ApiPaths.organizationGithubRestore) {
		const input = yield* decodeBody(OrganizationGithubRestoreInput, request);
		return yield* store.withOrganizationLock(
			input.organizationId,
			Effect.gen(function* () {
				yield* requireOrganizationMember(accountId, input.organizationId, true);
				const e = yield* joining.getEnrollment(
					input.organizationId,
					input.accountId,
				);
				if (!e) return yield* notFound();
				// Finish a previously interrupted removal before allowing a new seat claim.
				if (e.blocked)
					for (const m of yield* membershipsFor(
						input.accountId,
						input.organizationId,
					))
						if (m.status === "active")
							yield* requestWorkos(
								`/user_management/organization_memberships/${encodeURIComponent(m.id)}/deactivate`,
								WorkosMember,
								"PUT",
								{},
							);
				yield* joining.saveEnrollment({
					...e,
					blocked: false,
					revision: crypto.randomUUID(),
				});
				return json({ ok: true });
			}),
		);
	}
	return yield* notFound();
});
