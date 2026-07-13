import { describe, expect, it } from "vitest";

import { sinceForUsagePeriod } from "../../src/lib/usage-period.ts";

describe("usage period ranges", () => {
	it("maps every preset to one shared exact duration", () => {
		const now = Date.parse("2026-07-13T12:00:00.000Z");

		expect(sinceForUsagePeriod("7d", now).toISOString()).toBe(
			"2026-07-06T12:00:00.000Z",
		);
		expect(sinceForUsagePeriod("30d", now).toISOString()).toBe(
			"2026-06-13T12:00:00.000Z",
		);
		expect(sinceForUsagePeriod("90d", now).toISOString()).toBe(
			"2026-04-14T12:00:00.000Z",
		);
	});
});
