import type { ReviewRequest } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import { githubUserApiRequest } from "./cloud-github-user.ts";
import { ApiConfiguration } from "./config.ts";
import { badRequest, forbidden, serviceUnavailable } from "./errors.ts";
import { verifyReviewRepository } from "./review-github.ts";
import { getReviewReadiness } from "./review-readiness.ts";
import { ReviewStore } from "./review-store.ts";

const Positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const Sha = Schema.String.check(
	Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
);
const Pull = Schema.Struct({
	state: Schema.String,
	user: Schema.Struct({ id: Positive }),
	base: Schema.Struct({
		ref: Schema.String,
		sha: Sha,
		repo: Schema.Struct({ id: Positive }),
	}),
	head: Schema.Struct({
		sha: Sha,
		repo: Schema.NullOr(Schema.Struct({ id: Positive })),
	}),
});
const call = <A>(f: () => Promise<A>) =>
	Effect.tryPromise({
		try: f,
		catch: () => serviceUnavailable("review_storage_unavailable"),
	});
/** Explicit manual generation; routing and sponsor validation happen atomically before insertion. */
export const requestReview = Effect.fn("requestReview")(function* (
	ownerId: string,
	actorId: string,
	input: ReviewRequest,
) {
	const store = yield* ReviewStore;
	const config = yield* ApiConfiguration;
	const proof = yield* verifyReviewRepository(
		actorId,
		ownerId,
		input.repositoryId,
	);
	const lease = yield* call(() =>
		store.claimRepositoryRefresh(input.repositoryId, Date.now()),
	);
	if (!lease) return yield* serviceUnavailable("review_refresh_busy");
	return yield* Effect.gen(function* () {
		const pull = yield* githubUserApiRequest(
			actorId,
			`/repos/${proof.repositoryFullName}/pulls/${input.pullNumber}`,
		).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(Pull)),
			Effect.mapError(() => badRequest("review_pull_invalid")),
		);
		if (
			pull.state !== "open" ||
			pull.base.repo.id !== input.repositoryId ||
			!pull.head.repo
		)
			return yield* badRequest("review_pull_invalid");
		if (input.expectedHeadSha && input.expectedHeadSha !== pull.head.sha)
			return yield* badRequest("review_head_changed");
		const fork = pull.head.repo.id !== input.repositoryId;
		if (fork) {
			if (
				!input.approveFork ||
				input.expectedHeadSha !== pull.head.sha ||
				!proof.admin
			)
				return yield* forbidden("review_fork_head_approval_required");
			yield* call(() =>
				store.approveFork(
					input.repositoryId,
					input.pullNumber,
					pull.head.sha,
					actorId,
					Date.now(),
				),
			);
		}
		const enrollments = yield* call(() => store.listEnrollments(ownerId));
		if (
			!enrollments.some(
				(e) =>
					e.enabled &&
					e.repositoryId === input.repositoryId &&
					getReviewReadiness(e.agentProvider, config.review).available,
			)
		)
			return yield* serviceUnavailable("review_provider_verification_required");
		const run = yield* call(() =>
			store.createRun(
				{
					repositoryId: input.repositoryId,
					repositoryFullName: proof.repositoryFullName,
					installationId: proof.installationId,
					pullNumber: input.pullNumber,
					authorGithubUserId: pull.user.id,
					baseRef: pull.base.ref,
					baseSha: pull.base.sha,
					headSha: pull.head.sha,
					fork,
				},
				Date.now(),
				crypto.randomUUID(),
				lease,
				ownerId,
			),
		);
		if (!run) return yield* forbidden("review_enrollment_or_sponsor_required");
		return run;
	}).pipe(
		Effect.ensuring(
			Effect.promise(() =>
				store.releaseRepositoryRefresh(input.repositoryId, lease),
			),
		),
	);
});
