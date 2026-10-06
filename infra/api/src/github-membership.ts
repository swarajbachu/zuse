import { KeyedEffectSerialWorker } from "@zuse/utils/keyed-worker";
import { Clock, Effect, Schema } from "effect";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { forbidden, serviceUnavailable } from "./errors.ts";
import type { GithubJoinPolicy } from "./github-joining-store.ts";
import {
	githubAppRequest,
	githubRequest,
	readGithubInstallation,
} from "./github-transport.ts";
import {
	listWorkos,
	requestWorkos,
	WorkosMember,
} from "./organization-workos.ts";
import { ApiStore, type ApiStoreApi } from "./store.ts";

const caches = new WeakMap<
	ApiStoreApi,
	{
		worker: KeyedEffectSerialWorker<string>;
		values: Map<string, { expires: number; members: ReadonlySet<number> }>;
	}
>();

/** Cache only successful, complete rosters. The durable policy revision makes
 * invalidation effective across workers; installation connectivity is never cached. */
export const githubMemberEligible = Effect.fn("githubMemberEligible")(
	function* (policy: GithubJoinPolicy, githubUserId: number) {
		const store = yield* ApiStore;
		const connections =
			yield* (yield* CloudWorkspaceStore).listGithubInstallations(
				`organization:${policy.organizationId}`,
			);
		if (
			!connections.some(
				(c) =>
					c.installationId === policy.installationId &&
					c.githubAccountId === policy.githubOrgId &&
					c.accountType === "Organization" &&
					!c.suspended,
			)
		)
			return yield* forbidden("github_installation_unavailable");
		let cache = caches.get(store);
		if (!cache) {
			cache = {
				worker: new KeyedEffectSerialWorker<string>(),
				values: new Map(),
			};
			caches.set(store, cache);
		}
		const local = cache;
		const key = `${policy.installationId}:${policy.githubOrgId}:${policy.revision}`;
		const members = yield* local.worker.run(
			key,
			Effect.gen(function* () {
				const now = yield* Clock.currentTimeMillis;
				for (const [k, v] of local.values)
					if (v.expires <= now) local.values.delete(k);
				const cached = local.values.get(key);
				if (cached) return cached.members;
				const installation = yield* readGithubInstallation(
					policy.installationId,
				).pipe(
					Effect.catch((error) =>
						error.detail === "github_404"
							? Effect.succeed(null)
							: Effect.fail(error),
					),
				);
				if (
					!installation ||
					installation.suspended_at !== null ||
					installation.account.id !== policy.githubOrgId ||
					installation.account.type !== "Organization"
				)
					return yield* forbidden("github_installation_unavailable");
				const token = yield* githubAppRequest<{
					token: string;
					permissions?: { members?: string };
				}>(
					`https://api.github.com/app/installations/${policy.installationId}/access_tokens`,
					{
						method: "POST",
						signal: AbortSignal.timeout(5_000),
						body: JSON.stringify({ permissions: { members: "read" } }),
					},
				);
				if (
					token.permissions?.members !== "read" &&
					token.permissions?.members !== "write"
				)
					return yield* serviceUnavailable(
						"github_members_permission_required",
					);
				const result = new Set<number>();
				for (let page = 1; page <= 100; page++) {
					const raw = yield* githubRequest<unknown>(
						`https://api.github.com/orgs/${encodeURIComponent(installation.account.login)}/members?per_page=100&page=${page}`,
						token.token,
						{ signal: AbortSignal.timeout(5_000) },
					);
					const rows = yield* Schema.decodeUnknownEffect(
						Schema.Array(Schema.Struct({ id: Schema.Number })),
					)(raw).pipe(
						Effect.mapError(() => serviceUnavailable("github_members_invalid")),
					);
					for (const row of rows) result.add(row.id);
					if (rows.length < 100) {
						local.values.set(key, { members: result, expires: now + 60_000 });
						// Persist the complete roster so sign-in matching is a lookup.
						yield* store.githubJoining.replaceRoster(
							policy.installationId,
							result,
						);
						return result;
					}
				}
				return yield* serviceUnavailable("github_roster_too_large");
			}),
		);
		return members.has(githubUserId);
	},
);

export const requireGithubEnrollment = Effect.fn("requireGithubEnrollment")(
	function* (accountId: string, organizationId: string, memberId: string) {
		const store = yield* ApiStore;
		const enrollment = yield* store.githubJoining.getEnrollment(
			organizationId,
			accountId,
		);
		if (!enrollment) return false;
		if (enrollment.blocked)
			return yield* forbidden("organization_access_denied");
		const policy = (yield* store.githubJoining.listPolicies({
			organizationId,
		})).find(
			(p) =>
				p.organizationId === organizationId &&
				p.installationId === enrollment.installationId &&
				p.githubOrgId === enrollment.githubOrgId,
		);
		if (!policy) return yield* forbidden("organization_access_denied");
		if (!(yield* githubMemberEligible(policy, enrollment.githubUserId))) {
			const latest = (yield* store.githubJoining.listPolicies({
				organizationId,
			})).find(
				(p) =>
					p.organizationId === organizationId &&
					p.installationId === policy.installationId,
			);
			if (latest?.revision !== policy.revision)
				return yield* forbidden("organization_access_denied");
			// Deactivation is idempotent. A failed provider write cannot grant access.
			yield* requestWorkos(
				`/user_management/organization_memberships/${encodeURIComponent(memberId)}/deactivate`,
				WorkosMember,
				"PUT",
				{},
			);
			return yield* forbidden("organization_access_denied");
		}
		// Re-read durable state after network I/O so concurrent removal/invalidation
		// cannot authorize using an obsolete successful check.
		const current = yield* store.githubJoining.getEnrollment(
			organizationId,
			accountId,
		);
		const latest = (yield* store.githubJoining.listPolicies({
			organizationId,
		})).find(
			(p) =>
				p.organizationId === organizationId &&
				p.installationId === policy.installationId,
		);
		if (
			!current ||
			current.blocked ||
			current.revision !== enrollment.revision ||
			latest?.revision !== policy.revision
		)
			return yield* forbidden("organization_access_denied");
		const connections =
			yield* (yield* CloudWorkspaceStore).listGithubInstallations(
				`organization:${organizationId}`,
			);
		if (
			!connections.some(
				(c) =>
					c.installationId === policy.installationId &&
					c.githubAccountId === policy.githubOrgId &&
					!c.suspended,
			)
		)
			return yield* forbidden("organization_access_denied");
		return true;
	},
);

export const invalidateGithubJoining = Effect.fn("invalidateGithubJoining")(
	function* (installationId: number) {
		const store = yield* ApiStore;
		for (const policy of yield* store.githubJoining.listPolicies({
			installationId,
		})) {
			if (policy.installationId !== installationId) continue;
			yield* store.withOrganizationLock(
				policy.organizationId,
				Effect.gen(function* () {
					const current = (yield* store.githubJoining.listPolicies({
						organizationId: policy.organizationId,
					})).find(
						(p) =>
							p.organizationId === policy.organizationId &&
							p.installationId === installationId,
					);
					if (current)
						yield* store.githubJoining.savePolicy({
							...current,
							revision: crypto.randomUUID(),
						});
				}),
			);
		}
	},
);

/** Re-read rosters for an installation's enabled policies after GitHub changes. */
export const refreshGithubRosters = Effect.fn("refreshGithubRosters")(
	function* (installationId: number) {
		const store = yield* ApiStore;
		for (const policy of yield* store.githubJoining.listPolicies({
			installationId,
		})) {
			if (!policy.enabled) continue;
			// An unavailable installation keeps its last roster; access is still
			// checked live on every join and request.
			yield* githubMemberEligible(policy, -1).pipe(
				Effect.catch(() => Effect.void),
			);
		}
	},
);

/** Webhooks reconcile existing active memberships only, never enroll users. */
export const reconcileGithubMemberships = Effect.fn(
	"reconcileGithubMemberships",
)(function* (installationId: number) {
	const store = yield* ApiStore;
	for (const enrollment of yield* store.githubJoining.listEnrollments(
		undefined,
		installationId,
	)) {
		if (enrollment.installationId !== installationId || enrollment.blocked)
			continue;
		const members = yield* listWorkos(
			`/user_management/organization_memberships?organization_id=${encodeURIComponent(enrollment.organizationId)}&user_id=${encodeURIComponent(enrollment.accountId)}`,
			WorkosMember,
		);
		for (const member of members) {
			if (
				member.organization_id !== enrollment.organizationId ||
				member.user_id !== enrollment.accountId ||
				member.status !== "active"
			)
				continue;
			yield* requireGithubEnrollment(
				enrollment.accountId,
				enrollment.organizationId,
				member.id,
			).pipe(
				Effect.catch((error) =>
					error.status === 403 ? Effect.void : Effect.fail(error),
				),
			);
		}
	}
});
