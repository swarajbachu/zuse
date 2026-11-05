import { describe, expect, test } from "vitest";
import {
	nextScheduledAt,
	validateSchedule,
} from "../../src/automation/schedule.ts";

const schedule = (cron: string, timezone = "UTC", onceAt?: string) => ({
	_tag: "schedule" as const,
	cron,
	timezone,
	...(onceAt ? { onceAt } : {}),
});

describe("automation scheduling", () => {
	test("advances strictly beyond a persisted occurrence", () => {
		const trigger = schedule("0 * * * *");
		expect(
			nextScheduledAt(trigger, new Date("2026-10-03T10:00:00Z"))?.toISOString(),
		).toBe("2026-10-03T11:00:00.000Z");
	});
	test("supports weekly ranges and list/step cron fields", () => {
		expect(
			nextScheduledAt(
				schedule("*/15 9-17 * * MON-FRI"),
				new Date("2026-10-02T17:59:59Z"),
			)?.toISOString(),
		).toBe("2026-10-05T09:00:00.000Z");
	});
	test("keeps a daily local time when DST changes", () => {
		const trigger = schedule("0 9 * * *", "America/New_York");
		expect(
			nextScheduledAt(trigger, new Date("2026-03-07T14:00:00Z"))?.toISOString(),
		).toBe("2026-03-08T13:00:00.000Z");
		expect(
			nextScheduledAt(trigger, new Date("2026-10-31T13:00:00Z"))?.toISOString(),
		).toBe("2026-11-01T14:00:00.000Z");
	});
	test("expires a one-time run without rescheduling", () => {
		const trigger = schedule("0 * * * *", "UTC", "2026-10-03T12:30:00+02:00");
		expect(
			nextScheduledAt(trigger, new Date("2026-10-03T10:00:00Z"))?.toISOString(),
		).toBe("2026-10-03T10:30:00.000Z");
		expect(
			nextScheduledAt(trigger, new Date("2026-10-03T10:30:00Z")),
		).toBeNull();
	});
	test("rejects malformed schedules and timezone-ambiguous one-time dates", () => {
		for (const trigger of [
			schedule("* * * * * *"),
			schedule("60 * * * *"),
			schedule("0 * * * *", "Wrong/Zone"),
			schedule("", "UTC", "2026-10-03T12:00:00"),
			schedule("", "UTC", "2026-02-30T12:00:00Z"),
			schedule("", "UTC", "2026-10-03T24:00:00Z"),
		]) {
			expect(() => validateSchedule(trigger)).toThrow();
		}
	});
});
