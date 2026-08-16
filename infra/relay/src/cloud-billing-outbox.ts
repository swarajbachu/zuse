import { BillingProviders } from "@zuse/billing-providers";
import { Effect } from "effect";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { RelayConfiguration } from "./config.ts";

export const flushCloudBillingOutbox = Effect.fn("flushCloudBillingOutbox")(
	function* (nowMs: number, limit = 25, enabled = true) {
		if (!enabled) return 0;
		const store = yield* CloudBillingStore;
		const providers = yield* BillingProviders;
		if (!providers.providerIds.includes("polar")) return 0;
		const provider = yield* providers.get("polar").pipe(Effect.orDie);
		if (provider.reportMeterEvent === undefined) return 0;
		const pending = yield* store.pendingOutbox(nowMs, limit);
		let acknowledged = 0;
		for (const item of pending) {
			if (nowMs - item.createdAtMs > 15 * 60_000)
				console.warn("[cloud-billing] Polar export lag exceeded 15 minutes", {
					outboxId: item.outboxId,
					lagMs: nowMs - item.createdAtMs,
				});
			const result = yield* provider
				.reportMeterEvent({
					accountId: item.accountId,
					eventName: "zuse_cloud_overage_cent",
					units: item.amountCents,
					idempotencyKey: item.idempotencyKey,
					metadata: { billing_period_id: item.periodId },
				})
				.pipe(Effect.result);
			if (result._tag === "Success") {
				yield* store.acknowledgeOutbox(item.outboxId, nowMs);
				acknowledged++;
			} else {
				yield* store.retryOutbox(item.outboxId, nowMs, result.failure.code);
			}
		}
		return acknowledged;
	},
);

export const reconcilePolarCloudMeter = Effect.fn("reconcilePolarCloudMeter")(
	function* (nowMs: number, limit = 25) {
		const store = yield* CloudBillingStore;
		const config = yield* RelayConfiguration;
		if (config.cloudBillingPolarMeterId === undefined) return 0;
		const providers = yield* BillingProviders;
		if (!providers.providerIds.includes("polar")) return 0;
		const provider = yield* providers.get("polar").pipe(Effect.orDie);
		if (provider.reconcileMeter === undefined) return 0;
		const pending = yield* store.pendingMeterReconciliations(nowMs, limit);
		let reconciled = 0;
		for (const item of pending) {
			const result = yield* provider
				.reconcileMeter({
					accountId: item.accountId,
					meterId: config.cloudBillingPolarMeterId,
				})
				.pipe(Effect.result);
			if (result._tag === "Failure") continue;
			yield* store.recordMeterReconciliation({
				periodId: item.periodId,
				provider: "polar",
				expectedUnits: item.expectedUnits,
				observedUnits: result.success,
				nowMs,
			});
			if (result.success !== item.expectedUnits) {
				console.warn("[cloud-billing] Polar meter reconciliation mismatch", {
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
		const config = yield* RelayConfiguration;
		const exported = yield* flushCloudBillingOutbox(
			nowMs,
			25,
			config.cloudBillingExportEnabled,
		).pipe(Effect.provideService(CloudBillingStore, store));
		const [meterReconciled, purgedRawEvents] = yield* Effect.all([
			reconcilePolarCloudMeter(nowMs).pipe(
				Effect.provideService(CloudBillingStore, store),
			),
			store.purgeExpiredRawEvents(nowMs),
		]);
		return { exported, meterReconciled, purgedRawEvents };
	},
);
