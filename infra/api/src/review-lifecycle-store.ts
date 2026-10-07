import type { ReviewResult } from "@zuse/contracts";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { ReviewRunRecord } from "./review-domain.ts";
export interface ReviewNativeConnection {
	id: string;
	ownerActorId: string;
	ownerId: string;
	label: string;
	agentProvider: "claude";
	sandboxProvider: "e2b";
	size: string;
	models: readonly string[];
	providerSandboxId: string | null;
	state: "login-required" | "authenticating" | "ready" | "revoked" | "lost";
	createdAtMs: number;
	updatedAtMs: number;
	providerIdentity?: string;
	reason?: string;
	loginActivityId?: string;
	verificationUrl?: string;
	verificationCode?: string;
	expiresAtMs?: number;
}
export interface ReviewAttemptLifecycle {
	providerIdentity?: string;
	connectionId: string;
	stage:
		| "admitted"
		| "starting"
		| "running"
		| "checking"
		| "stopping"
		| "stopped"
		| "unknown";
	deadlineMs: number;
	maximumCostMicros: number;
	heartbeatAtMs: number;
	workerStarted: boolean;
	cleanupConfirmed: boolean;
	resultReceived: boolean;
	pendingResult?: ReviewResult;
	errorCode?: string;
	bootHash: string;
}
export interface ReviewManagedAttempt {
	id: string;
	runId: string;
	ownerId: string;
	provider: string;
	providerSandboxId: string | null;
	leaseToken: string;
	createdAtMs: number;
	allocatedAtMs: number | null;
	stoppedAtMs: number | null;
	maximumLifetimeMs: number;
	lifecycle: ReviewAttemptLifecycle;
	run: ReviewRunRecord;
}
export interface ReviewNativeActivity {
	kind?: "login" | "check";
	runId?: string;
	attemptId?: string;
	size?: string;
	id: string;
	connectionId: string;
	ownerId: string;
	provider: string;
	providerSandboxId: string | null;
	startedAtMs: number;
	stoppedAtMs: number | null;
	deadlineMs: number;
	maximumCostMicros: number;
	state: "admitted" | "running" | "stopped" | "unknown";
}
export interface ReviewLifecycleStoreApi {
	getRunExecutionBudget(
		runId: string,
	): Promise<{ allocatedMs: number; maximumCostMicros: number }>;
	saveActivity(a: ReviewNativeActivity): Promise<void>;
	getActivity(id: string): Promise<ReviewNativeActivity | null>;
	listOpenActivities(): Promise<ReviewNativeActivity[]>;
	revokeConnection(id: string, nowMs: number): Promise<void>;
	claimLogin(id: string, actorId: string, nowMs: number): Promise<boolean>;
	listConnections(
		ownerId: string,
		actorId: string,
	): Promise<ReviewNativeConnection[]>;
	getConnection(id: string): Promise<ReviewNativeConnection | null>;
	saveConnection(record: ReviewNativeConnection): Promise<void>;
	claimConnection(
		id: string,
		actorId: string,
		token: string,
		nowMs: number,
	): Promise<boolean>;
	releaseConnection(id: string, token: string): Promise<void>;
	initializeAttempt(
		id: string,
		token: string,
		data: Partial<ReviewAttemptLifecycle>,
	): Promise<boolean>;
	listActiveAttempts(limit: number): Promise<ReviewManagedAttempt[]>;
	getAttempt(id: string): Promise<ReviewManagedAttempt | null>;
	updateAttempt(
		id: string,
		token: string,
		data: Partial<ReviewAttemptLifecycle>,
	): Promise<boolean>;
	authenticateAttempt(
		id: string,
		bootHash: string,
		nowMs: number,
	): Promise<ReviewManagedAttempt | null>;
	claimSupervisor(id: string, nowMs: number): Promise<string | null>;
	releaseSupervisor(id: string, token: string): Promise<void>;
	finishRun(id: string, reason: string, nowMs: number): Promise<void>;
	releaseCostReservation(attemptId: string): Promise<void>;
}
export class ReviewLifecycleStore extends Context.Service<
	ReviewLifecycleStore,
	ReviewLifecycleStoreApi
>()("api/ReviewLifecycleStore") {}
interface AttemptRow {
	id: string;
	run_id: string;
	owner_id: string;
	provider: string;
	provider_sandbox_id: string | null;
	lease_token: string;
	created_at_ms: string;
	allocated_at_ms: string | null;
	stopped_at_ms: string | null;
	maximum_lifetime_ms: string;
	lifecycle: ReviewAttemptLifecycle;
	snapshot: ReviewRunRecord;
	state: ReviewRunRecord["state"];
	blocked_reason: string | null;
	updated_at_ms: string;
}
const attempt = (r: AttemptRow): ReviewManagedAttempt => ({
	id: r.id,
	runId: r.run_id,
	ownerId: r.owner_id,
	provider: r.provider,
	providerSandboxId: r.provider_sandbox_id,
	leaseToken: r.lease_token,
	createdAtMs: Number(r.created_at_ms),
	allocatedAtMs: r.allocated_at_ms === null ? null : Number(r.allocated_at_ms),
	stoppedAtMs: r.stopped_at_ms === null ? null : Number(r.stopped_at_ms),
	maximumLifetimeMs: Number(r.maximum_lifetime_ms),
	lifecycle: r.lifecycle,
	run: {
		...r.snapshot,
		state: r.state,
		blockedReason: r.blocked_reason,
		updatedAtMs: Number(r.updated_at_ms),
	},
});
export const ReviewLifecycleStorePg = Layer.effect(
	ReviewLifecycleStore,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const execute = <A>(op: Effect.Effect<A, unknown>) => Effect.runPromise(op);
		const read = (id: string) =>
			execute(
				sql<AttemptRow>`SELECT a.*,r.snapshot,r.state,r.blocked_reason,r.updated_at_ms FROM api_review_attempts a JOIN api_review_runs r ON r.id=a.run_id WHERE a.id=${id}`,
			).then((rows) => (rows[0] ? attempt(rows[0]) : null));
		const activity = (r: {
			kind: "login" | "check";
			run_id: string | null;
			attempt_id: string | null;
			size: string | null;
			id: string;
			connection_id: string;
			owner_id: string;
			provider: string;
			provider_sandbox_id: string | null;
			started_at_ms: string;
			stopped_at_ms: string | null;
			deadline_ms: string;
			maximum_cost_micros: string;
			state: ReviewNativeActivity["state"];
		}): ReviewNativeActivity => ({
			kind: r.kind,
			runId: r.run_id ?? undefined,
			attemptId: r.attempt_id ?? undefined,
			size: r.size ?? undefined,
			id: r.id,
			connectionId: r.connection_id,
			ownerId: r.owner_id,
			provider: r.provider,
			providerSandboxId: r.provider_sandbox_id,
			startedAtMs: Number(r.started_at_ms),
			stoppedAtMs: r.stopped_at_ms === null ? null : Number(r.stopped_at_ms),
			deadlineMs: Number(r.deadline_ms),
			maximumCostMicros: Number(r.maximum_cost_micros),
			state: r.state,
		});
		return {
			getRunExecutionBudget: (runId) =>
				execute(
					sql<{
						allocated_ms: string;
						maximum_cost_micros: string;
					}>`SELECT COALESCE(sum(allocated_ms),0) AS allocated_ms,COALESCE(sum(maximum_cost_micros),0) AS maximum_cost_micros FROM (SELECT GREATEST(0,COALESCE(stopped_at_ms,created_at_ms+maximum_lifetime_ms)-created_at_ms) AS allocated_ms,COALESCE((lifecycle->>'maximumCostMicros')::bigint,0) AS maximum_cost_micros FROM api_review_attempts WHERE run_id=${runId} UNION ALL SELECT GREATEST(0,COALESCE(stopped_at_ms,deadline_ms)-started_at_ms),maximum_cost_micros FROM api_review_native_activities WHERE run_id=${runId} AND kind='check') windows`,
				).then((rows) => ({
					allocatedMs: Number(rows[0]?.allocated_ms ?? 0),
					maximumCostMicros: Number(rows[0]?.maximum_cost_micros ?? 0),
				})),
			saveActivity: (a) =>
				execute(
					sql`INSERT INTO api_review_native_activities(id,connection_id,owner_id,provider,provider_sandbox_id,started_at_ms,stopped_at_ms,deadline_ms,maximum_cost_micros,state,kind,run_id,attempt_id,size) VALUES(${a.id},${a.connectionId},${a.ownerId},${a.provider},${a.providerSandboxId},${a.startedAtMs},${a.stoppedAtMs},${a.deadlineMs},${a.maximumCostMicros},${a.state},${a.kind ?? "login"},${a.runId ?? null},${a.attemptId ?? null},${a.size ?? null}) ON CONFLICT(id) DO UPDATE SET provider_sandbox_id=excluded.provider_sandbox_id,stopped_at_ms=excluded.stopped_at_ms,state=excluded.state`,
				).then(() => undefined),
			getActivity: (id) =>
				execute(
					sql<
						Parameters<typeof activity>[0]
					>`SELECT * FROM api_review_native_activities WHERE id=${id}`,
				).then((rows) => (rows[0] ? activity(rows[0]) : null)),
			listOpenActivities: () =>
				execute(
					sql<
						Parameters<typeof activity>[0]
					>`SELECT * FROM api_review_native_activities WHERE stopped_at_ms IS NULL ORDER BY started_at_ms LIMIT 100`,
				).then((rows) => rows.map(activity)),
			revokeConnection: (id, nowMs) =>
				execute(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* sql`UPDATE api_review_native_connections SET state='revoked',data=jsonb_set(data,'{state}','"revoked"'::jsonb) WHERE id=${id}`;
							yield* sql`UPDATE api_review_enrollments SET enabled=false,version=version+1,updated_at_ms=${nowMs} WHERE model_connection_id=${id} AND enabled`;
							yield* sql`UPDATE api_review_runs SET state='cancelled',updated_at_ms=${nowMs} WHERE model_connection_id=${id} AND state IN ('queued','provisioning','reviewing','publishing','blocked')`;
						}),
					),
				).then(() => undefined),
			claimLogin: (id, actorId, nowMs) =>
				execute(
					sql`UPDATE api_review_native_connections SET state='authenticating',data=jsonb_set(data,'{state}','"authenticating"'::jsonb),lease_token=${id},lease_expires_at_ms=${nowMs + 600000} WHERE id=${id} AND owner_actor_id=${actorId} AND state IN ('login-required','lost') RETURNING id`,
				).then((rows) => rows.length === 1),
			listConnections: (_ownerId, actorId) =>
				execute(
					sql<{
						data: ReviewNativeConnection;
					}>`SELECT data FROM api_review_native_connections WHERE owner_actor_id=${actorId} AND state<>'revoked' ORDER BY id LIMIT 100`,
				).then((rows) => rows.map((r) => r.data)),
			getConnection: (id) =>
				execute(
					sql<{
						data: ReviewNativeConnection;
					}>`SELECT data FROM api_review_native_connections WHERE id=${id}`,
				).then((rows) => rows[0]?.data ?? null),
			saveConnection: (c) =>
				execute(
					sql`INSERT INTO api_review_native_connections(id,owner_actor_id,state,data) VALUES(${c.id},${c.ownerActorId},${c.state},${JSON.stringify(c)}::jsonb) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data WHERE api_review_native_connections.owner_actor_id=excluded.owner_actor_id AND api_review_native_connections.state<>'revoked'`,
				).then(() => undefined),
			claimConnection: (id, actorId, token, nowMs) =>
				execute(
					sql.withTransaction(
						Effect.gen(function* () {
							yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(data->>'providerIdentity',0)) FROM api_review_native_connections WHERE id=${id} AND data->>'providerIdentity' IS NOT NULL`;
							return yield* sql`UPDATE api_review_native_connections c SET lease_token=${token},lease_expires_at_ms=${nowMs + 900000} WHERE c.id=${id} AND c.owner_actor_id=${actorId} AND c.state='ready' AND c.data->>'providerIdentity' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM api_review_native_connections other WHERE other.id<>c.id AND other.data->>'providerIdentity'=c.data->>'providerIdentity' AND other.lease_token IS NOT NULL AND other.lease_expires_at_ms>${nowMs}) AND (c.lease_token IS NULL OR c.lease_token=${token} OR c.lease_expires_at_ms<=${nowMs}) AND NOT EXISTS(SELECT 1 FROM api_review_attempts a JOIN api_review_runs r ON r.id=a.run_id WHERE r.model_connection_id=c.id AND a.stopped_at_ms IS NULL) RETURNING c.id`;
						}),
					),
				).then((rows) => rows.length === 1),
			releaseConnection: (id, token) =>
				execute(
					sql`UPDATE api_review_native_connections SET lease_token=NULL,lease_expires_at_ms=NULL WHERE id=${id} AND lease_token=${token}`,
				).then(() => undefined),
			initializeAttempt: (id, token, data) =>
				execute(
					sql`UPDATE api_review_attempts SET lifecycle=${JSON.stringify(data)}::jsonb WHERE id=${id} AND lease_token=${token} AND lifecycle='{}'::jsonb RETURNING id`,
				).then((rows) => rows.length === 1),
			listActiveAttempts: (limit) =>
				execute(
					sql<AttemptRow>`SELECT a.*,r.snapshot,r.state,r.blocked_reason,r.updated_at_ms FROM api_review_attempts a JOIN api_review_runs r ON r.id=a.run_id WHERE (a.stopped_at_ms IS NULL OR a.lifecycle->>'stage'='checking') ORDER BY a.created_at_ms LIMIT ${Math.min(100, limit)}`,
				).then((rows) => rows.map(attempt)),
			getAttempt: read,
			updateAttempt: (id, token, data) =>
				execute(
					sql`UPDATE api_review_attempts SET lifecycle=lifecycle || ${JSON.stringify(data)}::jsonb WHERE id=${id} AND lease_token=${token} AND (stopped_at_ms IS NULL OR lifecycle->>'stage'='checking') RETURNING id`,
				).then((rows) => rows.length === 1),
			authenticateAttempt: (id, hash, nowMs) =>
				execute(
					sql<AttemptRow>`SELECT a.*,r.snapshot,r.state,r.blocked_reason,r.updated_at_ms FROM api_review_attempts a JOIN api_review_runs r ON r.id=a.run_id JOIN api_review_enrollments e ON e.id=r.enrollment_id JOIN api_review_native_connections c ON c.id=r.model_connection_id WHERE a.id=${id} AND a.lifecycle->>'bootHash'=${hash} AND a.stopped_at_ms IS NULL AND (a.lifecycle->>'deadlineMs')::bigint>${nowMs} AND r.state IN ('provisioning','reviewing') AND e.enabled AND e.version=r.enrollment_version AND c.state='ready' AND c.lease_token=a.lease_token AND c.lease_expires_at_ms>${nowMs} AND r.lease_token=a.lease_token AND r.lease_expires_at_ms>${nowMs}`,
				).then((rows) => (rows[0] ? attempt(rows[0]) : null)),
			claimSupervisor: (id, nowMs) => {
				const token = crypto.randomUUID();
				return execute(
					sql`UPDATE api_review_attempts SET supervisor_token=${token},supervisor_expires_at_ms=${nowMs + 900000} WHERE id=${id} AND (stopped_at_ms IS NULL OR lifecycle->>'stage'='checking') AND (supervisor_expires_at_ms IS NULL OR supervisor_expires_at_ms<=${nowMs}) RETURNING id`,
				).then((rows) => (rows.length ? token : null));
			},
			releaseSupervisor: (id, token) =>
				execute(
					sql`UPDATE api_review_attempts SET supervisor_token=NULL,supervisor_expires_at_ms=NULL WHERE id=${id} AND supervisor_token=${token}`,
				).then(() => undefined),
			releaseCostReservation: (id) =>
				execute(
					sql`DELETE FROM api_cloud_billing_reservations WHERE resource_kind='review' AND resource_id=${id}`,
				).then(() => undefined),
			finishRun: (id, reason, nowMs) =>
				execute(
					sql`UPDATE api_review_runs SET state='failed',blocked_reason=${reason},updated_at_ms=${nowMs},lease_token=NULL,lease_expires_at_ms=NULL WHERE id=${id} AND state IN ('queued','provisioning','reviewing')`,
				).then(() => undefined),
		} satisfies ReviewLifecycleStoreApi;
	}),
);
