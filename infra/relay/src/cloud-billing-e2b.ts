import { Effect, Schema } from "effect";
import { e2bExecutionCostMicros } from "./cloud-billing.ts";
import { ensureAccountCloudBillingPeriod } from "./cloud-billing-period.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { RelayConfiguration } from "./config.ts";
import { conflict } from "./errors.ts";

const E2bExecution = Schema.Struct({
	started_at: Schema.String,
	vcpu_count: Schema.Number,
	memory_mb: Schema.Number,
	execution_time: Schema.Number,
});

export const E2bLifecycleEvent = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	timestamp: Schema.String,
	sandbox_id: Schema.String,
	sandbox_execution_id: Schema.optional(Schema.String),
	event_data: Schema.Struct({
		sandbox_metadata: Schema.optional(
			Schema.Record(Schema.String, Schema.String),
		),
		execution: Schema.optional(E2bExecution),
	}),
});
export type E2bLifecycleEvent = typeof E2bLifecycleEvent.Type;

export const normalizeE2bLifecycleEvent = (
	value: unknown,
): E2bLifecycleEvent | null => {
	if (typeof value !== "object" || value === null) return null;
	const event = value as Record<string, unknown>;
	const sourceEventData = event.event_data ?? event.eventData;
	const eventData =
		typeof sourceEventData === "object" && sourceEventData !== null
			? (sourceEventData as Record<string, unknown>)
			: {};
	const sourceExecution = eventData.execution;
	const execution =
		typeof sourceExecution === "object" && sourceExecution !== null
			? (sourceExecution as Record<string, unknown>)
			: undefined;
	const normalized = {
		...event,
		event_data: {
			...eventData,
			sandbox_metadata: eventData.sandbox_metadata ?? eventData.sandboxMetadata,
			...(execution === undefined
				? {}
				: {
						execution: {
							...execution,
							started_at: execution.started_at ?? execution.startedAt,
							vcpu_count: execution.vcpu_count ?? execution.vcpuCount,
							memory_mb: execution.memory_mb ?? execution.memoryMb,
							execution_time:
								execution.execution_time ?? execution.executionTime,
						},
					}),
		},
		sandbox_id: event.sandbox_id ?? event.sandboxId,
		sandbox_execution_id:
			event.sandbox_execution_id ?? event.sandboxExecutionId,
	};
	const decoded = Schema.decodeUnknownOption(E2bLifecycleEvent)(normalized);
	return decoded._tag === "Some" ? decoded.value : null;
};

export interface E2bIngestionResult {
	readonly eventInserted: boolean;
	readonly metered: boolean;
	readonly reason?:
		| "non-final"
		| "unmatched"
		| "no-period"
		| "cutover-not-configured"
		| "pre-cutover";
}

export interface E2bPriceWindow {
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly cpuNanoUsdPerSecond: number;
	readonly memoryNanoUsdPerGibSecond: number;
}

/**
 * Price windows affect the cost, never the financial identity. Catalog entries
 * may be appended after an execution was first ingested, so using a window
 * boundary in the identity would let a redelivery create additional rows.
 */
export const priceE2bExecutionPeriod = (input: {
	readonly eventId: string;
	readonly periodId: string;
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly vcpuCount: number;
	readonly memoryMib: number;
	readonly prices: ReadonlyArray<E2bPriceWindow>;
}) => {
	const providerEventId = `${input.eventId}:${input.periodId}`;
	return {
		entryId: `e2b:${providerEventId}`,
		providerEventId,
		startedAt: input.startedAtMs,
		endedAt: input.endedAtMs,
		providerCostMicros: input.prices.reduce(
			(total, price) =>
				total +
				e2bExecutionCostMicros({
					durationMs: price.endedAtMs - price.startedAtMs,
					vcpuCount: input.vcpuCount,
					memoryMib: input.memoryMib,
					cpuNanoUsdPerSecond: price.cpuNanoUsdPerSecond,
					memoryNanoUsdPerGibSecond: price.memoryNanoUsdPerGibSecond,
				}),
			0,
		),
	};
};

export const ingestE2bLifecycleEvent = Effect.fn("ingestE2bLifecycleEvent")(
	function* (input: {
		readonly event: E2bLifecycleEvent;
		readonly rawPayload: unknown;
		readonly source: "webhook" | "poll";
		readonly deliveryId: string;
		readonly nowMs: number;
	}) {
		const billingStore = yield* CloudBillingStore;
		const event = input.event;
		const eventInserted = yield* billingStore.recordProviderEvent({
			provider: "e2b",
			eventId: event.id,
			type: event.type,
			providerResourceId: event.sandbox_id,
			payload: input.rawPayload,
			receivedAtMs: input.nowMs,
			expiresAtMs: input.nowMs + 90 * 24 * 60 * 60 * 1_000,
		});
		yield* billingStore.recordProviderDelivery({
			provider: "e2b",
			deliveryId: input.deliveryId,
			eventId: event.id,
			source: input.source,
			status: eventInserted ? "accepted" : "duplicate",
			receivedAtMs: input.nowMs,
		});
		const providerTimestamp = Date.parse(event.timestamp);
		if (
			Number.isFinite(providerTimestamp) &&
			input.nowMs - providerTimestamp > 5 * 60_000
		)
			console.warn(
				"[cloud-billing] E2B lifecycle event lag exceeded five minutes",
				{
					eventId: event.id,
					lagMs: input.nowMs - providerTimestamp,
				},
			);
		if (
			(event.type !== "sandbox.lifecycle.paused" &&
				event.type !== "sandbox.lifecycle.killed") ||
			event.event_data.execution === undefined
		)
			return { eventInserted, metered: false, reason: "non-final" };
		const internalId = event.event_data.sandbox_metadata?.["zuse-sandbox-id"];
		if (internalId === undefined) {
			console.warn("[cloud-billing] unmatched E2B lifecycle event", {
				eventId: event.id,
				sandboxId: event.sandbox_id,
			});
			return { eventInserted, metered: false, reason: "unmatched" };
		}
		const workspaces = yield* CloudWorkspaceStore;
		const workspace = yield* workspaces.getWorkspace(internalId);
		const build =
			workspace === null ? yield* workspaces.getBuild(internalId) : null;
		const resource = workspace ?? build;
		if (resource === null)
			return { eventInserted, metered: false, reason: "unmatched" };
		const period = yield* ensureAccountCloudBillingPeriod(
			resource.accountId,
			input.nowMs,
		);
		if (period === null)
			return { eventInserted, metered: false, reason: "no-period" };
		const execution = event.event_data.execution;
		const providerStartedAt = Date.parse(execution.started_at);
		const endedAt = providerStartedAt + execution.execution_time;
		if (
			!Number.isFinite(providerStartedAt) ||
			!Number.isSafeInteger(execution.execution_time) ||
			execution.execution_time <= 0 ||
			endedAt > input.nowMs + 5 * 60_000
		)
			return yield* Effect.fail(conflict("invalid_e2b_execution"));
		const cutoverAt = (yield* RelayConfiguration).cloudBillingCutoverAtMs;
		if (cutoverAt === undefined)
			return {
				eventInserted,
				metered: false,
				reason: "cutover-not-configured",
			};
		if (endedAt <= cutoverAt)
			return { eventInserted, metered: false, reason: "pre-cutover" };
		const startedAt = Math.max(providerStartedAt, cutoverAt);
		const periods = yield* billingStore.periodsOverlapping(
			resource.accountId,
			startedAt,
			endedAt,
		);
		if (periods.length === 0) {
			console.warn("[cloud-billing] E2B execution has no overlapping period", {
				eventId: event.id,
				accountId: resource.accountId,
				startedAt,
				endedAt,
			});
			return { eventInserted, metered: false, reason: "no-period" };
		}
		let metered = false;
		for (const executionPeriod of periods) {
			const segmentStart = Math.max(startedAt, executionPeriod.periodStartMs);
			const segmentEnd = Math.min(endedAt, executionPeriod.periodEndMs);
			const prices = yield* billingStore.priceWindows(
				"e2b",
				segmentStart,
				segmentEnd,
			);
			if (prices.length === 0)
				return yield* Effect.fail(conflict("cloud_billing_price_missing"));
			const priced = priceE2bExecutionPeriod({
				eventId: event.id,
				periodId: executionPeriod.periodId,
				startedAtMs: segmentStart,
				endedAtMs: segmentEnd,
				vcpuCount: execution.vcpu_count,
				memoryMib: execution.memory_mb,
				prices,
			});
			metered =
				(yield* billingStore.recordExecution({
					...priced,
					periodId: executionPeriod.periodId,
					accountId: resource.accountId,
					resourceKind: workspace === null ? "build" : "workspace",
					resourceId: internalId,
					provider: "e2b",
					providerExecutionId: event.sandbox_execution_id,
					vcpuCount: execution.vcpu_count,
					memoryMib: execution.memory_mb,
					status: "confirmed",
					nowMs: input.nowMs,
				})) || metered;
		}
		return { eventInserted, metered };
	},
);
