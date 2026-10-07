import { Effect, Schema } from "effect";
import { githubUserApiRequest } from "./cloud-github-user.ts";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { forbidden, serviceUnavailable } from "./errors.ts";
import { githubAppRequest } from "./github-transport.ts";
import type { VerifiedReviewRepository } from "./review-store.ts";

const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Repository = Schema.Struct({
	id: Positive,
	full_name: Schema.String,
	permissions: Schema.optional(
		Schema.Struct({
			pull: Schema.optional(Schema.Boolean),
			admin: Schema.optional(Schema.Boolean),
		}),
	),
});
const decode = <A>(schema: Schema.Codec<A, unknown>, value: unknown) =>
	Schema.decodeUnknownEffect(schema)(value).pipe(
		Effect.mapError(() => forbidden("review_repository_access_required")),
	);
export const getReviewGithubIdentity = Effect.fn("getReviewGithubIdentity")(
	function* (actorId: string) {
		const value = yield* githubUserApiRequest(actorId, "/user");
		const user = yield* decode(
			Schema.Struct({
				id: Positive,
				login: Schema.String,
				type: Schema.Literal("User"),
			}),
			value,
		);
		return { githubUserId: user.id, login: user.login };
	},
);
/** Existing connected GitHub credentials prove the initiating actor; no second OAuth redirect or bearer bridge. */
export const verifyReviewRepository = Effect.fn("verifyReviewRepository")(
	function* (actorId: string, ownerId: string, repositoryId: number) {
		const user = yield* getReviewGithubIdentity(actorId);
		const repository = yield* decode(
			Repository,
			yield* githubUserApiRequest(actorId, `/repositories/${repositoryId}`),
		);
		if (
			repository.id !== repositoryId ||
			repository.permissions?.pull !== true ||
			!/^[\w.-]+\/[\w.-]+$/.test(repository.full_name)
		)
			return yield* forbidden("review_repository_access_required");
		const installation = yield* githubAppRequest<{
			id: number;
			suspended_at: string | null;
		}>(`https://api.github.com/repos/${repository.full_name}/installation`);
		const linked = yield* (yield* CloudWorkspaceStore).listGithubInstallations(
			ownerId,
		);
		if (
			!Number.isSafeInteger(installation.id) ||
			installation.suspended_at !== null ||
			!linked.some((i) => i.installationId === installation.id && !i.suspended)
		)
			return yield* forbidden("review_installation_required");
		yield* reviewInstallationToken(installation.id, repositoryId);
		return {
			githubUserId: user.githubUserId,
			repositoryId,
			repositoryFullName: repository.full_name,
			installationId: installation.id,
			admin: repository.permissions.admin === true,
		} satisfies VerifiedReviewRepository;
	},
);
export const listReviewRepositories = Effect.fn("listReviewRepositories")(
	function* (actorId: string, ownerId: string) {
		const installations =
			(yield* (yield* CloudWorkspaceStore).listGithubInstallations(
				ownerId,
			)).filter((i) => !i.suspended);
		const result = new Map<
			number,
			{ id: number; fullName: string; canAdminister: boolean }
		>();
		for (const installation of installations) {
			for (let page = 1; page <= 10; page++) {
				const data = yield* decode(
					Schema.Struct({ repositories: Schema.Array(Repository) }),
					yield* githubUserApiRequest(
						actorId,
						`/user/installations/${installation.installationId}/repositories?per_page=100&page=${page}`,
					),
				);
				for (const repository of data.repositories)
					if (repository.permissions?.pull)
						result.set(repository.id, {
							id: repository.id,
							fullName: repository.full_name,
							canAdminister: repository.permissions.admin === true,
						});
				if (data.repositories.length < 100) break;
				if (page === 10)
					return yield* serviceUnavailable(
						"review_repository_pagination_limit",
					);
			}
		}
		return [...result.values()];
	},
);
export const reviewInstallationToken = Effect.fn("reviewInstallationToken")(
	function* (installationId: number, repositoryId: number, write = false) {
		return yield* githubAppRequest<{ token: string; expires_at: string }>(
			`https://api.github.com/app/installations/${installationId}/access_tokens`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					repository_ids: [repositoryId],
					permissions: {
						contents: "read",
						pull_requests: write ? "write" : "read",
						metadata: "read",
						...(write ? { checks: "write" } : {}),
					},
				}),
			},
		);
	},
);
