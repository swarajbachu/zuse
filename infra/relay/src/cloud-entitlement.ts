import type { EntitlementPersistenceRecord } from "./machine-store.ts";

export const hasUsableCloudWorkspaceEntitlement = (
	entitlements: ReadonlyArray<EntitlementPersistenceRecord>,
	nowMs: number,
): boolean =>
	entitlements.some((item) => {
		if (item.kind !== "cloud-workspace") return false;
		const paidAccessRemaining =
			item.paidThroughMs !== undefined && item.paidThroughMs > nowMs;
		return (
			(item.status === "active" ||
				item.status === "grace" ||
				(item.status === "ended" && paidAccessRemaining)) &&
			(item.paidThroughMs === undefined || paidAccessRemaining)
		);
	});
