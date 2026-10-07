import {
	ApiPaths,
	ReviewAvailability,
	ReviewEnrollment,
	ReviewEnrollmentList,
	type ReviewEnrollmentRequest,
	ReviewEnrollmentSetup,
	ReviewFixContext,
	type ReviewRequest,
	ReviewRun,
	ReviewRunPage,
} from "@zuse/contracts";
import type { Effect, Schema } from "effect";

export type ReviewControlRequest<E> = <A>(
	path: string,
	schema: Schema.Codec<A, unknown>,
	method?: string,
	body?: unknown,
) => Effect.Effect<A, E>;

/** Shared HTTP mapping for desktop and hosted clients; authentication stays in the transport. */
export const makeReviewControlClient = <E>(
	request: ReviewControlRequest<E>,
) => ({
	"review.coverage": () => request(ApiPaths.reviewCoverage, ReviewAvailability),
	"review.enrollments": () =>
		request(ApiPaths.reviewEnrollments, ReviewEnrollmentList),
	"review.enroll": (input: ReviewEnrollmentRequest) =>
		request(ApiPaths.reviewEnrollments, ReviewEnrollmentSetup, "POST", input),
	"review.disable": ({ id }: { id: string }) =>
		request(ApiPaths.reviewEnrollmentDisable(id), ReviewEnrollment, "POST", {}),
	"review.runs": ({ cursor }: { cursor?: string }) =>
		request(
			`${ApiPaths.reviewRuns}${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
			ReviewRunPage,
		),
	"review.get": ({ id }: { id: string }) =>
		request(ApiPaths.reviewRun(id), ReviewRun),
	"review.request": (input: ReviewRequest) =>
		request(ApiPaths.reviewRuns, ReviewRun, "POST", input),
	"review.cancel": ({ id }: { id: string }) =>
		request(ApiPaths.reviewRunCancel(id), ReviewRun, "POST", {}),
	"review.retry": ({ id }: { id: string }) =>
		request(ApiPaths.reviewRunRetry(id), ReviewRun, "POST", {}),
	"review.fixContext": ({ id }: { id: string }) =>
		request(ApiPaths.reviewFixContext(id), ReviewFixContext),
});
export type ReviewControlClient<E> = ReturnType<
	typeof makeReviewControlClient<E>
>;
