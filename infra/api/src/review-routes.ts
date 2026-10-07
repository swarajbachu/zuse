import {
	type ReviewEnrollment,
	ReviewEnrollmentRequest,
	type ReviewFixContext,
	type ReviewRun,
} from "@zuse/contracts";
import { Clock, Effect, Option, Schema } from "effect";
import { ApiConfiguration } from "./config.ts";
import {
	badRequest,
	forbidden,
	notFound,
	serviceUnavailable,
} from "./errors.ts";
import { githubRequest } from "./github-transport.ts";
import { decodeBody, json } from "./http.ts";
import {
	REVIEW_POLICY,
	type ReviewEnrollmentRecord,
	type ReviewRunRecord,
} from "./review-domain.ts";
import {
	REVIEW_OAUTH_PREFIX,
	reviewAuthorizationUrl,
	reviewInstallationToken,
} from "./review-github.ts";
import { getReviewReadiness } from "./review-readiness.ts";
import { ReviewStore, type ReviewStoreApi } from "./review-store.ts";
import { requireWorkspaceAccess } from "./workspace-authorization.ts";
export const publicReviewEnrollment = (
	record: ReviewEnrollmentRecord,
): ReviewEnrollment => {
	const { enabledBy: _enabledBy, githubUserId, ...rest } = record;
	return { ...rest, ...(githubUserId === null ? {} : { githubUserId }) };
};
export const publicReviewRun = (
	record: ReviewRunRecord,
	includeResult = false,
): ReviewRun => {
	const {
		installationId: _installation,
		authorGithubUserId: _author,
		fork: _fork,
		configVersion: _config,
		generation: _generation,
		mergeBaseSha,
		blockedReason,
		result,
		...rest
	} = record;
	return {
		...rest,
		...(mergeBaseSha === null ? {} : { mergeBaseSha }),
		...(blockedReason === null ? {} : { blockedReason }),
		...(includeResult && result ? { result } : {}),
	};
};
const storageCall = <A>(operation: () => Promise<A>) =>
	Effect.tryPromise({
		try: operation,
		catch: () => serviceUnavailable("review_storage_unavailable"),
	});
/** GitHub content access is checked independently of who sponsored the review. */
const fixContext = Effect.fn("reviewFixContext")(function* (
	store: ReviewStoreApi,
	run: ReviewRunRecord,
	actorId: string,
) {
	if (!(yield* storageCall(() => store.canReadRunArtifacts(run.id))))
		return yield* forbidden("review_artifact_access_revoked");
	const identity = yield* storageCall(() => store.getGithubIdentity(actorId));
	if (identity === null)
		return yield* forbidden("review_github_identity_required");
	const grant = yield* reviewInstallationToken(
		run.installationId,
		run.repositoryId,
	);
	const repository = yield* githubRequest<unknown>(
		`https://api.github.com/repositories/${run.repositoryId}`,
		grant.token,
	).pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(
				Schema.Struct({
					id: Schema.Number,
					full_name: Schema.String,
					private: Schema.Boolean,
				}),
			),
		),
		Effect.mapError(() => forbidden("review_repository_access_required")),
	);
	if (
		repository.id !== run.repositoryId ||
		repository.full_name !== run.repositoryFullName
	)
		return yield* forbidden("review_repository_reauthorization_required");
	if (repository.private) {
		const user = yield* githubRequest<unknown>(
			`https://api.github.com/user/${identity}`,
			grant.token,
		).pipe(
			Effect.flatMap(
				Schema.decodeUnknownEffect(
					Schema.Struct({ id: Schema.Number, login: Schema.String }),
				),
			),
			Effect.mapError(() => forbidden("review_repository_access_required")),
		);
		if (user.id !== identity)
			return yield* forbidden("review_repository_access_required");
		const permission = yield* githubRequest<{ permission: string }>(
			`https://api.github.com/repos/${repository.full_name}/collaborators/${encodeURIComponent(user.login)}/permission`,
			grant.token,
		);
		if (!["read", "write", "admin"].includes(permission.permission))
			return yield* forbidden("review_repository_access_required");
	}
	const pull = yield* githubRequest<unknown>(
		`https://api.github.com/repos/${repository.full_name}/pulls/${run.pullNumber}`,
		grant.token,
	).pipe(
		Effect.flatMap(
			Schema.decodeUnknownEffect(
				Schema.Struct({ head: Schema.Struct({ sha: Schema.String }) }),
			),
		),
		Effect.mapError(() => forbidden("review_repository_access_required")),
	);
	if (!run.result || !run.mergeBaseSha)
		return yield* badRequest("review_results_unavailable");
	return {
		runId: run.id,
		repositoryId: run.repositoryId,
		repositoryFullName: run.repositoryFullName,
		pullNumber: run.pullNumber,
		snapshot: run.result.snapshot,
		findings: run.result.findings,
		currentHeadSha: pull.head.sha,
	} satisfies ReviewFixContext;
});
export const routeReviewRequest = Effect.fn("routeReviewRequest")(function* (
	request: Request,
) {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/v1/review/")) return null;
	const read = request.method === "GET";
	const access = yield* requireWorkspaceAccess(
		request,
		read ? "content" : "administration",
	);
	const optional = yield* Effect.serviceOption(ReviewStore);
	const nowMs = yield* Clock.currentTimeMillis;
	const noStore = (response: Response) => {
		response.headers.set("cache-control", "no-store");
		return response;
	};
	if (url.pathname === "/v1/review/coverage" && read) {
		const providers = ["codex", "claude"].map(getReviewReadiness);
		const enrollments = Option.isSome(optional)
			? yield* storageCall(() => optional.value.listEnrollments(access.ownerId))
			: [];
		return noStore(
			json({
				available: providers.some((p) => p.available),
				reason: "provider_verification_required",
				providers,
				enrollments: enrollments.map(publicReviewEnrollment),
			}),
		);
	}
	if (Option.isNone(optional))
		return yield* serviceUnavailable("review_storage_unavailable");
	const store = optional.value;
	if (url.pathname === "/v1/review/enrollments" && read)
		return noStore(
			json({
				items: (yield* storageCall(() =>
					store.listEnrollments(access.ownerId),
				)).map(publicReviewEnrollment),
			}),
		);
	if (url.pathname === "/v1/review/enrollments" && request.method === "POST") {
		const body = yield* decodeBody(ReviewEnrollmentRequest, request, 16384);
		const eligibility = getReviewReadiness(body.agentProvider);
		if (!eligibility.available)
			return yield* serviceUnavailable("review_provider_verification_required");
		if (
			body.worker.maxRuntimeMs > REVIEW_POLICY.maxAllocatedMs ||
			body.worker.provider === "boxd"
		)
			return yield* badRequest("review_worker_not_eligible");
		const config = yield* ApiConfiguration;
		const intent = {
			id: `${REVIEW_OAUTH_PREFIX}${crypto.randomUUID()}`,
			actorId: access.actor.accountId,
			ownerId: access.ownerId,
			request: body,
			expiresAtMs: nowMs + 600000,
		};
		yield* storageCall(() => store.createAuthorization(intent));
		return noStore(
			json(
				{
					authorizationUrl: reviewAuthorizationUrl(
						intent,
						config.publicApiOrigin ?? config.apiIssuer,
					),
				},
				202,
			),
		);
	}
	const disable = /^\/v1\/review\/enrollments\/([a-zA-Z0-9_-]+)\/disable$/.exec(
		url.pathname,
	);
	if (disable && request.method === "POST") {
		if (
			!(yield* storageCall(() =>
				store.disableEnrollment(access.ownerId, disable[1] ?? "", nowMs),
			))
		)
			return yield* notFound("review_enrollment_not_found");
		const enrollment = (yield* storageCall(() =>
			store.listEnrollments(access.ownerId),
		)).find((e) => e.id === disable[1]);
		if (!enrollment) return yield* notFound("review_enrollment_not_found");
		return noStore(json(publicReviewEnrollment(enrollment)));
	}
	if (url.pathname === "/v1/review/runs" && read) {
		const cursor = url.searchParams.get("cursor") ?? undefined;
		if (cursor && !/^[a-zA-Z0-9_-]{1,256}$/.test(cursor))
			return yield* badRequest("review_invalid_cursor");
		const rows = yield* storageCall(() =>
			store.listRuns(access.ownerId, cursor, 51),
		);
		return noStore(
			json({
				items: rows.slice(0, 50).map((row) => publicReviewRun(row)),
				...(rows.length > 50 ? { nextCursor: rows[49]?.id } : {}),
			}),
		);
	}
	if (url.pathname === "/v1/review/runs" && request.method === "POST")
		return yield* serviceUnavailable("review_provider_verification_required");
	const match =
		/^\/v1\/review\/runs\/([a-zA-Z0-9_-]+)(?:\/(cancel|retry|fix-context))?$/.exec(
			url.pathname,
		);
	if (match) {
		const id = match[1] ?? "";
		const run = yield* storageCall(() => store.getRun(id));
		if (!run) return yield* notFound("review_run_not_found");
		if (match[2] === "fix-context" && read)
			return noStore(
				json(yield* fixContext(store, run, access.actor.accountId)),
			);
		if (run.ownerId !== access.ownerId)
			return yield* notFound("review_run_not_found");
		if (!match[2] && read) {
			if (run.result) yield* fixContext(store, run, access.actor.accountId);
			return noStore(json(publicReviewRun(run, Boolean(run.result))));
		}
		if (match[2] === "cancel" && request.method === "POST") {
			yield* storageCall(() => store.cancelRun(access.ownerId, id, nowMs));
			const cancelled = yield* storageCall(() => store.getRun(id));
			if (!cancelled) return yield* notFound("review_run_not_found");
			return noStore(json(publicReviewRun(cancelled)));
		}
		if (match[2] === "retry" && request.method === "POST") {
			// A rerun must resolve current GitHub comparison before selecting a new payer.
			return yield* serviceUnavailable("review_provider_verification_required");
		}
	}
	return yield* notFound("review_route_not_found");
});
