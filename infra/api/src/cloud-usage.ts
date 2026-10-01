import { BillingProviders } from "@zuse/billing-providers";
import { SandboxProviders } from "@zuse/sandbox-providers";
import { Effect } from "effect";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import type { RuntimeObservation } from "./cloud-usage-store.ts";
import { ApiConfiguration } from "./config.ts";

export const observeCloudRuntimeUsage = Effect.fn("observeCloudRuntimeUsage")(
	function* (
		input: Omit<RuntimeObservation, "providerSandboxId"> & {
			readonly providerSandboxId?: string;
		},
	) {
		const config = yield* ApiConfiguration;
		const estimateCutoverAtMs =
			input.provider === "boxd"
				? config.cloudBoxdEstimatesCutoverAtMs
				: undefined;
		if (
			(!config.cloudUsageExportEnabled && estimateCutoverAtMs === undefined) ||
			input.providerSandboxId === undefined
		)
			return true;
		const provider = yield* (yield* SandboxProviders).get(input.provider);
		const sandbox = yield* provider.inspect(input.providerSandboxId).pipe(
			Effect.timeout("2 seconds"),
			Effect.catch(() => Effect.succeed(undefined)),
		);
		const running = sandbox?.state === "running";
		yield* (yield* CloudBillingStore).recordRuntimeObservation(
			{
				...input,
				providerSandboxId: input.providerSandboxId,
				// Actual provider state takes precedence over a stale reconciler state.
				runningSinceMs: running
					? (input.runningSinceMs ?? input.observedAtMs)
					: undefined,
			},
			{ exportRuntime: config.cloudUsageExportEnabled, estimateCutoverAtMs },
		);
		return sandbox !== undefined;
	},
	// Telemetry failure must not prevent a pause, deletion, or workspace recovery.
	Effect.catchCause(() =>
		Effect.sync(() => {
			console.warn("[cloud-usage] runtime observation failed");
			return false;
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
