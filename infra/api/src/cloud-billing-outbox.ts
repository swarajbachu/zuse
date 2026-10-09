import { BillingProviders } from "@zuse/billing-providers";
import { Effect } from "effect";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { reconcileSnapshotStorage } from "./cloud-snapshot-storage.ts";
import { flushCloudUsage } from "./cloud-usage.ts";
import { ApiConfiguration } from "./config.ts";

export const flushCloudBillingOutbox = Effect.fn("flushCloudBillingOutbox")(
	function* (nowMs: number, limit = 25, enabled = true) {
		if (!enabled) return 0;
		const store = yield* CloudBillingStore;
		const providers = yield* BillingProviders;
		const pending = yield* store.pendingOutbox(nowMs, limit);
		let acknowledged = 0;
		for (const item of pending) {
			const providerId = item.provider ?? "polar";
			const provider = yield* providers
				.get(providerId)
				.pipe(Effect.catch(() => Effect.succeed(null)));
			if (provider?.reportMeterEvent === undefined) {
				yield* store.retryOutbox(item.outboxId, nowMs, "provider-unavailable");
				continue;
			}
			if (nowMs - item.createdAtMs > 15 * 60_000)
				console.warn("[cloud-billing] billing export lag exceeded 15 minutes", {
					outboxId: item.outboxId,
					provider: providerId,
					lagMs: nowMs - item.createdAtMs,
				});
			const result = yield* provider
				.reportMeterEvent({
					accountId: item.accountId,
					eventName: "zuse_cloud_overage_cent",
					units: item.amountCents,
					idempotencyKey: item.idempotencyKey,
					occurredAtMs: item.occurredAtMs ?? item.createdAtMs,
					metadata: {
						billing_period_id: item.periodId,
						...(item.providerSubscriptionId
							? { provider_subscription_id: item.providerSubscriptionId }
							: {}),
						...(item.periodStartMs !== undefined
							? { period_start_ms: String(item.periodStartMs) }
							: {}),
						...(item.periodEndMs !== undefined
							? { period_end_ms: String(item.periodEndMs) }
							: {}),
					},
				})
				.pipe(Effect.timeout("15 seconds"), Effect.result);
			if (result._tag === "Success") {
				yield* store.acknowledgeOutbox(item.outboxId, nowMs);
				acknowledged++;
			} else {
				yield* store.retryOutbox(
					item.outboxId,
					nowMs,
					result.failure._tag === "TimeoutError"
						? "timeout"
						: result.failure.code,
				);
			}
		}
		return acknowledged;
	},
);

export const reconcileCloudMeters = Effect.fn("reconcileCloudMeters")(
	function* (nowMs: number, limit = 25) {
		const store = yield* CloudBillingStore;
		const config = yield* ApiConfiguration;

		const providers = yield* BillingProviders;
		const pending = yield* store.pendingMeterReconciliations(nowMs, limit);
		let reconciled = 0;
		for (const item of pending) {
			const providerId = item.provider ?? "polar";
			const meterId =
				providerId === "stripe"
					? config.cloudBillingStripeMeterId
					: providerId === "polar"
						? config.cloudBillingPolarMeterId
						: undefined;
			const provider = yield* providers
				.get(providerId)
				.pipe(Effect.catch(() => Effect.succeed(null)));
			if (!meterId || provider?.reconcileMeter === undefined) continue;
			const result = yield* provider
				.reconcileMeter({
					accountId: item.accountId,
					meterId,
					periodStartMs: item.periodStartMs,
					periodEndMs: item.periodEndMs,
				})
				.pipe(Effect.timeout("15 seconds"), Effect.result);
			if (result._tag === "Failure") continue;
			yield* store.recordMeterReconciliation({
				periodId: item.periodId,
				provider: providerId,
				expectedUnits: item.expectedUnits,
				observedUnits: result.success,
				nowMs,
			});
			if (result.success !== item.expectedUnits) {
				console.warn("[cloud-billing] billing meter reconciliation mismatch", {
					periodId: item.periodId,
					expectedUnits: item.expectedUnits,
					observedUnits: result.success,
				});
			}
			reconciled++;
		}
		return reconciled;
	},
);

export const maintainCloudBilling = Effect.fn("maintainCloudBilling")(
	function* (nowMs: number) {
		const store = yield* CloudBillingStore;
		const config = yield* ApiConfiguration;

		const exported = yield* flushCloudBillingOutbox(
			nowMs,
			25,
			config.cloudBillingExportEnabled,
		).pipe(Effect.provideService(CloudBillingStore, store));
		const usageExported = yield* flushCloudUsage(nowMs).pipe(
			Effect.catchCause(() => {
				console.warn("[cloud-usage] export maintenance failed");
				return Effect.succeed(0);
			}),
		);
		const [meterReconciled, purgedRawEvents] = yield* Effect.all([
			reconcileCloudMeters(nowMs).pipe(
				Effect.provideService(CloudBillingStore, store),
			),
			store.purgeExpiredRawEvents(nowMs),
		]);
		yield* reconcileSnapshotStorage(nowMs).pipe(
			Effect.catchCause(() => {
				console.warn("[cloud-snapshots] storage maintenance failed");
				return Effect.void;
			}),
		);
		return { exported, usageExported, meterReconciled, purgedRawEvents };
	},
);

/** @deprecated Use reconcileCloudMeters for mixed billing ownership. */
export const reconcilePolarCloudMeter = reconcileCloudMeters;
