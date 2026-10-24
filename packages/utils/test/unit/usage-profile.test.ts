import { describe, expect, it } from "vitest";
import {
	usageProfileActivity,
	usageProfileSnapshot,
	validUsageProfileSnapshot,
} from "../../src/usage-profile.ts";

const snapshot = {
	year: 2024,
	generatedAt: "2024-03-02T12:00:00.000Z",
	sessionCount: 2,
	days: [
		{ date: "2024-02-28", tokens: 10 },
		{ date: "2024-02-29", tokens: 10 },
		{ date: "2024-03-01", tokens: 10 },
	],
	models: [{ name: "Model A", tokens: 30 }],
	breakdown: {
		input: 10,
		output: 10,
		cacheRead: 5,
		cacheWrite: 3,
		reasoning: 2,
	},
	sources: [{ id: "claude", label: "Claude Code", tokens: 30 }],
	months: [
		{ month: 2, models: [{ name: "Model A", tokens: 20 }] },
		{ month: 3, models: [{ name: "Model A", tokens: 10 }] },
	],
	projectCount: 1,
	sessionMinutes: { median: 5, longest: 10 },
	cost: null,
	hours: null,
};
describe("usage profile activity", () => {
	it("covers leap years and derives a streak through yesterday without breaking it today", () => {
		const result = usageProfileActivity(snapshot);
		expect(result.days).toHaveLength(366);
		expect(result).toMatchObject({
			totalTokens: 30,
			activeDays: 3,
			longestStreak: 3,
			currentStreak: 3,
		});
		expect(validUsageProfileSnapshot(snapshot)).toBe(true);
	});
	it("breaks a current streak after a missed full day and leaves future dates uncovered", () => {
		const result = usageProfileActivity({
			...snapshot,
			generatedAt: "2024-03-03T12:00:00.000Z",
		});
		expect(result.currentStreak).toBe(0);
		expect(result.days.find((day) => day.date === "2024-03-04")?.covered).toBe(
			false,
		);
	});
	it("handles empty activity without inventing statistics", () => {
		expect(
			usageProfileActivity({ ...snapshot, days: [], models: [] }),
		).toMatchObject({
			totalTokens: 0,
			activeDays: 0,
			currentStreak: 0,
			longestStreak: 0,
			activeWeeks: 0,
		});
	});
	it("projects an allowlist and bounds model counts without losing token totals", () => {
		const counts = {
			inputTokens: 1,
			outputTokens: 2,
			cacheReadTokens: 3,
			cacheCreationTokens: 4,
			reasoningTokens: 5,
		};
		const record = (index: number, overrides = {}) => ({
			...counts,
			model: `Model ${index}`,
			sessionId: `private-session-${index % 2}`,
			projectPath: index % 3 === 0 ? "/private/a" : "/private/b",
			workspacePath: null,
			startedAt: new Date(Date.UTC(2024, index % 2, 1, 9, index % 50)),
			endedAt: new Date(Date.UTC(2024, index % 2, 1, 9, (index % 50) + 1)),
			provenance: "log",
			prompt: "private",
			...overrides,
		});
		const records = [
			...Array.from({ length: 70 }, (_, index) => record(index)),
			record(70, {
				provenance: "persisted-daily",
				sessionId: null,
				projectPath: null,
			}),
		];
		const total = 15 * records.length;
		const january = 15 * 36;
		const result = usageProfileSnapshot(
			{
				generatedAt: new Date(snapshot.generatedAt),
				summary: {
					inputTokens: records.length,
					outputTokens: 2 * records.length,
					cacheReadTokens: 3 * records.length,
					cacheCreationTokens: 4 * records.length,
					reasoningTokens: 5 * records.length,
					costUsd: 12.345,
					costStatus: "partial",
				},
				groups: [
					{ ...counts, key: "2024-01-01", inputTokens: 1 + january - 15 },
					{
						...counts,
						key: "2024-02-01",
						inputTokens: 1 + total - january - 15,
					},
				],
				bySource: [
					{
						...counts,
						key: "claude",
						label: "Claude Code",
						inputTokens: 1 + total - 15,
					},
				],
				records,
			},
			2024,
			"America/New_York",
		);
		expect(result.models).toHaveLength(64);
		expect(result.models.at(-1)?.name).toBe("Other models");
		expect(result.models.reduce((sum, model) => sum + model.tokens, 0)).toBe(
			total,
		);
		expect(result.months.map((month) => month.month)).toEqual([1, 2]);
		expect(result.months.every((month) => month.models.length <= 9)).toBe(true);
		expect(result.projectCount).toBe(2);
		expect(result.sessionMinutes).toEqual({ median: 49, longest: 49 });
		expect(result.cost).toEqual({ usd: 12.35, complete: false });
		expect(result.hours?.[4]).toBe(total - 15);
		expect(result.hours?.reduce((sum, value) => sum + value, 0)).toBe(
			total - 15,
		);
		expect(result.sessionCount).toBe(2);
		expect(JSON.stringify(result)).not.toContain("private");
		expect(validUsageProfileSnapshot(result, Date.parse("2024-03-03"))).toBe(
			true,
		);
	});
	it("rejects inconsistent aggregate sections", () => {
		for (const invalid of [
			{ ...snapshot, breakdown: { ...snapshot.breakdown, input: 11 } },
			{
				...snapshot,
				sources: [{ id: "claude", label: "Claude Code", tokens: 29 }],
			},
			{ ...snapshot, months: snapshot.months.slice(1) },
			{ ...snapshot, sessionMinutes: { median: 11, longest: 10 } },
			{ ...snapshot, hours: Array.from({ length: 24 }, () => 2) },
		])
			expect(validUsageProfileSnapshot(invalid)).toBe(false);
	});
});
