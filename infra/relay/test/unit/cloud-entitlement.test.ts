import { describe, expect, test } from "vitest";
import { hasUsableCloudWorkspaceEntitlement } from "../../src/cloud-entitlement.ts";
import type { EntitlementPersistenceRecord } from "../../src/machine-store.ts";

const entitlement = (
	status: EntitlementPersistenceRecord["status"],
	paidThroughMs?: number,
): EntitlementPersistenceRecord => ({
	entitlementId: "ent_cloud",
	accountId: "account_a",
	kind: "cloud-workspace",
	offerId: "cloud-workspace-standard-v1",
	provider: "polar",
	providerSubscriptionId: "subscription_a",
	status,
	paidThroughMs,
	createdAtMs: 1,
	updatedAtMs: 1,
});

describe("cloud workspace entitlement access", () => {
	test("honors a canceled subscription through its paid period", () => {
		expect(
			hasUsableCloudWorkspaceEntitlement([entitlement("ended", 2_000)], 1_000),
		).toBe(true);
	});

	test("rejects a canceled subscription after its paid period", () => {
		expect(
			hasUsableCloudWorkspaceEntitlement([entitlement("ended", 1_000)], 2_000),
		).toBe(false);
	});
});
