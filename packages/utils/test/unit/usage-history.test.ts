import { describe, expect, it } from "vitest";
import { validUsageHistoryRow } from "../../src/usage-history.ts";

const now = Date.parse("2026-10-24T12:00:00.000Z");
const row = {
	hour: "2026-10-24T10:00:00.000Z",
	model: "model-a",
	inputTokens: 10,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
	reasoningTokens: 0,
	costUsd: null,
	recordCount: 1,
	firstAt: Date.parse("2026-10-24T10:05:00.000Z"),
	lastAt: Date.parse("2026-10-24T10:06:00.000Z"),
};

describe("usage history row validation", () => {
	it("accepts a well-formed hourly row", () => {
		expect(validUsageHistoryRow(row, now)).toBe(true);
	});

	it.each([
		["a non-canonical hour", { hour: "2026-10-24T10:30:00.000Z" }],
		["an hour before 2020", { hour: "2019-12-31T23:00:00.000Z" }],
		["an hour in the future", { hour: "2026-10-24T15:00:00.000Z" }],
		["an empty model", { model: "" }],
		["a long model", { model: "m".repeat(101) }],
		["fractional tokens", { inputTokens: 1.5 }],
		["negative tokens", { outputTokens: -1 }],
		["unsafe tokens", { reasoningTokens: Number.MAX_SAFE_INTEGER + 2 }],
		["negative cost", { costUsd: -1 }],
		["non-finite cost", { costUsd: Number.POSITIVE_INFINITY }],
		["no records", { recordCount: 0 }],
		[
			"a start outside the hour",
			{ firstAt: Date.parse("2026-10-24T11:00:00.000Z") },
		],
		[
			"an end before the start",
			{ lastAt: Date.parse("2026-10-24T10:00:00.000Z") },
		],
		[
			"an end over a week later",
			{ lastAt: Date.parse("2026-11-01T10:06:00.000Z") },
		],
	])("rejects %s", (_label, change) => {
		expect(validUsageHistoryRow({ ...row, ...change }, now)).toBe(false);
	});
});
