import {
	resolveSandboxResources,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { Effect, Schema } from "effect";
import { meterProviderExecution } from "./cloud-billing-provider.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { CloudWorkspaceStore } from "./cloud-workspace-store.ts";
import { serviceUnavailable } from "./errors.ts";

// Box webhooks carry lifecycle transitions, not execution evidence: a
// box.ready opens an execution window and box.archived/box.error closes it.
// Window pairing happens here — the opening event is looked up from the
// stored raw-event ledger by box id, and the pair's identity
// (`<boxId>:<openingEventId>`) makes metering idempotent across webhook
// retries and the recovery poller.

export const BoxLifecycleEvent = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	createdAt: Schema.String.check(
		Schema.makeFilter(
			(value) =>
				Number.isFinite(Date.parse(value)) || "Invalid provider timestamp",
		),
	),
	data: Schema.Struct({
		box: Schema.Struct({
			id: Schema.String,
			name: Schema.optional(Schema.NullOr(Schema.String)),
		}),
		previousState: Schema.optional(Schema.NullOr(Schema.String)),
		state: Schema.optional(Schema.NullOr(Schema.String)),
	}),
});
export type BoxLifecycleEvent = typeof BoxLifecycleEvent.Type;

/** Decode provider lifecycle evidence; invalid timestamps must never become billable windows. */
export const normalizeBoxLifecycleEvent = (
	value: unknown,
): BoxLifecycleEvent | null => {
	const decoded = Schema.decodeUnknownOption(BoxLifecycleEvent)(value);
	return decoded._tag === "Some" ? decoded.value : null;
};

const CLOSING_EVENT_TYPES = new Set(["box.archived", "box.error"]);

export interface BoxIngestionResult {
	readonly eventInserted: boolean;
	readonly metered: boolean;
	readonly reason?:
		| "non-final"
		| "unmatched"
		| "no-period"
		| "cutover-not-configured"
		| "pre-cutover";
}

/** Store a delivery and meter its stable provider-time execution association. */
export const ingestBoxLifecycleEvent = Effect.fn("ingestBoxLifecycleEvent")(
	function* (input: {
		readonly event: BoxLifecycleEvent;
		readonly rawPayload: unknown;
		readonly source: "webhook" | "poll";
		readonly deliveryId: string;
		readonly nowMs: number;
	}) {
		const billingStore = yield* CloudBillingStore;
		const event = input.event;
		const boxId = event.data.box.id;
		const occurredAtMs = Date.parse(event.createdAt);
		if (!Number.isFinite(occurredAtMs))
			return {
				eventInserted: false,
				metered: false,
				reason: "unmatched" as const,
			};
		const eventInserted = yield* billingStore.recordProviderEvent({
			provider: "box",
			eventId: event.id,
			type: event.type,
			providerResourceId: boxId,
			occurredAtMs,
			payload: input.rawPayload,
			receivedAtMs: input.nowMs,
			expiresAtMs: input.nowMs + 90 * 24 * 60 * 60 * 1_000,
		});
		yield* billingStore.recordProviderDelivery({
			provider: "box",
			deliveryId: input.deliveryId,
			eventId: event.id,
			source: input.source,
			status: eventInserted ? "accepted" : "duplicate",
			receivedAtMs: input.nowMs,
		});
		const providerTimestamp = Date.parse(event.createdAt);
		if (
			eventInserted &&
			Number.isFinite(providerTimestamp) &&
			input.nowMs - providerTimestamp > 5 * 60_000
		)
			console.warn(
				"[cloud-billing] Box lifecycle event lag exceeded five minutes",
				{ eventId: event.id, lagMs: input.nowMs - providerTimestamp },
			);
		if (!CLOSING_EVENT_TYPES.has(event.type))
			return { eventInserted, metered: false, reason: "non-final" as const };

		// Multiple closing deliveries may identify one execution; execution metering
		// deduplicates by opening ID. Never fall back to an older unpaired opening.
		const opening = yield* billingStore.pairProviderOpening({
			provider: "box",
			providerResourceId: boxId,
			openingType: "box.ready",
			closingEventId: event.id,
			closedAtMs: occurredAtMs,
		});
		if (opening === null) {
			if (eventInserted)
				console.warn("[cloud-billing] Box close event without an open window", {
					eventId: event.id,
					boxId,
				});
			return { eventInserted, metered: false, reason: "unmatched" as const };
		}

		// Box names are lossy labels, so the internal resource resolves through
		// the provider-keyed store lookups rather than name parsing.
		const workspaceStore = yield* CloudWorkspaceStore;
		const workspace = yield* workspaceStore.findWorkspaceByProviderSandbox(
			"box",
			boxId,
		);
		const build =
			workspace === null
				? yield* workspaceStore.findBuildByProviderSandbox("box", boxId)
				: null;
		const internalResourceId = workspace?.workspaceId ?? build?.buildId;
		if (internalResourceId === undefined) {
			if (eventInserted)
				console.warn("[cloud-billing] unmatched Box lifecycle event", {
					eventId: event.id,
					boxId,
				});
			return { eventInserted, metered: false, reason: "unmatched" as const };
		}

		// The webhook payload carries no compute dimensions; the configured
		// adapter's machine profile is the deterministic source.
		const adapter = yield* (yield* SandboxProviders)
			.get("box")
			.pipe(
				Effect.catchTag("ProviderSelectionError", () => Effect.succeed(null)),
			);
		if (adapter === null) {
			if (eventInserted)
				console.warn(
					"[cloud-billing] Box lifecycle event without a configured adapter",
					{ eventId: event.id },
				);
			return { eventInserted, metered: false, reason: "unmatched" as const };
		}

		const resources = resolveSandboxResources(
			adapter,
			typeof workspace?.requestConfig.sizeId === "string"
				? workspace.requestConfig.sizeId
				: undefined,
		);
		const startedAtMs = opening.startedAtMs;
		const endedAtMs = occurredAtMs;
		if (endedAtMs <= startedAtMs)
			return { eventInserted, metered: false, reason: "unmatched" as const };
		const getUsage = adapter.getUsage;
		if (getUsage === undefined)
			return yield* Effect.fail(serviceUnavailable("box_usage_unavailable"));
		const result = yield* meterProviderExecution({
			reportedCost: (window) =>
				getUsage(boxId, window).pipe(
					Effect.map((usage) => usage.providerCostMicros),
					Effect.mapError(() => serviceUnavailable("box_usage_unavailable")),
				),
			evidence: {
				provider: "box",
				eventId: event.id,
				providerExecutionId: `${boxId}:${opening.eventId}`,
				internalResourceId,
				startedAtMs,
				endedAtMs,
				vcpuCount: resources.vcpuCount,
				memoryMib: resources.memoryMib,
			},
			nowMs: input.nowMs,
		});
		return { eventInserted, ...result };
	},
);
