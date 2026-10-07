import {
	ReviewConnectionCreate,
	type ReviewEnrollment,
	ReviewEnrollmentRequest,
	type ReviewFixContext,
	ReviewRequest,
	type ReviewRun,
} from "@zuse/contracts";
import { Clock, Effect, Option, Schema } from "effect";
import { githubUserApiRequest } from "./cloud-github-user.ts";
import { ApiConfiguration } from "./config.ts";
import {
	badRequest,
	forbidden,
	notFound,
	serviceUnavailable,
} from "./errors.ts";
import { decodeBody, json } from "./http.ts";
import {
	REVIEW_POLICY,
	type ReviewEnrollmentRecord,
	type ReviewRunRecord,
} from "./review-domain.ts";
import {
	getReviewGithubIdentity,
	listReviewRepositories,
	verifyReviewRepository,
} from "./review-github.ts";
import {
	completeReviewConnection,
	createReviewConnection,
	getReviewConnection,
	getReviewSetupResources,
	loginReviewConnection,
	revokeReviewConnection,
} from "./review-lifecycle.ts";
import { ReviewLifecycleStore } from "./review-lifecycle-store.ts";
import { getReviewReadiness } from "./review-readiness.ts";
import { requestReview } from "./review-request.ts";
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
	const proof = yield* verifyReviewRepository(
		actorId,
		run.ownerId,
		run.repositoryId,
	);
	if (
		proof.repositoryFullName !== run.repositoryFullName ||
		proof.installationId !== run.installationId
	)
		return yield* forbidden("review_repository_reauthorization_required");
	const pull = yield* githubUserApiRequest(
		actorId,
		`/repos/${proof.repositoryFullName}/pulls/${run.pullNumber}`,
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
	const config = yield* ApiConfiguration;
	const noStore = (response: Response) => {
		response.headers.set("cache-control", "no-store");
		return response;
	};
	if (url.pathname === "/v1/review/setup" && read) {
		const identity = yield* getReviewGithubIdentity(
			access.actor.accountId,
		).pipe(Effect.catch(() => Effect.succeed(null)));
		const repositories = identity
			? yield* listReviewRepositories(access.actor.accountId, access.ownerId)
			: [];
		const resources = yield* getReviewSetupResources(
			access.ownerId,
			access.actor.accountId,
		);
		return noStore(
			json({
				...resources,
				repositories,
				identity,
				payer: {
					id: access.ownerId,
					label:
						access.scope.kind === "personal"
							? "Personal cloud account"
							: "Organization cloud account",
				},
			}),
		);
	}
	if (url.pathname === "/v1/review/connections" && request.method === "POST")
		return noStore(
			json(
				yield* createReviewConnection(
					access.ownerId,
					access.actor.accountId,
					yield* decodeBody(ReviewConnectionCreate, request, 4096),
				),
			),
		);
	const connectionMatch =
		/^\/v1\/review\/connections\/([a-zA-Z0-9_-]+)(?:\/(login|complete|revoke))?$/.exec(
			url.pathname,
		);
	if (connectionMatch) {
		const id = connectionMatch[1] ?? "";
		if (!connectionMatch[2] && read)
			return noStore(
				json(
					yield* getReviewConnection(
						access.ownerId,
						access.actor.accountId,
						id,
					),
				),
			);
		if (request.method === "POST") {
			if (connectionMatch[2] === "login")
				return noStore(
					json(
						yield* loginReviewConnection(
							access.ownerId,
							access.actor.accountId,
							id,
						),
					),
				);
			if (connectionMatch[2] === "revoke")
				return noStore(
					json(
						yield* revokeReviewConnection(
							access.ownerId,
							access.actor.accountId,
							id,
						),
					),
				);
			if (connectionMatch[2] === "complete") {
				const input = yield* decodeBody(
					Schema.Struct({
						callbackUrl: Schema.String.check(Schema.isMaxLength(4096)),
					}),
					request,
					8192,
				);
				return noStore(
					json(
						yield* completeReviewConnection(
							access.ownerId,
							access.actor.accountId,
							id,
							input.callbackUrl,
						),
					),
				);
			}
		}
	}
	if (url.pathname === "/v1/review/coverage" && read) {
		const providers = ["codex", "claude"].map((provider) =>
			getReviewReadiness(provider, config.review),
		);
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
		const eligibility = getReviewReadiness(body.agentProvider, config.review);
		if (!eligibility.available)
			return yield* serviceUnavailable("review_provider_verification_required");
		if (
			body.worker.maxRuntimeMs > REVIEW_POLICY.maxAllocatedMs ||
			body.worker.provider === "boxd"
		)
			return yield* badRequest("review_worker_not_eligible");
		const nativeOptional = yield* Effect.serviceOption(ReviewLifecycleStore);
		if (Option.isNone(nativeOptional))
			return yield* serviceUnavailable("review_native_unavailable");
		const nativeStore = nativeOptional.value;
		const connection = yield* storageCall(() =>
			nativeStore.getConnection(body.modelConnectionId),
		);
		if (
			!connection ||
			connection.ownerActorId !== access.actor.accountId ||
			connection.state !== "ready" ||
			connection.agentProvider !== body.agentProvider ||
			!connection.models.includes(body.model) ||
			connection.sandboxProvider !== body.worker.provider ||
			connection.size !== body.worker.size
		)
			return yield* forbidden("review_native_connection_required");
		const resources = yield* getReviewSetupResources(
			access.ownerId,
			access.actor.accountId,
		);
		if (
			!resources.placements.some(
				(p) =>
					p.provider === body.worker.provider &&
					p.size === body.worker.size &&
					p.available,
			)
		)
			return yield* badRequest("review_worker_not_eligible");
		const proof = yield* verifyReviewRepository(
			access.actor.accountId,
			access.ownerId,
			body.repositoryId,
		);
		if (body.kind === "shared" && !proof.admin)
			return yield* forbidden("review_repository_admin_required");
		const intent = {
			id: crypto.randomUUID(),
			actorId: access.actor.accountId,
			ownerId: access.ownerId,
			request: body,
			expiresAtMs: nowMs + 60000,
		};
		yield* storageCall(() => store.createAuthorization(intent));
		const enrollment = yield* storageCall(() =>
			store.completeAuthorization(intent.id, proof, nowMs),
		);
		return noStore(json(publicReviewEnrollment(enrollment), 201));
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
		const costs = yield* storageCall(() =>
			store.getRunCosts(
				access.ownerId,
				rows.slice(0, 50).map((row) => row.id),
			),
		);
		return noStore(
			json({
				items: rows
					.slice(0, 50)
					.map((row) => ({ ...publicReviewRun(row), ...costs[row.id] })),
				...(rows.length > 50 ? { nextCursor: rows[49]?.id } : {}),
			}),
		);
	}
	if (url.pathname === "/v1/review/runs" && request.method === "POST") {
		const input = yield* decodeBody(ReviewRequest, request, 8192);
		return noStore(
			json(
				publicReviewRun(
					yield* requestReview(
						access.ownerId,
						access.actor.accountId,
						input,
					).pipe(Effect.provideService(ReviewStore, store)),
				),
				202,
			),
		);
	}
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
			const costs = yield* storageCall(() =>
				store.getRunCosts(access.ownerId, [run.id]),
			);
			return noStore(
				json({
					...publicReviewRun(run, Boolean(run.result)),
					...costs[run.id],
				}),
			);
		}
		if (match[2] === "cancel" && request.method === "POST") {
			yield* storageCall(() => store.cancelRun(access.ownerId, id, nowMs));
			const cancelled = yield* storageCall(() => store.getRun(id));
			if (!cancelled) return yield* notFound("review_run_not_found");
			return noStore(json(publicReviewRun(cancelled)));
		}
		if (match[2] === "retry" && request.method === "POST") {
			return noStore(
				json(
					publicReviewRun(
						yield* requestReview(access.ownerId, access.actor.accountId, {
							repositoryId: run.repositoryId,
							pullNumber: run.pullNumber,
						}).pipe(Effect.provideService(ReviewStore, store)),
					),
					202,
				),
			);
		}
	}
	return yield* notFound("review_route_not_found");
});
