import { ReviewResult } from "@zuse/contracts";
import { Effect, Option, Schema } from "effect";
import { sha256Hex } from "./crypto.ts";
import { badRequest, serviceUnavailable, unauthorized } from "./errors.ts";
import { decodeBody } from "./http.ts";
import {
	reviewInstallationToken,
	verifyReviewRepository,
} from "./review-github.ts";
import { ReviewLifecycle } from "./review-lifecycle.ts";
import { ReviewLifecycleStore } from "./review-lifecycle-store.ts";
import { ReviewStore } from "./review-store.ts";

const ResultEnvelope = Schema.Struct({
	result: Schema.optional(ReviewResult),
	errorCode: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
	cleanupConfirmed: Schema.Boolean,
});
const io = <A>(f: () => Promise<A>) =>
	Effect.tryPromise({
		try: f,
		catch: () => serviceUnavailable("review_storage_unavailable"),
	});
/** A boot secret is bound to one attempt, immutable payer, native connection and deadline. */
export const routeReviewWorkerRequest = Effect.fn("routeReviewWorkerRequest")(
	function* (request: Request) {
		const match =
			/^\/v1\/review\/attempts\/([A-Za-z0-9_-]{1,256})\/(bootstrap|heartbeat|result)$/.exec(
				new URL(request.url).pathname,
			);
		if (!match?.[1]) return null;
		const attemptId = match[1];
		if (request.method !== "POST")
			return yield* badRequest("review_worker_method");
		const native = yield* Effect.serviceOption(ReviewLifecycleStore);
		const review = yield* Effect.serviceOption(ReviewStore);
		if (Option.isNone(native) || Option.isNone(review))
			return yield* serviceUnavailable("review_worker_unavailable");
		const store = native.value;
		const core = review.value;
		const token = /^Bearer ([a-f0-9]{64})$/.exec(
			request.headers.get("authorization") ?? "",
		)?.[1];
		if (!token) return yield* unauthorized("review_worker_unauthorized");
		const now = Date.now();
		const hash = yield* sha256Hex(token);
		const a = yield* io(() => store.authenticateAttempt(attemptId, hash, now));
		if (!a) return yield* unauthorized("review_worker_unauthorized");
		if (match[2] === "heartbeat") {
			const accepted = yield* io(() =>
				core.renewRun(a.runId, a.leaseToken, now),
			);
			if (accepted)
				yield* io(() =>
					store.updateAttempt(a.id, a.leaseToken, { heartbeatAtMs: now }),
				);
			return Response.json({
				continue: accepted,
				deadlineMs: a.lifecycle.deadlineMs,
			});
		}
		if (match[2] === "bootstrap") {
			const enrollment = (yield* io(() =>
				core.listEnrollments(a.ownerId),
			)).find((e) => e.id === a.run.enrollmentId);
			if (!enrollment?.enabled)
				return yield* unauthorized("review_worker_revoked");
			const proof = yield* verifyReviewRepository(
				enrollment.enabledBy,
				a.ownerId,
				a.run.repositoryId,
			);
			if (proof.installationId !== a.run.installationId)
				return yield* unauthorized("review_worker_revoked");
			const git = yield* reviewInstallationToken(
				proof.installationId,
				proof.repositoryId,
			);
			// Re-check after remote authorization to fence concurrent disable/revocation.
			if (!(yield* io(() => store.authenticateAttempt(a.id, hash, Date.now()))))
				return yield* unauthorized("review_worker_revoked");
			return Response.json({
				runId: a.runId,
				attemptId: a.id,
				connectionId: a.run.modelConnectionId,
				agentProvider: a.run.agentProvider,
				model: a.run.model,
				snapshot: {
					repositoryId: a.run.repositoryId,
					baseRef: a.run.baseRef,
					baseSha: a.run.baseSha,
					headSha: a.run.headSha,
				},
				repository: {
					cloneUrl: `https://github.com/${proof.repositoryFullName}.git`,
					token: git.token,
				},
				authHome: "/run/zuse-review-auth",
				deadlineMs: a.lifecycle.deadlineMs,
			});
		}
		const data = yield* decodeBody(ResultEnvelope, request, 1000000);
		if (data.result) {
			const s = data.result.snapshot;
			if (
				s.repositoryId !== a.run.repositoryId ||
				s.baseRef !== a.run.baseRef ||
				s.baseSha !== a.run.baseSha ||
				s.headSha !== a.run.headSha
			)
				return yield* badRequest("review_result_snapshot_mismatch");
		}
		if (a.lifecycle.resultReceived) return Response.json({ accepted: true });
		const accepted = yield* io(() =>
			store.updateAttempt(a.id, a.leaseToken, {
				pendingResult:
					data.cleanupConfirmed && data.result
						? { ...data.result, checks: undefined, checksReason: undefined }
						: undefined,
				resultReceived: true,
				cleanupConfirmed: data.cleanupConfirmed,
				errorCode: data.errorCode
					? [
							"review_reconnect_required",
							"review_quota_exhausted",
							"review_native_failed",
						].includes(data.errorCode)
						? data.errorCode
						: "review_worker_failed"
					: data.result
						? undefined
						: "review_result_missing",
				heartbeatAtMs: now,
			}),
		);
		const lifecycle = yield* Effect.serviceOption(ReviewLifecycle);
		if (accepted && Option.isSome(lifecycle))
			yield* io(() => lifecycle.value.park(a.id, Date.now()));
		return Response.json({ accepted });
	},
);
