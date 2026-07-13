import { describe, expect, it } from "vitest";
import { resetsInLabel } from "../../src/components/usage/usage-meter.tsx";
import { usagePace } from "../../src/lib/usage-pace.ts";

describe("usage limit display helpers", () => {
	it("formats reset countdowns with two useful units", () => {
		expect(
			resetsInLabel("2026-01-03T20:00:00Z", Date.parse("2026-01-02T00:00:00Z")),
		).toBe("1d 20h");
		expect(
			resetsInLabel("2026-01-02T04:05:00Z", Date.parse("2026-01-02T00:00:00Z")),
		).toBe("4h 05m");
	});

	it("reports reserve against elapsed window pace", () => {
		const end = Date.parse("2026-01-08T00:00:00Z");
		expect(
			usagePace(
				30,
				new Date(end).toISOString(),
				10_080,
				end - 3.5 * 24 * 60 * 60 * 1_000,
			)?.label,
		).toBe("+20% in reserve");
	});
});
