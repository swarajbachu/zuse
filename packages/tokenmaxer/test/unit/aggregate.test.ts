import { describe, expect, it } from "vitest";

import {
	buildUsageReport,
	type ModelPricing,
	makeUsageRecord,
	priceRecords,
	withDuplicateFlags,
} from "../../src/index.ts";

const PRICING = new Map<string, ModelPricing>([
	[
		"claude-sonnet-4-6",
		{ input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
	],
]);

describe("tokenmaxer aggregation", () => {
	it("buckets records by local day and preserves unknown costs", () => {
		const records = priceRecords(
			[
				makeUsageRecord({
					sourceId: "zuse",
					sourceLabel: "Zuse (Beta)",
					providerId: "claude",
					model: "claude-sonnet-4-6",
					sessionId: "s1",
					startedAt: "2026-06-20T20:00:00.000Z",
					counts: { inputTokens: 1000, outputTokens: 500 },
					provenance: "fixture",
				}),
				makeUsageRecord({
					sourceId: "codex",
					sourceLabel: "Codex",
					providerId: "codex",
					model: "unpriced-model",
					sessionId: "s2",
					startedAt: "2026-06-21T01:00:00.000Z",
					counts: { inputTokens: 200, outputTokens: 100 },
					provenance: "fixture",
					confidence: "partial",
				}),
			],
			PRICING,
		);

		const report = buildUsageReport({
			records,
			sources: [],
			bucket: "daily",
			filters: { timezone: "UTC", includePossibleDuplicates: true },
		});

		expect(report.groups.map((g) => g.key)).toEqual([
			"2026-06-20",
			"2026-06-21",
		]);
		expect(report.summary.inputTokens).toBe(1200);
		expect(report.summary.outputTokens).toBe(600);
		// One model is priced, the other is unknown → partial.
		expect(report.summary.costStatus).toBe("partial");
		expect(report.summary.costUsd).toBeCloseTo(1000 * 3e-6 + 500 * 1.5e-5);
	});

	it("scopes by project path roots, matching worktrees under a root", () => {
		const make = (workspacePath: string, sessionId: string) =>
			makeUsageRecord({
				sourceId: "claude",
				sourceLabel: "Claude Code",
				providerId: "claude",
				model: "claude-opus-4-8",
				sessionId,
				workspacePath,
				startedAt: "2026-06-21T00:00:00.000Z",
				counts: { inputTokens: 10, outputTokens: 5 },
				provenance: "fixture",
			});
		const records = [
			make("/Users/me/.zuse/forkzero-25da31cf/golem-64", "in-worktree"),
			make("/Users/me/Developer/forkzero", "in-repo"),
			make("/Users/me/.zuse/other-aaaa/wt", "other-project"),
		];

		const report = buildUsageReport({
			records,
			sources: [],
			bucket: "session",
			filters: {
				projectPaths: [
					"/Users/me/Developer/forkzero",
					"/Users/me/.zuse/forkzero-25da31cf",
				],
				includePossibleDuplicates: true,
			},
		});

		expect(report.summary.recordCount).toBe(2);
		expect(report.bySession.map((s) => s.key).sort()).toEqual([
			"in-repo",
			"in-worktree",
		]);
	});

	it("filters records by provider independently of their log source", () => {
		const records = ["claude", "codex"].map((providerId) =>
			makeUsageRecord({
				sourceId: "zuse",
				sourceLabel: "Zuse (Beta)",
				providerId,
				model: `${providerId}-model`,
				sessionId: `${providerId}-session`,
				startedAt: "2026-06-21T00:00:00.000Z",
				counts: { inputTokens: 10, outputTokens: 5 },
				provenance: "fixture",
			}),
		);

		const report = buildUsageReport({
			records,
			sources: [],
			bucket: "session",
			filters: { providerIds: ["codex"], includePossibleDuplicates: true },
		});

		expect(report.summary.recordCount).toBe(1);
		expect(report.bySession.map((session) => session.key)).toEqual([
			"codex-session",
		]);
	});

	it("marks duplicate-looking rows and excludes them by default", () => {
		const base = makeUsageRecord({
			sourceId: "zuse",
			sourceLabel: "Zuse (Beta)",
			providerId: "claude",
			model: "claude-sonnet-4-6",
			sessionId: "same",
			projectPath: "/repo",
			startedAt: "2026-06-21T00:00:00.000Z",
			counts: { inputTokens: 10, outputTokens: 5 },
			provenance: "zuse",
		});
		const dup = {
			...base,
			id: "claude-dup",
			sourceId: "claude" as const,
			sourceLabel: "Claude",
		};
		const records = withDuplicateFlags([base, dup]);

		expect(records[1]?.possibleDuplicate).toBe(true);
		const report = buildUsageReport({ records, sources: [], bucket: "daily" });
		expect(report.summary.recordCount).toBe(1);
	});
});
