import type { ReviewEnrollmentRequest, ReviewResult } from "@zuse/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	REVIEW_POLICY,
	type ReviewComparison,
	type ReviewEnrollmentRecord,
	type ReviewRunRecord,
	reviewComparisonKey,
	reviewMarker,
	selectReviewEnrollment,
} from "./review-domain.ts";

export interface ReviewAuthorization {
	id: string;
	actorId: string;
	ownerId: string;
	request: ReviewEnrollmentRequest;
	expiresAtMs: number;
}
/** Only the GitHub OAuth verifier produces this proof; never decode it from an HTTP body. */
export interface VerifiedReviewRepository {
	githubUserId: number;
	repositoryId: number;
	repositoryFullName: string;
	installationId: number;
	admin: boolean;
}
export interface ReviewInboxEntry {
	deliveryId: string;
	repositoryId: number;
	event: "pull_request" | "push";
	payload: unknown;
	receivedAtMs: number;
	leaseToken: string;
}
export interface ReviewPublication {
	id: string;
	runId: string;
	marker: string;
	payload: unknown;
	state: "pending" | "reconcile";
	githubId: string | null;
	mayCreate: boolean;
	leaseToken: string;
}
export interface ReviewStoreApi {
	/** Gross compute value with period markup, before included allowance; not an invoice charge. */
	getRunCosts(
		ownerId: string,
		runIds: readonly string[],
	): Promise<
		Record<string, { estimatedCostMicros?: number; settledCostMicros?: number }>
	>;
	publicationIsCurrent(
		id: string,
		leaseToken: string,
		nowMs: number,
	): Promise<boolean>;
	approveFork(
		repositoryId: number,
		pullNumber: number,
		headSha: string,
		actorId: string,
		nowMs: number,
	): Promise<void>;
	checkForkApproved(
		repositoryId: number,
		pullNumber: number,
		headSha: string,
	): Promise<boolean>;
	claimRepositoryRefresh(
		repositoryId: number,
		nowMs: number,
	): Promise<string | null>;
	renewRepositoryRefresh(
		repositoryId: number,
		token: string,
		nowMs: number,
	): Promise<boolean>;
	releaseRepositoryRefresh(repositoryId: number, token: string): Promise<void>;
	getGithubIdentity(actorId: string): Promise<number | null>;
	listEnrollments(ownerId: string): Promise<ReviewEnrollmentRecord[]>;
	createAuthorization(authorization: ReviewAuthorization): Promise<void>;
	getAuthorization(
		id: string,
		nowMs: number,
	): Promise<ReviewAuthorization | null>;
	completeAuthorization(
		id: string,
		proof: VerifiedReviewRepository,
		nowMs: number,
	): Promise<ReviewEnrollmentRecord>;
	disableEnrollment(
		ownerId: string,
		id: string,
		nowMs: number,
	): Promise<boolean>;
	enqueueEvent(
		deliveryId: string,
		repositoryId: number,
		event: "pull_request" | "push",
		payload: unknown,
		nowMs: number,
	): Promise<boolean>;
	claimEvents(nowMs: number, limit: number): Promise<ReviewInboxEntry[]>;
	finishEvent(
		deliveryId: string,
		leaseToken: string,
		nowMs: number,
		errorCode?: string,
	): Promise<void>;
	createRun(
		comparison: ReviewComparison,
		nowMs: number,
		generation?: string,
		refreshToken?: string,
		authorizedOwnerId?: string,
	): Promise<ReviewRunRecord | null>;
	listRuns(
		ownerId: string,
		cursor: string | undefined,
		limit: number,
	): Promise<ReviewRunRecord[]>;
	getRun(id: string): Promise<ReviewRunRecord | null>;
	canReadRunArtifacts(id: string): Promise<boolean>;
	dueRunIds(nowMs: number, limit: number): Promise<string[]>;
	renewRun(id: string, leaseToken: string, nowMs: number): Promise<boolean>;
	cancelRun(ownerId: string, id: string, nowMs: number): Promise<boolean>;
	closePull(
		repositoryId: number,
		pullNumber: number,
		nowMs: number,
	): Promise<void>;
	suspendInstallation(installationId: number, nowMs: number): Promise<void>;
	getBillingResource(
		provider: string,
		attemptId: string,
	): Promise<{ accountId: string; providerSandboxId: string | null } | null>;
	claimRun(
		id: string,
		nowMs: number,
	): Promise<{ run: ReviewRunRecord; leaseToken: string } | null>;
	blockRun(
		id: string,
		leaseToken: string,
		reason: string,
		nowMs: number,
	): Promise<void>;
	recordAttempt(input: {
		id: string;
		runId: string;
		leaseToken: string;
		provider: string;
		maximumLifetimeMs: number;
		nowMs: number;
	}): Promise<boolean>;
	attachSandbox(
		attemptId: string,
		leaseToken: string,
		sandboxId: string,
		nowMs: number,
	): Promise<boolean>;
	stopAttempt(
		attemptId: string,
		leaseToken: string,
		nowMs: number,
	): Promise<boolean>;
	acceptResult(
		runId: string,
		leaseToken: string,
		result: ReviewResult,
		nowMs: number,
	): Promise<boolean>;
	claimPublications(nowMs: number, limit: number): Promise<ReviewPublication[]>;
	cancelPublication(
		id: string,
		leaseToken: string,
		nowMs: number,
	): Promise<void>;
	finishPublication(
		id: string,
		leaseToken: string,
		githubId: string | null,
		nowMs: number,
		disposition?: "ambiguous" | "unwritten" | "superseded",
	): Promise<void>;
}
export class ReviewStore extends Context.Service<ReviewStore, ReviewStoreApi>()(
	"api/ReviewStore",
) {}
interface EnrollmentRow {
	id: string;
	repository_id: string | number;
	repository_full_name: string;
	installation_id: string | number;
	kind: "personal" | "shared";
	github_user_id: string | number | null;
	owner_id: string;
	enabled_by: string;
	model_connection_id: string;
	settings: Pick<ReviewEnrollmentRequest, "agentProvider" | "model" | "worker">;
	enabled: boolean;
	version: number;
	created_at_ms: string | number;
	updated_at_ms: string | number;
}
const enrollmentFromRow = (r: EnrollmentRow): ReviewEnrollmentRecord => ({
	id: r.id,
	repositoryId: Number(r.repository_id),
	repositoryFullName: r.repository_full_name,
	installationId: Number(r.installation_id),
	kind: r.kind,
	githubUserId: r.github_user_id === null ? null : Number(r.github_user_id),
	ownerId: r.owner_id,
	enabledBy: r.enabled_by,
	modelConnectionId: r.model_connection_id,
	...r.settings,
	enabled: r.enabled,
	version: r.version,
	createdAtMs: Number(r.created_at_ms),
	updatedAtMs: Number(r.updated_at_ms),
});
interface RunRow {
	snapshot: ReviewRunRecord;
	state: ReviewRunRecord["state"];
	blocked_reason: string | null;
	updated_at_ms: string | number;
}
const runFromRow = (r: RunRow): ReviewRunRecord => ({
	...r.snapshot,
	state: r.state,
	blockedReason: r.blocked_reason,
	updatedAtMs: Number(r.updated_at_ms),
});
export const ReviewStorePg = Layer.effect(
	ReviewStore,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const run = <A>(effect: Effect.Effect<A, unknown>) =>
			Effect.runPromise(effect);
		const lock = (repositoryId: number) =>
			sql`SELECT pg_advisory_xact_lock(hashtextextended(${`review-repository:${repositoryId}`},0))`;
		const cancelEnrollmentRuns = (id: string, nowMs: number) =>
			Effect.gen(function* () {
				yield* sql`UPDATE api_review_runs SET state='cancelled',blocked_reason='enrollment_disabled',updated_at_ms=${nowMs},lease_token=NULL,lease_expires_at_ms=NULL WHERE enrollment_id=${id} AND state IN ('queued','blocked','provisioning','reviewing','publishing')`;
				yield* sql`UPDATE api_review_publications SET state='cancelled',lease_token=NULL,lease_expires_at_ms=NULL WHERE run_id IN (SELECT id FROM api_review_runs WHERE enrollment_id=${id}) AND state IN ('pending','reconcile')`;
			});
		const getRun = (id: string) =>
			run(
				sql<RunRow>`SELECT snapshot,state,blocked_reason,updated_at_ms FROM api_review_runs WHERE id=${id}`,
			).then((rows) => (rows[0] ? runFromRow(rows[0]) : null));
		const api: ReviewStoreApi = {
			publicationIsCurrent: (id, token, nowMs) =>
				run(
					sql`SELECT p.id FROM api_review_publications p JOIN api_review_runs r ON r.id=p.run_id JOIN api_review_enrollments e ON e.id=r.enrollment_id WHERE p.id=${id} AND p.lease_token=${token} AND p.lease_expires_at_ms>${nowMs} AND p.state='reconcile' AND r.state='publishing' AND e.enabled AND e.version=r.enrollment_version`,
				).then((rows) => rows.length > 0),
			approveFork: (repo, pull, sha, actor, nowMs) =>
				run(
					sql`INSERT INTO api_review_fork_approvals(repository_id,pull_number,head_sha,actor_id,created_at_ms) VALUES(${repo},${pull},${sha},${actor},${nowMs}) ON CONFLICT(repository_id,pull_number,head_sha) DO NOTHING`,
				).then(() => undefined),
			checkForkApproved: (repo, pull, sha) =>
				run(
					sql`SELECT head_sha FROM api_review_fork_approvals WHERE repository_id=${repo} AND pull_number=${pull} AND head_sha=${sha}`,
				).then((rows) => rows.length > 0),
			claimRepositoryRefresh: (id, nowMs) => {
				const token = crypto.randomUUID();
				return run(
					sql`INSERT INTO api_review_repository_leases(repository_id,token,expires_at_ms) VALUES(${id},${token},${nowMs + 300000}) ON CONFLICT(repository_id) DO UPDATE SET token=excluded.token,expires_at_ms=excluded.expires_at_ms WHERE api_review_repository_leases.expires_at_ms<=${nowMs} RETURNING token`,
				).then((rows) => (rows.length ? token : null));
			},
			renewRepositoryRefresh: (id, token, nowMs) =>
				run(
					sql`UPDATE api_review_repository_leases SET expires_at_ms=${nowMs + 300000} WHERE repository_id=${id} AND token=${token} AND expires_at_ms>${nowMs} RETURNING token`,
				).then((rows) => rows.length > 0),
			releaseRepositoryRefresh: (id, token) =>
				run(
					sql`DELETE FROM api_review_repository_leases WHERE repository_id=${id} AND token=${token}`,
				).then(() => undefined),
			getGithubIdentity: (actorId) =>
				run(
					sql<{
						github_user_id: string;
					}>`SELECT github_user_id FROM api_review_github_identities WHERE actor_id=${actorId}`,
				).then((rows) => (rows[0] ? Number(rows[0].github_user_id) : null)),
			listEnrollments: (ownerId) =>
				run(
					sql<EnrollmentRow>`SELECT * FROM api_review_enrollments WHERE owner_id=${ownerId} ORDER BY created_at_ms,id LIMIT 500`,
				).then((rows) => rows.map(enrollmentFromRow)),
			createAuthorization: (authorization) =>
				run(
					sql`INSERT INTO api_review_authorizations(id,actor_id,owner_id,repository_full_name,kind,model_connection_id,expires_at_ms,request) VALUES(${authorization.id},${authorization.actorId},${authorization.ownerId},'',${authorization.request.kind},${authorization.request.modelConnectionId},${authorization.expiresAtMs},${JSON.stringify(authorization.request)}::jsonb)`,
				).then(() => undefined),
			getAuthorization: (id, nowMs) =>
				run(
					sql<{
						id: string;
						actor_id: string;
						owner_id: string;
						request: ReviewEnrollmentRequest;
						expires_at_ms: string;
					}>`SELECT id,actor_id,owner_id,request,expires_at_ms FROM api_review_authorizations WHERE id=${id} AND consumed_at_ms IS NULL AND expires_at_ms>${nowMs}`,
				).then((rows) =>
					rows[0]
						? {
								id: rows[0].id,
								actorId: rows[0].actor_id,
								ownerId: rows[0].owner_id,
								request: rows[0].request,
								expiresAtMs: Number(rows[0].expires_at_ms),
							}
						: null,
				),
			completeAuthorization: (id, proof, nowMs) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							const auths = yield* sql<{
								actor_id: string;
								owner_id: string;
								request: ReviewEnrollmentRequest;
							}>`SELECT actor_id,owner_id,request FROM api_review_authorizations WHERE id=${id} AND consumed_at_ms IS NULL AND expires_at_ms>${nowMs} FOR UPDATE`;
							const auth = auths[0];
							if (!auth || auth.request.repositoryId !== proof.repositoryId)
								return yield* Effect.fail(
									new Error("review_authorization_expired"),
								);
							if (auth.request.kind === "shared" && !proof.admin)
								return yield* Effect.fail(
									new Error("review_repository_admin_required"),
								);
							yield* lock(proof.repositoryId);
							const prior = yield* sql<{
								github_user_id: string;
							}>`SELECT github_user_id FROM api_review_github_identities WHERE actor_id=${auth.actor_id}`;
							if (
								prior[0] &&
								Number(prior[0].github_user_id) !== proof.githubUserId
							)
								return yield* Effect.fail(
									new Error("review_identity_transfer_required"),
								);
							yield* sql`INSERT INTO api_review_github_identities(actor_id,github_user_id,verified_at_ms) VALUES(${auth.actor_id},${proof.githubUserId},${nowMs}) ON CONFLICT(actor_id) DO UPDATE SET verified_at_ms=excluded.verified_at_ms`;
							const previous = yield* sql<{
								id: string;
								version: number;
								created_at_ms: string;
							}>`SELECT id,version,created_at_ms FROM api_review_enrollments WHERE repository_id=${proof.repositoryId} AND kind=${auth.request.kind} AND owner_id=${auth.owner_id} AND enabled_by=${auth.actor_id} AND (github_user_id IS NOT DISTINCT FROM ${auth.request.kind === "personal" ? proof.githubUserId : null}::bigint) ORDER BY updated_at_ms DESC LIMIT 1`;
							const e: ReviewEnrollmentRecord = {
								id: previous[0]?.id ?? crypto.randomUUID(),
								repositoryId: proof.repositoryId,
								repositoryFullName: proof.repositoryFullName,
								installationId: proof.installationId,
								kind: auth.request.kind,
								githubUserId:
									auth.request.kind === "personal" ? proof.githubUserId : null,
								ownerId: auth.owner_id,
								enabledBy: auth.actor_id,
								modelConnectionId: auth.request.modelConnectionId,
								agentProvider: auth.request.agentProvider,
								model: auth.request.model,
								worker: auth.request.worker,
								enabled: true,
								version: (previous[0]?.version ?? 0) + 1,
								createdAtMs: previous[0]
									? Number(previous[0].created_at_ms)
									: nowMs,
								updatedAtMs: nowMs,
							};
							if (previous[0]) yield* cancelEnrollmentRuns(e.id, nowMs);
							yield* sql`INSERT INTO api_review_enrollments(id,repository_id,repository_full_name,installation_id,kind,github_user_id,owner_id,enabled_by,model_connection_id,settings,enabled,version,created_at_ms,updated_at_ms) VALUES(${e.id},${e.repositoryId},${e.repositoryFullName},${e.installationId},${e.kind},${e.githubUserId},${e.ownerId},${e.enabledBy},${e.modelConnectionId},${JSON.stringify({ agentProvider: e.agentProvider, model: e.model, worker: e.worker })}::jsonb,true,${e.version},${e.createdAtMs},${nowMs}) ON CONFLICT(id) DO UPDATE SET repository_full_name=excluded.repository_full_name,installation_id=excluded.installation_id,model_connection_id=excluded.model_connection_id,settings=excluded.settings,enabled=true,version=excluded.version,updated_at_ms=excluded.updated_at_ms`;
							yield* sql`UPDATE api_review_authorizations SET consumed_at_ms=${nowMs} WHERE id=${id}`;
							return e;
						}),
					),
				),
			disableEnrollment: (ownerId, id, nowMs) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							const rows = yield* sql<{
								repository_id: string;
							}>`SELECT repository_id FROM api_review_enrollments WHERE id=${id} AND owner_id=${ownerId}`;
							if (!rows[0]) return false;
							yield* lock(Number(rows[0].repository_id));
							yield* sql`UPDATE api_review_enrollments SET enabled=false,version=version+1,updated_at_ms=${nowMs} WHERE id=${id} AND owner_id=${ownerId} AND enabled`;
							yield* cancelEnrollmentRuns(id, nowMs);
							return true;
						}),
					),
				),
			enqueueEvent: (deliveryId, repositoryId, event, payload, nowMs) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* lock(repositoryId);
							const inserted =
								yield* sql`INSERT INTO api_review_inbox(delivery_id,repository_id,event,payload,received_at_ms,available_at_ms) SELECT ${deliveryId},${repositoryId},${event},${JSON.stringify(payload)}::jsonb,${nowMs},${nowMs + REVIEW_POLICY.debounceMs} WHERE EXISTS(SELECT 1 FROM api_review_enrollments WHERE repository_id=${repositoryId} AND enabled) ON CONFLICT(delivery_id) DO NOTHING RETURNING delivery_id`;
							if (!inserted.length) return false;
							const earlier = yield* sql<{
								delivery_id: string;
								received_at_ms: string;
							}>`SELECT delivery_id,received_at_ms FROM api_review_inbox WHERE repository_id=${repositoryId} AND event=${event} AND payload=${JSON.stringify(payload)}::jsonb AND processed_at_ms IS NULL AND lease_token IS NULL AND delivery_id<>${deliveryId} ORDER BY received_at_ms,delivery_id LIMIT 1 FOR UPDATE`;
							if (earlier[0]) {
								const due = Math.min(
									nowMs + REVIEW_POLICY.debounceMs,
									Number(earlier[0].received_at_ms) +
										REVIEW_POLICY.maxDebounceMs,
								);
								yield* sql`UPDATE api_review_inbox SET available_at_ms=${due} WHERE delivery_id=${earlier[0].delivery_id}`;
								yield* sql`UPDATE api_review_inbox SET processed_at_ms=${nowMs},error_code='coalesced' WHERE delivery_id=${deliveryId}`;
							}
							return true;
						}),
					),
				),
			claimEvents: (nowMs, limit) =>
				run(
					sql<{
						delivery_id: string;
						repository_id: string;
						event: "pull_request" | "push";
						payload: unknown;
						received_at_ms: string;
						lease_token: string;
					}>`WITH due AS (SELECT delivery_id FROM api_review_inbox WHERE processed_at_ms IS NULL AND available_at_ms<=${nowMs} AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms<=${nowMs}) ORDER BY available_at_ms,delivery_id FOR UPDATE SKIP LOCKED LIMIT ${Math.min(100, limit)}) UPDATE api_review_inbox i SET lease_token=${crypto.randomUUID()},lease_expires_at_ms=${nowMs + 60000} FROM due WHERE i.delivery_id=due.delivery_id RETURNING i.*`,
				).then((rows) =>
					rows.map((r) => ({
						deliveryId: r.delivery_id,
						repositoryId: Number(r.repository_id),
						event: r.event,
						payload: r.payload,
						receivedAtMs: Number(r.received_at_ms),
						leaseToken: r.lease_token,
					})),
				),
			finishEvent: (id, token, nowMs, errorCode) =>
				run(
					sql`UPDATE api_review_inbox SET processed_at_ms=${errorCode ? null : nowMs},error_code=${errorCode ?? null},available_at_ms=${nowMs + 60000},lease_token=NULL,lease_expires_at_ms=NULL WHERE delivery_id=${id} AND lease_token=${token} AND lease_expires_at_ms>${nowMs}`,
				).then(() => undefined),
			createRun: (
				comparison,
				nowMs,
				generation = "automatic",
				refreshToken,
				authorizedOwnerId,
			) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* lock(comparison.repositoryId);
							const refresh =
								yield* sql`SELECT token FROM api_review_repository_leases WHERE repository_id=${comparison.repositoryId} AND token=${refreshToken ?? null} AND expires_at_ms>${nowMs} FOR UPDATE`;
							if (!refresh.length)
								return yield* Effect.fail(
									new Error("review_refresh_lease_lost"),
								);
							const enrollments =
								yield* sql<EnrollmentRow>`SELECT * FROM api_review_enrollments WHERE repository_id=${comparison.repositoryId} AND enabled`;
							const e = selectReviewEnrollment(
								enrollments.map(enrollmentFromRow),
								comparison.authorGithubUserId,
							);
							if (
								!e ||
								(authorizedOwnerId !== undefined &&
									e.ownerId !== authorizedOwnerId)
							)
								return null;
							if (e.installationId !== comparison.installationId) return null;
							const key = reviewComparisonKey(
								comparison,
								REVIEW_POLICY.configVersion,
								generation,
							);
							const prior =
								yield* sql<RunRow>`SELECT snapshot,state,blocked_reason,updated_at_ms FROM api_review_runs WHERE comparison_key=${key}`;
							if (prior[0]) return runFromRow(prior[0]);
							yield* sql`UPDATE api_review_runs SET state='superseded',updated_at_ms=${nowMs},lease_token=NULL,lease_expires_at_ms=NULL WHERE repository_id=${comparison.repositoryId} AND pull_number=${comparison.pullNumber} AND state IN ('queued','blocked','provisioning','reviewing','publishing')`;
							const r: ReviewRunRecord = {
								...comparison,
								id: crypto.randomUUID(),
								enrollmentId: e.id,
								enrollmentVersion: e.version,
								ownerId: e.ownerId,
								modelConnectionId: e.modelConnectionId,
								agentProvider: e.agentProvider,
								model: e.model,
								worker: e.worker,
								mergeBaseSha: null,
								configVersion: REVIEW_POLICY.configVersion,
								generation,
								state: "queued",
								blockedReason: null,
								createdAtMs: nowMs,
								updatedAtMs: nowMs,
							};
							yield* sql`INSERT INTO api_review_runs(id,comparison_key,repository_id,pull_number,owner_id,enrollment_id,enrollment_version,model_connection_id,snapshot,state,created_at_ms,updated_at_ms) VALUES(${r.id},${key},${r.repositoryId},${r.pullNumber},${r.ownerId},${r.enrollmentId},${r.enrollmentVersion},${r.modelConnectionId},${JSON.stringify(r)}::jsonb,'queued',${nowMs},${nowMs})`;
							return r;
						}),
					),
				),
			listRuns: (ownerId, cursor, limit) =>
				run(
					sql<RunRow>`SELECT snapshot,state,blocked_reason,updated_at_ms FROM api_review_runs WHERE owner_id=${ownerId} AND (${cursor ?? null}::text IS NULL OR (created_at_ms,id)<(SELECT created_at_ms,id FROM api_review_runs WHERE id=${cursor ?? null} AND owner_id=${ownerId})) ORDER BY created_at_ms DESC,id DESC LIMIT ${Math.min(101, limit)}`,
				).then((rows) => rows.map(runFromRow)),
			getRun,
			canReadRunArtifacts: (id) =>
				run(
					sql`SELECT r.id FROM api_review_runs r JOIN api_review_enrollments e ON e.id=r.enrollment_id WHERE r.id=${id} AND e.enabled AND e.version=r.enrollment_version`,
				).then((rows) => rows.length > 0),
			dueRunIds: (nowMs, limit) =>
				run(
					sql<{
						id: string;
					}>`SELECT id FROM api_review_runs WHERE state='queued' AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms<=${nowMs}) ORDER BY created_at_ms,id LIMIT ${Math.min(limit, 100)}`,
				).then((rows) => rows.map((r) => r.id)),
			renewRun: (id, token, nowMs) =>
				run(
					sql`UPDATE api_review_runs r SET lease_expires_at_ms=${nowMs + 60000} WHERE r.id=${id} AND r.lease_token=${token} AND (r.lease_expires_at_ms>${nowMs} OR EXISTS(SELECT 1 FROM api_review_attempts a WHERE a.run_id=r.id AND a.lease_token=${token} AND a.stopped_at_ms IS NOT NULL AND a.lifecycle->>'stage'='checking')) AND r.state IN ('queued','provisioning','reviewing') AND EXISTS(SELECT 1 FROM api_review_enrollments e WHERE e.id=r.enrollment_id AND e.enabled AND e.version=r.enrollment_version) RETURNING r.id`,
				).then((rows) => rows.length > 0),
			cancelRun: (ownerId, id, nowMs) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							const updated =
								yield* sql`UPDATE api_review_runs SET state='cancelled',updated_at_ms=${nowMs},lease_token=NULL,lease_expires_at_ms=NULL WHERE id=${id} AND owner_id=${ownerId} AND state IN ('queued','blocked','provisioning','reviewing','publishing') RETURNING id`;
							yield* sql`UPDATE api_review_publications SET state='cancelled' WHERE run_id=${id} AND owner_id=${ownerId} AND state IN ('pending','reconcile')`;
							return updated.length > 0;
						}),
					),
				),
			closePull: (repositoryId, pullNumber, nowMs) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* lock(repositoryId);
							yield* sql`UPDATE api_review_runs SET state='cancelled',updated_at_ms=${nowMs},lease_token=NULL,lease_expires_at_ms=NULL WHERE repository_id=${repositoryId} AND pull_number=${pullNumber} AND state IN ('queued','blocked','provisioning','reviewing','publishing')`;
						}),
					),
				).then(() => undefined),
			suspendInstallation: (installationId, nowMs) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							const affected = yield* sql<{
								id: string;
								repository_id: string;
							}>`SELECT id,repository_id FROM api_review_enrollments WHERE installation_id=${installationId} ORDER BY repository_id`;
							for (const row of affected) {
								yield* lock(Number(row.repository_id));
								yield* sql`UPDATE api_review_enrollments SET enabled=false,version=version+1,updated_at_ms=${nowMs} WHERE id=${row.id} AND enabled`;
								yield* cancelEnrollmentRuns(row.id, nowMs);
							}
						}),
					),
				).then(() => undefined),
			getRunCosts: (ownerId, runIds) =>
				runIds.length === 0
					? Promise.resolve({})
					: run(sql<{
							run_id: string;
							estimate: string;
							resource_count: string;
							settled: boolean;
							cost: string;
						}>`
 WITH resources AS (
 SELECT r.id AS run_id,a.id AS resource_id,a.provider,a.owner_id,a.provider_sandbox_id,a.stopped_at_ms,COALESCE((a.lifecycle->>'maximumCostMicros')::bigint,0) AS estimate
 FROM api_review_attempts a JOIN api_review_runs r ON r.id=a.run_id WHERE r.owner_id=${ownerId} AND r.id IN ${sql.in(runIds.slice(0, 100))}
 UNION ALL SELECT r.id,a.id,a.provider,a.owner_id,a.provider_sandbox_id,a.stopped_at_ms,a.maximum_cost_micros FROM api_review_native_activities a JOIN api_review_runs r ON r.id=a.run_id WHERE a.kind='check' AND r.owner_id=${ownerId} AND r.id IN ${sql.in(runIds.slice(0, 100))}
 ), amounts AS (
 SELECT r.*,COUNT(u.entry_id) FILTER(WHERE u.status IN ('confirmed','corrected') AND p.period_id IS NOT NULL) AS confirmed,COUNT(u.entry_id) FILTER(WHERE u.status='provisional') AS provisional,CEIL(COALESCE(SUM(u.provider_cost_micros::numeric*(10000+p.markup_basis_points)) FILTER(WHERE u.status IN ('confirmed','corrected')),0)/10000) AS cost
 FROM resources r LEFT JOIN api_cloud_billing_usage u ON u.account_id=r.owner_id AND u.resource_kind='review' AND u.resource_id=r.resource_id AND u.provider=r.provider LEFT JOIN api_cloud_billing_periods p ON p.period_id=u.period_id AND p.account_id=r.owner_id
 GROUP BY r.run_id,r.resource_id,r.provider,r.owner_id,r.provider_sandbox_id,r.stopped_at_ms,r.estimate
 ) SELECT run_id,SUM(estimate) AS estimate,COUNT(*) AS resource_count,BOOL_AND(stopped_at_ms IS NOT NULL AND ((provider_sandbox_id IS NULL AND estimate=0) OR (confirmed>0 AND provisional=0))) AND BOOL_OR(provider_sandbox_id IS NOT NULL) AS settled,SUM(cost) AS cost FROM amounts GROUP BY run_id
 `).then((rows) =>
							Object.fromEntries(
								rows.map((r) => [
									r.run_id,
									{
										...(Number(r.estimate) > 0
											? { estimatedCostMicros: Number(r.estimate) }
											: {}),
										...(r.settled
											? { settledCostMicros: Math.max(0, Number(r.cost)) }
											: {}),
									},
								]),
							),
						),
			getBillingResource: (provider, id) =>
				run(
					sql<{
						owner_id: string;
						provider_sandbox_id: string | null;
					}>`SELECT owner_id,provider_sandbox_id FROM api_review_attempts WHERE id=${id} AND provider=${provider}`,
				).then((rows) =>
					rows[0]
						? {
								accountId: rows[0].owner_id,
								providerSandboxId: rows[0].provider_sandbox_id,
							}
						: null,
				),
			claimRun: (id, nowMs) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							const candidates =
								yield* sql<RunRow>`SELECT snapshot,state,blocked_reason,updated_at_ms FROM api_review_runs WHERE id=${id} AND state='queued'`;
							if (!candidates[0]) return null;
							const r = runFromRow(candidates[0]);
							yield* lock(r.repositoryId);
							yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`review-connection:${r.ownerId}:${r.modelConnectionId}`},0))`;
							const token = crypto.randomUUID();
							const claimed =
								yield* sql`UPDATE api_review_runs r SET lease_token=${token},lease_expires_at_ms=${nowMs + 60000},updated_at_ms=${nowMs} WHERE r.id=${id} AND r.state='queued' AND (r.lease_expires_at_ms IS NULL OR r.lease_expires_at_ms<=${nowMs}) AND EXISTS(SELECT 1 FROM api_review_enrollments e WHERE e.id=r.enrollment_id AND e.enabled AND e.version=r.enrollment_version) AND NOT EXISTS(SELECT 1 FROM api_review_runs other WHERE other.id<>r.id AND other.owner_id=r.owner_id AND other.model_connection_id=r.model_connection_id AND (other.state IN ('provisioning','reviewing') OR other.lease_expires_at_ms>${nowMs})) AND NOT EXISTS(SELECT 1 FROM api_review_attempts a JOIN api_review_runs busy ON busy.id=a.run_id WHERE (a.stopped_at_ms IS NULL OR a.lifecycle->>'stage'='checking') AND ((busy.repository_id=r.repository_id AND busy.pull_number=r.pull_number) OR (busy.owner_id=r.owner_id AND busy.model_connection_id=r.model_connection_id))) RETURNING id`;
							return claimed.length ? { run: r, leaseToken: token } : null;
						}),
					),
				),
			blockRun: (id, token, reason, nowMs) =>
				run(
					sql`UPDATE api_review_runs SET state='blocked',blocked_reason=${reason},updated_at_ms=${nowMs},lease_token=NULL,lease_expires_at_ms=NULL WHERE id=${id} AND lease_token=${token} AND lease_expires_at_ms>${nowMs} AND state='queued'`,
				).then(() => undefined),
			recordAttempt: (input) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							const rows = yield* sql<{
								owner_id: string;
								snapshot: ReviewRunRecord;
							}>`SELECT r.owner_id,r.snapshot FROM api_review_runs r JOIN api_review_enrollments e ON e.id=r.enrollment_id WHERE r.id=${input.runId} AND r.lease_token=${input.leaseToken} AND r.lease_expires_at_ms>${input.nowMs} AND r.state IN ('queued','provisioning') AND e.enabled AND e.version=r.enrollment_version FOR UPDATE OF r`;
							if (!rows[0]) return false;
							if (input.provider !== rows[0].snapshot.worker.provider)
								return false;
							const attempts = yield* sql<{
								count: string;
								reserved: string;
								unstopped: string;
							}>`SELECT count(*) AS count,COALESCE(sum(maximum_lifetime_ms),0) AS reserved,count(*) FILTER (WHERE stopped_at_ms IS NULL) AS unstopped FROM api_review_attempts WHERE run_id=${input.runId}`;
							const totals = attempts[0];
							if (
								!totals ||
								Number(totals.count) >= 2 ||
								Number(totals.unstopped) > 0 ||
								input.maximumLifetimeMs <= 0 ||
								Number(totals.reserved) + input.maximumLifetimeMs >
									Math.min(
										REVIEW_POLICY.maxAllocatedMs,
										rows[0].snapshot.worker.maxRuntimeMs,
									)
							)
								return false;
							yield* sql`INSERT INTO api_review_attempts(id,run_id,ordinal,owner_id,provider,maximum_lifetime_ms,lease_token,created_at_ms) VALUES(${input.id},${input.runId},${Number(totals.count) + 1},${rows[0].owner_id},${input.provider},${input.maximumLifetimeMs},${input.leaseToken},${input.nowMs})`;
							yield* sql`UPDATE api_review_runs SET state='provisioning',updated_at_ms=${input.nowMs} WHERE id=${input.runId}`;
							return true;
						}),
					),
				),
			attachSandbox: (id, token, sandboxId, nowMs) =>
				run(
					sql`UPDATE api_review_attempts a SET provider_sandbox_id=${sandboxId},allocated_at_ms=${nowMs} WHERE a.id=${id} AND a.lease_token=${token} AND a.provider_sandbox_id IS NULL AND a.stopped_at_ms IS NULL AND EXISTS(SELECT 1 FROM api_review_runs r JOIN api_review_enrollments e ON e.id=r.enrollment_id WHERE r.id=a.run_id AND r.lease_token=${token} AND r.lease_expires_at_ms>${nowMs} AND r.state='provisioning' AND e.enabled AND e.version=r.enrollment_version) RETURNING id`,
				).then((rows) => rows.length > 0),
			stopAttempt: (id, token, nowMs) =>
				run(
					sql`UPDATE api_review_attempts SET stopped_at_ms=${nowMs} WHERE id=${id} AND lease_token=${token} AND stopped_at_ms IS NULL RETURNING id`,
				).then((rows) => rows.length > 0),
			acceptResult: (id, token, result, nowMs) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							const rows =
								yield* sql<RunRow>`SELECT r.snapshot,r.state,r.blocked_reason,r.updated_at_ms FROM api_review_runs r JOIN api_review_enrollments e ON e.id=r.enrollment_id WHERE r.id=${id} AND r.lease_token=${token} AND r.lease_expires_at_ms>${nowMs} AND r.state IN ('provisioning','reviewing') AND e.enabled AND e.version=r.enrollment_version FOR UPDATE OF r`;
							if (!rows[0]) return false;
							const r = runFromRow(rows[0]);
							if (
								result.snapshot.repositoryId !== r.repositoryId ||
								result.snapshot.baseRef !== r.baseRef ||
								result.snapshot.baseSha !== r.baseSha ||
								result.snapshot.headSha !== r.headSha
							)
								return false;
							const snapshot = {
								...r,
								mergeBaseSha: result.snapshot.mergeBaseSha,
								result,
							};
							yield* sql`UPDATE api_review_runs SET snapshot=${JSON.stringify(snapshot)}::jsonb,state='publishing',updated_at_ms=${nowMs},lease_token=NULL,lease_expires_at_ms=NULL WHERE id=${id}`;
							const publications = [
								{ kind: "summary", result },
								...result.findings
									.slice(0, REVIEW_POLICY.maxInlineFindings)
									.map((finding) => ({
										kind: "finding",
										finding,
										snapshot: result.snapshot,
									})),
							];
							for (const payload of publications) {
								const publicationId = crypto.randomUUID();
								yield* sql`INSERT INTO api_review_publications(id,run_id,owner_id,marker,payload,state,available_at_ms,created_at_ms) VALUES(${publicationId},${id},${r.ownerId},${reviewMarker(id, publicationId)},${JSON.stringify(payload)}::jsonb,'pending',${nowMs},${nowMs})`;
							}
							return true;
						}),
					),
				),
			claimPublications: (nowMs, limit) =>
				run(
					sql<{
						id: string;
						run_id: string;
						marker: string;
						payload: unknown;
						state: "pending" | "reconcile";
						github_id: string | null;
						may_create: boolean;
						lease_token: string;
					}>`WITH due AS (SELECT p.id,p.state AS previous_state FROM api_review_publications p JOIN api_review_runs r ON r.id=p.run_id JOIN api_review_enrollments e ON e.id=r.enrollment_id WHERE p.state IN ('pending','reconcile') AND p.available_at_ms<=${nowMs} AND (p.lease_expires_at_ms IS NULL OR p.lease_expires_at_ms<=${nowMs}) AND r.state='publishing' AND e.enabled AND e.version=r.enrollment_version ORDER BY p.available_at_ms FOR UPDATE OF p SKIP LOCKED LIMIT ${Math.min(limit, 100)}) UPDATE api_review_publications p SET state='reconcile',lease_token=${crypto.randomUUID()},lease_expires_at_ms=${nowMs + 60000} FROM due WHERE p.id=due.id RETURNING p.*,(due.previous_state='pending') AS may_create`,
				).then((rows) =>
					rows.map((r) => ({
						id: r.id,
						runId: r.run_id,
						marker: r.marker,
						payload: r.payload,
						state: r.state,
						githubId: r.github_id,
						mayCreate: r.may_create,
						leaseToken: r.lease_token,
					})),
				),
			cancelPublication: (id, token, nowMs) =>
				run(
					sql`WITH cancelled AS (UPDATE api_review_publications SET state='cancelled',lease_token=NULL,lease_expires_at_ms=NULL WHERE id=${id} AND lease_token=${token} AND lease_expires_at_ms>${nowMs} RETURNING run_id) UPDATE api_review_runs SET state='blocked',blocked_reason='review_publication_rejected',updated_at_ms=${nowMs} WHERE id IN (SELECT run_id FROM cancelled) AND state='publishing'`,
				).then(() => undefined),
			finishPublication: (
				id,
				token,
				githubId,
				nowMs,
				disposition = "ambiguous",
			) =>
				run(
					sql.withTransaction(
						Effect.gen(function* () {
							if (disposition === "unwritten") {
								yield* sql`UPDATE api_review_publications SET state='pending',retry_count=retry_count+1,available_at_ms=${nowMs + 60000},lease_token=NULL,lease_expires_at_ms=NULL WHERE id=${id} AND lease_token=${token} AND lease_expires_at_ms>${nowMs} AND state='reconcile' AND github_id IS NULL`;
								return;
							}
							if (disposition === "superseded") {
								yield* sql`WITH stale AS (UPDATE api_review_publications SET state='cancelled',github_id=COALESCE(${githubId},github_id),lease_token=NULL,lease_expires_at_ms=NULL WHERE id=${id} AND lease_token=${token} AND lease_expires_at_ms>${nowMs} AND state='reconcile' RETURNING run_id) UPDATE api_review_runs SET state='superseded',updated_at_ms=${nowMs} WHERE id IN (SELECT run_id FROM stale) AND state='publishing'`;
								return;
							}
							const rows = yield* sql<{
								run_id: string;
							}>`UPDATE api_review_publications SET state=${githubId ? "delivered" : "reconcile"},retry_count=retry_count+${githubId ? 0 : 1},github_id=${githubId},available_at_ms=${nowMs + 60000},lease_token=NULL,lease_expires_at_ms=NULL WHERE id=${id} AND lease_token=${token} AND lease_expires_at_ms>${nowMs} AND state='reconcile' RETURNING run_id`;
							if (!githubId && rows[0])
								yield* sql`UPDATE api_review_runs SET state='blocked',blocked_reason='review_publication_ambiguous',updated_at_ms=${nowMs} WHERE id=${rows[0].run_id} AND state='publishing' AND EXISTS(SELECT 1 FROM api_review_publications WHERE id=${id} AND retry_count>=3)`;
							if (githubId && rows[0])
								yield* sql`UPDATE api_review_runs SET state=CASE WHEN snapshot->'result'->>'status'='partial' THEN 'partial' ELSE 'completed' END,updated_at_ms=${nowMs} WHERE id=${rows[0].run_id} AND state='publishing' AND NOT EXISTS(SELECT 1 FROM api_review_publications WHERE run_id=${rows[0].run_id} AND state<>'delivered')`;
						}),
					),
				).then(() => undefined),
		};
		return api;
	}),
);
