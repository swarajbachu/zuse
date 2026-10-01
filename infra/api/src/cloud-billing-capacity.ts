import { Effect } from "effect";
import { ensureAccountCloudBillingPeriod } from "./cloud-billing-period.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import { ApiConfiguration } from "./config.ts";

export type CloudBillingCapacity =
	| "available"
	| "period-missing"
	| "billing-hold";

/** Shared policy gate for explicit resume and durable mailbox wake. */
export const cloudBillingCapacity = Effect.fn("cloudBillingCapacity")(
	function* (accountId: string, nowMs: number) {
		const config = yield* ApiConfiguration;
		if (
			!config.cloudBillingEnforcementEnabled &&
			(config.cloudBoxdEstimatesCutoverAtMs === undefined ||
				nowMs < config.cloudBoxdEstimatesCutoverAtMs)
		)
			return "available" as const;
		const billingStore = yield* CloudBillingStore;
		const period = yield* ensureAccountCloudBillingPeriod(
			accountId,
			nowMs,
		).pipe(Effect.provideService(CloudBillingStore, billingStore));
		if (period === null) return "period-missing" as const;
		const summary = yield* billingStore.summary(period);
		return summary.status === "billing-hold" || summary.status === "ended"
			? ("billing-hold" as const)
			: ("available" as const);
	},
);
