import { BillingProviders } from "@zuse/billing-providers";
import { Effect } from "effect";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import {
	resolveConnectedProvider,
	resourceProviderConnectionId,
} from "./cloud-provider-connections.ts";
import type { RuntimeObservation } from "./cloud-usage-store.ts";
import { ApiConfiguration } from "./config.ts";

export const observeCloudRuntimeUsage = Effect.fn("observeCloudRuntimeUsage")(
	function* (
		input: Omit<RuntimeObservation, "providerSandboxId"> & {
			readonly providerSandboxId?: string;
		},
	) {
		if (
			!(yield* ApiConfiguration).cloudUsageExportEnabled ||
			input.providerSandboxId === undefined
		)
			return;
		const provider = yield* resolveConnectedProvider(
			input.accountId,
			input.provider,
			yield* resourceProviderConnectionId(input.resourceKind, input.resourceId),
		);
		const running =
			input.runningSinceMs !== undefined
				? yield* provider.inspect(input.providerSandboxId).pipe(
						Effect.timeout("2 seconds"),
						Effect.map((sandbox) => sandbox?.state === "running"),
						Effect.catch(() => Effect.succeed(false)),
					)
				: false;
		yield* (yield* CloudBillingStore).recordRuntimeObservation({
			...input,
			providerSandboxId: input.providerSandboxId,
			runningSinceMs: running ? input.runningSinceMs : undefined,
		});
	},
	// Telemetry failure must not prevent a pause, deletion, or workspace recovery.
	Effect.catchCause(() =>
		Effect.sync(() => {
			console.warn("[cloud-usage] runtime observation failed");
		}),
	),
);

export const flushCloudUsage = Effect.fn("flushCloudUsage")(function* (
	nowMs: number,
	limit = 100,
) {
	if (!(yield* ApiConfiguration).cloudUsageExportEnabled) return 0;
	const providers = yield* BillingProviders;
	if (!providers.providerIds.includes("polar")) return 0;
	const provider = yield* providers.get("polar").pipe(Effect.orDie);
	const reportMeterEvent = provider.reportMeterEvent;
	if (reportMeterEvent === undefined) return 0;
	const store = yield* CloudBillingStore;
	const pending = yield* store.pendingUsageExports(nowMs, limit);
	const results = yield* Effect.forEach(
		pending,
		(event) =>
			Effect.gen(function* () {
				const result = yield* reportMeterEvent({
					accountId: event.accountId,
					eventName: event.eventName,
					units: event.units,
					idempotencyKey: event.eventId,
					occurredAtMs: event.occurredAtMs,
					metadata: event.metadata,
				}).pipe(Effect.timeout("10 seconds"), Effect.result);
				if (result._tag === "Success") {
					yield* store.acknowledgeUsageExport(event.eventId, nowMs);
					return 1;
				} else {
					const code =
						result.failure._tag === "TimeoutError"
							? "timeout"
							: result.failure.code;
					yield* store.retryUsageExport(event.eventId, nowMs, code);
					console.warn("[cloud-usage] Polar export failed", {
						eventId: event.eventId,
						code,
					});
					return 0;
				}
			}),
		{ concurrency: 5 },
	);
	return results.reduce<number>((sum, count) => sum + count, 0);
});
