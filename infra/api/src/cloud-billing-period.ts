import { CLOUD_WORKSPACE_OFFER_ID } from "@zuse/contracts";
import { Effect } from "effect";
import {
	type CloudBillingPeriodRecord,
	CloudBillingStore,
} from "./cloud-billing-store.ts";
import { MachineStore } from "./machine-store.ts";

export const calendarBillingPeriod = (nowMs: number) => {
	const now = new Date(nowMs);
	return {
		periodStartMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
		periodEndMs: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
	};
};

export const cloudBillingPeriodStatus = (input: {
	readonly provider: string;
	readonly subscriptionStatus: "pending" | "active" | "grace" | "ended";
	readonly paidThroughMs?: number;
	readonly nowMs: number;
}): CloudBillingPeriodRecord["status"] => {
	if (input.provider === "manual") return "manual";
	if (
		input.subscriptionStatus === "pending" ||
		input.subscriptionStatus === "grace"
	)
		return "billing-hold";
	if (
		input.subscriptionStatus === "ended" &&
		(input.paidThroughMs ?? 0) <= input.nowMs
	)
		return "ended";
	return "active";
};

export const ensureCloudBillingPeriod = Effect.fn("ensureCloudBillingPeriod")(
	function* (input: {
		readonly accountId: string;
		readonly provider: string;
		readonly providerSubscriptionId?: string;
		readonly subscriptionStatus: "pending" | "active" | "grace" | "ended";
		readonly periodStartMs: number;
		readonly periodEndMs: number;
		readonly nowMs: number;
	}) {
		const store = yield* CloudBillingStore;
		return yield* store.ensurePeriod({
			periodId: `cloud:${input.accountId}:${input.periodStartMs}`,
			accountId: input.accountId,
			providerSubscriptionId: input.providerSubscriptionId,
			status: cloudBillingPeriodStatus({
				provider: input.provider,
				subscriptionStatus: input.subscriptionStatus,
				paidThroughMs: input.periodEndMs,
				nowMs: input.nowMs,
			}),
			periodStartMs: input.periodStartMs,
			periodEndMs: input.periodEndMs,
			nowMs: input.nowMs,
		});
	},
);

export const ensureAccountCloudBillingPeriod = Effect.fn(
	"ensureAccountCloudBillingPeriod",
)(function* (accountId: string, nowMs: number) {
	const machineStore = yield* MachineStore;
	const entitlement = (yield* machineStore.listEntitlements(accountId)).find(
		(item) =>
			item.offerId === CLOUD_WORKSPACE_OFFER_ID &&
			(item.paidThroughMs === undefined || item.paidThroughMs > nowMs),
	);
	if (entitlement === undefined) return null;
	const fallback = calendarBillingPeriod(nowMs);
	return yield* ensureCloudBillingPeriod({
		accountId,
		provider: entitlement.provider,
		providerSubscriptionId: entitlement.providerSubscriptionId,
		subscriptionStatus: entitlement.status,
		periodStartMs: entitlement.periodStartMs ?? fallback.periodStartMs,
		periodEndMs: entitlement.paidThroughMs ?? fallback.periodEndMs,
		nowMs,
	});
});
