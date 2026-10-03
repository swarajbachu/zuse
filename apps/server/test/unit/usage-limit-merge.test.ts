import { fractionToPercent, normalizePercent } from "@zuse/utils/usage-values";
import { describe, expect, it } from "vitest";
import {
	mergeUsageLimits,
	type SessionUsageWindow,
} from "../../src/usage/limits/merge.ts";
import { unavailable } from "../../src/usage/limits/shared.ts";

const now = Date.parse("2026-10-03T12:00:00Z");
const event = (
	scope: "session" | "weekly",
	minutesAgo: number,
): SessionUsageWindow => ({
	providerId: "claude",
	createdAt: new Date(now - minutesAgo * 60000).toISOString(),
	window: {
		id: scope,
		label: scope,
		scope,
		usedPercent: 0.5,
		resetsAt: null,
		windowMinutes: scope === "session" ? 300 : 10080,
	},
});
describe("usage normalization and fallback", () => {
	it.each([0, 0.5, 1, 100])("keeps API %s percent in percent units", (value) =>
		expect(normalizePercent(value)).toBe(value));
	it.each([
		[0, 0],
		[0.005, 0.5],
		[0.5, 50],
		[1, 100],
	])("converts streamed fraction %s to %s percent", (value, expected) =>
		expect(fractionToPercent(value)).toBe(expected));
	it("falls back to both fresh session windows after a newer failed fetch", () => {
		const result = mergeUsageLimits(
			[
				{
					...unavailable("claude", "error"),
					fetchedAt: new Date(now).toISOString(),
				},
			],
			[event("session", 1), event("weekly", 2)],
			now,
		);
		expect(result[0]?.windows).toHaveLength(2);
		expect(result[0]?.fetchedAt).toBe(event("session", 1).createdAt);
	});
	it("ignores expired and old unknown-reset windows", () => {
		const old = event("session", 31);
		const reset = {
			...event("weekly", 1),
			window: {
				...event("weekly", 1).window,
				resetsAt: new Date(now - 1).toISOString(),
			},
		};
		expect(mergeUsageLimits([], [old, reset], now)).toEqual([]);
	});
	it("keeps retained snapshot windows stale when a session window updates", () => {
		const fetchedAt = event("weekly", 10).createdAt;
		const result = mergeUsageLimits(
			[
				{
					...unavailable("claude", "timeout"),
					fetchedAt,
					windows: [event("session", 10).window, event("weekly", 10).window],
				},
			],
			[
				{
					...event("session", 1),
					window: { ...event("session", 1).window, usedPercent: 20 },
				},
			],
			now,
		);
		expect(result[0]).toMatchObject({
			unavailableReason: "timeout",
			fetchedAt,
		});
		expect(
			result[0]?.windows.find((w) => w.scope === "session")?.usedPercent,
		).toBe(20);
		expect(
			result[0]?.windows.find((w) => w.scope === "weekly")?.usedPercent,
		).toBe(0.5);
	});
});

describe("historical usage records", () => {
	it("ignores malformed persisted rows without failing the whole request", async () => {
		const { parseSessionUsageWindow } = await import(
			"../../src/usage/limits/session-events.ts"
		);
		expect(
			parseSessionUsageWindow(
				'{"providerId":"claude"}',
				new Date(now).toISOString(),
			),
		).toBeNull();
		expect(
			parseSessionUsageWindow("null", new Date(now).toISOString()),
		).toBeNull();
		expect(
			parseSessionUsageWindow(
				JSON.stringify({
					...event("session", 1).window,
					providerId: "invalid",
				}),
				new Date(now).toISOString(),
			),
		).toBeNull();
	});
	it("keeps legacy Claude model labels in model scope", async () => {
		const { parseSessionUsageWindow } = await import(
			"../../src/usage/limits/session-events.ts"
		);
		const window = event("weekly", 1).window;
		const result = parseSessionUsageWindow(
			JSON.stringify({
				...window,
				scope: undefined,
				providerId: "claude",
				label: "Weekly limit (Opus)",
			}),
			new Date(now).toISOString(),
		);
		expect(result?.window).toMatchObject({
			scope: "model",
			label: "Opus only",
		});
	});
});
