import { describe, expect, it } from "vitest";

import { mapKiroUsageLimits } from "../../src/usage/limits/kiro-usage.ts";

describe("mapKiroUsageLimits", () => {
	it("maps credit breakdown into windows + remaining credits", () => {
		const result = mapKiroUsageLimits(
			{
				nextDateReset: 1_788_220_800,
				subscriptionInfo: {
					subscriptionTitle: "KIRO PRO+",
					type: "Q_DEVELOPER_STANDALONE_PRO_PLUS",
				},
				usageBreakdownList: [
					{
						resourceType: "CREDIT",
						displayName: "Credit",
						displayNamePlural: "Credits",
						currentUsage: 520,
						currentUsageWithPrecision: 520.77,
						usageLimit: 2000,
						usageLimitWithPrecision: 2000,
						nextDateReset: 1_788_220_800,
					},
				],
			},
			"2026-08-08T00:00:00.000Z",
		);

		expect(result.providerId).toBe("kiro");
		expect(result.planLabel).toBe("KIRO PRO+");
		expect(result.creditsRemaining).toBeCloseTo(1479.23, 2);
		expect(result.windows).toHaveLength(1);
		expect(result.windows[0]?.id).toBe("monthly:credit");
		expect(result.windows[0]?.label).toBe("Monthly (Credits)");
		expect(result.windows[0]?.usedPercent).toBeCloseTo(26.0385, 2);
		expect(result.windows[0]?.resetsAt).toBe("2026-09-01T00:00:00.000Z");
		expect(result.source).toBe("api");
	});

	it("handles empty breakdowns", () => {
		const result = mapKiroUsageLimits({
			subscriptionInfo: { subscriptionTitle: "KIRO FREE" },
			usageBreakdownList: [],
		});
		expect(result.planLabel).toBe("KIRO FREE");
		expect(result.windows).toEqual([]);
		expect(result.creditsRemaining).toBeNull();
	});
});
