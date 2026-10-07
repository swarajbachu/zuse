import { Effect, Layer } from "effect";
import type { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { githubRequest } from "./github-transport.ts";
import {
	reviewInstallationToken,
	verifyReviewRepository,
} from "./review-github.ts";
import { screenReviewOutput } from "./review-output-screen.ts";
import { ReviewPublicationGateway } from "./review-publication-dispatch.ts";
import { ReviewStore } from "./review-store.ts";
import type { ApiStore } from "./store.ts";
import { resolveWorkspaceActorAccess } from "./workspace-authorization.ts";
import { workspaceScopeForOwner } from "./workspace-scope.ts";

export const ReviewPublicationGatewayLive = Layer.effect(
	ReviewPublicationGateway,
	Effect.gen(function* () {
		const config = yield* ApiConfiguration;
		const store = yield* ReviewStore;
		const context = yield* Effect.context<
			ApiConfiguration | CloudWorkspaceStore | ApiStore
		>();
		const execute = <A, E>(
			operation: Effect.Effect<
				A,
				E,
				ApiConfiguration | CloudWorkspaceStore | ApiStore
			>,
		) => Effect.runPromise(operation.pipe(Effect.provide(context)));
		return {
			forRun: async (run) => {
				const enrollment = (await store.listEnrollments(run.ownerId)).find(
					(e) =>
						e.id === run.enrollmentId &&
						e.enabled &&
						e.version === run.enrollmentVersion,
				);
				if (!enrollment) throw new Error("review_enrollment_revoked");
				const verify = async () =>
					(!run.fork ||
						(await store.checkForkApproved(
							run.repositoryId,
							run.pullNumber,
							run.headSha,
						))) &&
					(await execute(
						Effect.gen(function* () {
							yield* resolveWorkspaceActorAccess(
								{ accountId: enrollment.enabledBy, orgId: undefined },
								workspaceScopeForOwner(run.ownerId),
								"administration",
							);
							const proof = yield* verifyReviewRepository(
								enrollment.enabledBy,
								run.ownerId,
								run.repositoryId,
							);
							return (
								proof.installationId === run.installationId &&
								proof.repositoryFullName === run.repositoryFullName &&
								(enrollment.kind !== "shared" || proof.admin)
							);
						}),
					));
				if (!(await verify()))
					throw new Error("review_publication_access_revoked");
				const grant = await execute(
					reviewInstallationToken(run.installationId, run.repositoryId, true),
				);
				const appId = Number(config.githubApp?.appId);
				const slug = config.githubApp?.slug;
				if (!Number.isSafeInteger(appId) || appId <= 0 || !slug)
					throw new Error("review_github_app_invalid");
				const bot = await execute(
					githubRequest<{ id: number }>(
						`https://api.github.com/users/${encodeURIComponent(`${slug}[bot]`)}`,
						grant.token,
					),
				);
				if (!Number.isSafeInteger(bot.id) || bot.id <= 0)
					throw new Error("review_github_bot_invalid");
				const prefix = `/repos/${run.repositoryFullName}/`;
				return {
					appId,
					botUserId: bot.id,
					request: async (input) => {
						if (
							!input.path.startsWith(prefix) ||
							input.path.includes("..") ||
							input.path.includes("\\") ||
							input.path.includes("#")
						)
							throw new Error("review_github_scope_violation");
						return await execute(
							githubRequest<unknown>(
								`https://api.github.com${input.path}`,
								grant.token,
								{
									method: input.method,
									redirect: "error",
									...(input.body
										? {
												headers: { "content-type": "application/json" },
												body: JSON.stringify(input.body),
											}
										: {}),
								},
							),
						);
					},
					assertCurrent: async (current, publication) =>
						current.id === run.id &&
						(await store.publicationIsCurrent(
							publication.id,
							publication.leaseToken,
							Date.now(),
						)) &&
						(await verify()),
					screenOutput: async (text) => screenReviewOutput(text, [grant.token]),
					fixUrl: (runId, findingId) => {
						const target = new URL(
							"/review/fix",
							config.publicApiOrigin ?? config.apiIssuer,
						);
						target.searchParams.set("runId", runId);
						if (findingId) target.searchParams.set("findingId", findingId);
						return target.href;
					},
				};
			},
		};
	}),
);
