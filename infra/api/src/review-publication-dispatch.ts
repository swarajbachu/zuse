import { Context, Effect, Option } from "effect";
import type { ReviewRunRecord } from "./review-domain.ts";
import {
	publishReviewPublication,
	type ReviewPublicationDependencies,
} from "./review-publication.ts";
import { getReviewReadiness } from "./review-readiness.ts";
import { ReviewStore } from "./review-store.ts";
/** Deliberately has no live layer until scoped GitHub transport and screening are verified. */
export class ReviewPublicationGateway extends Context.Service<
	ReviewPublicationGateway,
	{
		forRun(run: ReviewRunRecord): Promise<ReviewPublicationDependencies>;
	}
>()("api/ReviewPublicationGateway") {}
export const drainReviewPublicationOutbox = Effect.fn(
	"drainReviewPublicationOutbox",
)(function* () {
	if (
		!["codex", "claude"].some(
			(provider) => getReviewReadiness(provider).available,
		)
	)
		return { published: 0 };
	const store = yield* Effect.serviceOption(ReviewStore);
	const gateway = yield* Effect.serviceOption(ReviewPublicationGateway);
	if (Option.isNone(store) || Option.isNone(gateway)) return { published: 0 };
	const publications = yield* Effect.promise(() =>
		store.value.claimPublications(Date.now(), 20),
	);
	let published = 0;
	for (const publication of publications) {
		const run = yield* Effect.promise(() =>
			store.value.getRun(publication.runId),
		);
		if (!run || !getReviewReadiness(run.agentProvider).available) {
			yield* Effect.promise(() =>
				store.value.cancelPublication(
					publication.id,
					publication.leaseToken,
					Date.now(),
				),
			);
			continue;
		}
		const outcome = yield* Effect.tryPromise(() =>
			gateway.value
				.forRun(run)
				.then((deps) => publishReviewPublication(publication, run, deps)),
		).pipe(Effect.result);
		if (outcome._tag === "Failure" || outcome.success.kind === "ambiguous") {
			yield* Effect.promise(() =>
				store.value.finishPublication(
					publication.id,
					publication.leaseToken,
					null,
					Date.now(),
				),
			);
			continue;
		}
		if (outcome.success.kind === "delivered") {
			yield* Effect.promise(() =>
				store.value.finishPublication(
					publication.id,
					publication.leaseToken,
					outcome.success.kind === "delivered"
						? outcome.success.githubId
						: null,
					Date.now(),
				),
			);
			published++;
		} else
			yield* Effect.promise(() =>
				store.value.cancelPublication(
					publication.id,
					publication.leaseToken,
					Date.now(),
				),
			);
	}
	return { published };
});
