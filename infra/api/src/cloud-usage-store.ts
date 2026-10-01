import { Effect, Semaphore } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { CloudBillingUsageRecord } from "./cloud-billing-store.ts";

export interface RuntimeObservation {
	readonly accountId: string;
	readonly resourceKind: "workspace" | "build";
	readonly resourceId: string;
	readonly provider: string;
	readonly providerSandboxId: string;
	readonly runningSinceMs?: number;
	readonly observedAtMs: number;
	readonly vcpuCount: number;
	readonly memoryMib: number;
}

export interface RuntimeUsageEvent {
	readonly eventId: string;
	readonly observation: RuntimeObservation;
	readonly startedAtMs: number;
	readonly endedAtMs: number;
}

export interface CloudUsageExport {
	readonly eventId: string;
	readonly accountId: string;
	readonly eventName:
		| "zuse_cloud_runtime_observed_ms"
		| "zuse_cloud_provider_cost_micros";
	readonly units: number;
	readonly occurredAtMs: number;
	readonly metadata: Readonly<Record<string, string>>;
}

export const runtimeUsageExport = (
	event: RuntimeUsageEvent,
): CloudUsageExport => ({
	eventId: event.eventId,
	accountId: event.observation.accountId,
	eventName: "zuse_cloud_runtime_observed_ms",
	units: event.endedAtMs - event.startedAtMs,
	occurredAtMs: event.endedAtMs,
	metadata: {
		provider: event.observation.provider,
		resource_kind: event.observation.resourceKind,
		resource_id: event.observation.resourceId,
		provider_sandbox_id: event.observation.providerSandboxId,
		started_at: new Date(event.startedAtMs).toISOString(),
		ended_at: new Date(event.endedAtMs).toISOString(),
		vcpu_count: String(event.observation.vcpuCount),
		memory_mib: String(event.observation.memoryMib),
		measurement: "observed",
		billable: "false",
	},
});

export const confirmedUsageExport = (
	input: CloudBillingUsageRecord,
): CloudUsageExport => ({
	eventId: `provider-cost:${input.entryId}`,
	accountId: input.accountId,
	eventName: "zuse_cloud_provider_cost_micros",
	units: input.providerCostMicros,
	occurredAtMs: input.endedAt,
	metadata: {
		provider: input.provider,
		resource_kind: input.resourceKind,
		resource_id: input.resourceId,
		billing_period_id: input.periodId,
		started_at: new Date(input.startedAt).toISOString(),
		ended_at: new Date(input.endedAt).toISOString(),
		currency: "USD",
		measurement: "confirmed",
		billable: "false",
	},
});

/** Observations are telemetry, never evidence for invoice settlement. */
export const runtimeUsageInterval = (
	previous: RuntimeObservation | undefined,
	current: RuntimeObservation,
): RuntimeUsageEvent | null => {
	if (
		previous === undefined ||
		previous.accountId !== current.accountId ||
		previous.resourceId !== current.resourceId ||
		previous.resourceKind !== current.resourceKind ||
		previous.provider !== current.provider ||
		previous.providerSandboxId !== current.providerSandboxId ||
		previous.vcpuCount !== current.vcpuCount ||
		previous.memoryMib !== current.memoryMib ||
		previous.runningSinceMs === undefined ||
		current.runningSinceMs === undefined ||
		current.observedAtMs <= previous.observedAtMs ||
		current.observedAtMs - previous.observedAtMs > 120_000
	)
		return null;
	const startedAtMs = Math.max(previous.observedAtMs, current.runningSinceMs);
	if (startedAtMs >= current.observedAtMs) return null;
	return {
		eventId: `runtime:${current.provider}:${current.providerSandboxId}:${startedAtMs}:${current.observedAtMs}`,
		observation: current,
		startedAtMs,
		endedAtMs: current.observedAtMs,
	};
};

export interface RuntimeObservationOptions {
	readonly exportRuntime?: boolean;
	readonly estimateCutoverAtMs?: number;
}

export type RecordRuntimeEstimate = (
	event: RuntimeUsageEvent,
	cutoverAtMs: number,
) => Effect.Effect<void>;

export interface CloudUsageStoreApi {
	readonly enqueueUsageExport: (
		event: CloudUsageExport,
		nowMs: number,
	) => Effect.Effect<void>;
	readonly recordRuntimeObservation: (
		input: RuntimeObservation,
		options?: RuntimeObservationOptions,
	) => Effect.Effect<void>;
	readonly pendingUsageExports: (
		nowMs: number,
		limit: number,
	) => Effect.Effect<ReadonlyArray<CloudUsageExport>>;
	readonly acknowledgeUsageExport: (
		eventId: string,
		nowMs: number,
	) => Effect.Effect<void>;
	readonly retryUsageExport: (
		eventId: string,
		nowMs: number,
		error: string,
	) => Effect.Effect<void>;
}

const enqueueUsageExportPg = (
	sql: SqlClient.SqlClient,
	event: CloudUsageExport,
	nowMs: number,
) =>
	sql`INSERT INTO api_cloud_usage_outbox (event_id, payload, created_at, next_attempt_at) VALUES (${event.eventId}, ${JSON.stringify(event)}::jsonb, ${nowMs}, ${nowMs}) ON CONFLICT DO NOTHING`.pipe(
		Effect.asVoid,
		Effect.orDie,
	);

export const makeCloudUsageStorePg = (
	sql: SqlClient.SqlClient,
	recordEstimate?: RecordRuntimeEstimate,
): CloudUsageStoreApi => ({
	enqueueUsageExport: (event, nowMs) => enqueueUsageExportPg(sql, event, nowMs),
	recordRuntimeObservation: (input, options) =>
		Effect.gen(function* () {
			// Insert first, then lock: even two workers observing a new machine serialize.
			yield* sql`INSERT INTO api_cloud_runtime_observations (provider, provider_sandbox_id, observation) VALUES (${input.provider}, ${input.providerSandboxId}, ${JSON.stringify(input)}::jsonb) ON CONFLICT DO NOTHING`;
			const rows = yield* sql<{
				observation: RuntimeObservation;
			}>`SELECT observation FROM api_cloud_runtime_observations WHERE provider=${input.provider} AND provider_sandbox_id=${input.providerSandboxId} FOR UPDATE`;
			const previous = rows[0]?.observation;
			if (previous !== undefined && previous.observedAtMs >= input.observedAtMs)
				return;
			const event = runtimeUsageInterval(previous, input);
			if (
				event !== null &&
				options?.estimateCutoverAtMs !== undefined &&
				recordEstimate !== undefined
			) {
				yield* recordEstimate(event, options.estimateCutoverAtMs);
			}
			if (event !== null && options?.exportRuntime !== false) {
				yield* enqueueUsageExportPg(
					sql,
					runtimeUsageExport(event),
					input.observedAtMs,
				);
			}
			yield* sql`UPDATE api_cloud_runtime_observations SET observation=${JSON.stringify(input)}::jsonb WHERE provider=${input.provider} AND provider_sandbox_id=${input.providerSandboxId}`;
		}).pipe(sql.withTransaction, Effect.orDie),
	pendingUsageExports: (nowMs, limit) =>
		sql<{
			payload: CloudUsageExport;
		}>`SELECT payload FROM api_cloud_usage_outbox WHERE acknowledged_at IS NULL AND next_attempt_at <= ${nowMs} ORDER BY next_attempt_at, event_id LIMIT ${limit}`.pipe(
			Effect.map((rows) => rows.map((row) => row.payload)),
			Effect.orDie,
		),
	acknowledgeUsageExport: (eventId, nowMs) =>
		sql`UPDATE api_cloud_usage_outbox SET acknowledged_at=${nowMs}, last_error=NULL WHERE event_id=${eventId}`.pipe(
			Effect.asVoid,
			Effect.orDie,
		),
	retryUsageExport: (eventId, nowMs, error) =>
		sql`UPDATE api_cloud_usage_outbox SET attempt_count=attempt_count+1, next_attempt_at=${nowMs}+LEAST(900000, POWER(2, LEAST(attempt_count, 4))::bigint * 60000), last_error=${error.slice(0, 500)} WHERE event_id=${eventId}`.pipe(
			Effect.asVoid,
			Effect.orDie,
		),
});

export const makeCloudUsageStoreMemory = (
	recordEstimate?: RecordRuntimeEstimate,
): CloudUsageStoreApi => {
	const observations = new Map<string, RuntimeObservation>();
	const lock = Semaphore.makeUnsafe(1);
	const pending = new Map<
		string,
		{ event: CloudUsageExport; attempts: number; nextAttemptAtMs: number }
	>();
	const recorded = new Set<string>();
	const enqueue = (event: CloudUsageExport, nowMs: number) => {
		if (recorded.has(event.eventId)) return;
		recorded.add(event.eventId);
		pending.set(event.eventId, { event, attempts: 0, nextAttemptAtMs: nowMs });
	};
	return {
		enqueueUsageExport: (event, nowMs) =>
			Effect.sync(() => enqueue(event, nowMs)),
		recordRuntimeObservation: (input, options) =>
			Effect.gen(function* () {
				const key = JSON.stringify([input.provider, input.providerSandboxId]);
				const previous = observations.get(key);
				if (
					previous !== undefined &&
					previous.observedAtMs >= input.observedAtMs
				)
					return;
				const event = runtimeUsageInterval(previous, input);
				if (
					event !== null &&
					options?.estimateCutoverAtMs !== undefined &&
					recordEstimate !== undefined
				)
					yield* recordEstimate(event, options.estimateCutoverAtMs);
				if (event !== null && options?.exportRuntime !== false)
					enqueue(runtimeUsageExport(event), input.observedAtMs);
				observations.set(key, input);
			}).pipe(lock.withPermits(1)),
		pendingUsageExports: (nowMs, limit) =>
			Effect.sync(() =>
				[...pending.values()]
					.filter((item) => item.nextAttemptAtMs <= nowMs)
					.sort(
						(a, b) =>
							a.nextAttemptAtMs - b.nextAttemptAtMs ||
							a.event.eventId.localeCompare(b.event.eventId),
					)
					.slice(0, limit)
					.map((item) => item.event),
			),
		acknowledgeUsageExport: (eventId) =>
			Effect.sync(() => {
				pending.delete(eventId);
			}),
		retryUsageExport: (eventId, nowMs) =>
			Effect.sync(() => {
				const item = pending.get(eventId);
				if (item === undefined) return;
				item.nextAttemptAtMs =
					nowMs + Math.min(900_000, 2 ** Math.min(item.attempts++, 4) * 60_000);
			}),
	};
};
