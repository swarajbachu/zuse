import { UsageReport } from "@zuse/contracts";
import { Effect, Schema } from "effect";
import {
	buildUsageReport,
	makeUsageRecord,
	type PricedUsage,
} from "tokenmaxer";
import { beforeEach, describe, expect, it } from "vitest";
import {
	persistPricedUsageOnce,
	resetPersistedPricedUsageForTest,
} from "../../src/usage/cost-history.ts";
import {
	paginateUsageSessions,
	prepareUsageOverviewForRpc,
	prepareUsageReportForRpc,
	resetUsageReportCacheForTest,
	trimUsageReportForPayload,
} from "../../src/usage/handlers.ts";
import { loadPricedUsageCached } from "../../src/usage/report-cache.ts";

const emptyUsage = (id: string): PricedUsage => ({
	records: [],
	sources: [
		{
			id: "zuse",
			label: `Zuse Alpha ${id}`,
			detected: true,
			recordCount: 0,
			paths: [],
			warning: null,
		},
	],
});

describe("usage report cache", () => {
	beforeEach(() => {
		resetUsageReportCacheForTest();
		resetPersistedPricedUsageForTest();
	});

	it("retries daily persistence after a failed write", async () => {
		const priced = { records: [], sources: [] };
		let calls = 0;
		const persist = () => {
			calls += 1;
			return calls === 1 ? Effect.fail(new Error("disk full")) : Effect.void;
		};

		await expect(
			Effect.runPromise(persistPricedUsageOnce(priced, persist)),
		).rejects.toThrow("disk full");
		await Effect.runPromise(persistPricedUsageOnce(priced, persist));
		await Effect.runPromise(persistPricedUsageOnce(priced, persist));

		expect(calls).toBe(2);
	});

	it("coalesces concurrent cold loads", async () => {
		let calls = 0;
		let resolveLoad: (value: PricedUsage) => void = () => {};
		const load = () => {
			calls += 1;
			return new Promise<PricedUsage>((resolve) => {
				resolveLoad = resolve;
			});
		};

		const first = loadPricedUsageCached("/tmp/zuse.sqlite", "/tmp/tokenmaxer", {
			load,
		});
		const second = loadPricedUsageCached(
			"/tmp/zuse.sqlite",
			"/tmp/tokenmaxer",
			{ load },
		);

		expect(calls).toBe(1);
		resolveLoad(emptyUsage("cold"));
		expect(await first).toBe(await second);
	});

	it("uses fresh cached data unless forceRefresh is set", async () => {
		let calls = 0;
		const load = () => Promise.resolve(emptyUsage(String(++calls)));
		let now = 1_000;

		const first = await loadPricedUsageCached(
			"/tmp/zuse.sqlite",
			"/tmp/tokenmaxer",
			{
				load,
				now: () => now,
			},
		);
		now += 1;
		const cached = await loadPricedUsageCached(
			"/tmp/zuse.sqlite",
			"/tmp/tokenmaxer",
			{
				load,
				now: () => now,
			},
		);
		const refreshed = await loadPricedUsageCached(
			"/tmp/zuse.sqlite",
			"/tmp/tokenmaxer",
			{
				forceRefresh: true,
				load,
				now: () => now,
			},
		);

		expect(calls).toBe(2);
		expect(cached).toBe(first);
		expect(refreshed).not.toBe(first);
	});

	it("prepares a schema-class report for RPC validation", () => {
		const report = buildUsageReport({
			records: [],
			sources: [],
			bucket: "daily",
			filters: { bucket: "daily" },
		});
		const prepared = prepareUsageReportForRpc(report);
		expect(prepared).toBeInstanceOf(UsageReport);
		expect(() => Schema.encodeSync(UsageReport)(prepared)).not.toThrow();
	});

	it("trims raw records and caps sessions by token volume", () => {
		const records = Array.from({ length: 300 }, (_, index) =>
			makeUsageRecord({
				sourceId: "zuse",
				sourceLabel: "Zuse Alpha",
				providerId: "codex",
				model: "gpt-5.4",
				sessionId: `session-${index}`,
				startedAt: new Date(1_800_000_000_000 + index),
				counts: { inputTokens: index + 1, outputTokens: 0 },
				provenance: `fixture-${index}`,
			}),
		);
		const report = buildUsageReport({
			records,
			sources: [],
			bucket: "session",
			filters: { includePossibleDuplicates: true },
		});

		const trimmed = trimUsageReportForPayload(report);

		expect(trimmed.records).toEqual([]);
		expect(trimmed.bySession).toHaveLength(250);
		expect(trimmed.bySession[0]?.key).toBe("session-299");
		expect(trimmed.bySession.at(-1)?.key).toBe("session-50");
	});

	it("keeps the overview projection fast and compact for large histories", () => {
		const records = Array.from({ length: 5_000 }, (_, index) =>
			makeUsageRecord({
				sourceId: "zuse",
				sourceLabel: "Zuse Alpha",
				providerId: "codex",
				model: `model-${index % 8}`,
				sessionId: `session-${index}`,
				projectPath: `/tmp/project-${index % 12}`,
				startedAt: new Date(1_800_000_000_000 + index * 60_000),
				counts: { inputTokens: index + 1, outputTokens: index % 100 },
				provenance: `overview-fixture-${index}`,
			}),
		);
		const startedAt = performance.now();
		const report = buildUsageReport({
			records,
			sources: [],
			bucket: "daily",
			filters: { bucket: "daily", includePossibleDuplicates: true },
		});
		const overview = prepareUsageOverviewForRpc(report, null);
		const elapsed = performance.now() - startedAt;

		expect(elapsed).toBeLessThan(500);
		expect(JSON.stringify(overview).length).toBeLessThan(100_000);
	});

	it("paginates and searches sessions before returning them", () => {
		const records = ["Alpha build", "Beta review", "Alpha tests"].map(
			(label, index) =>
				makeUsageRecord({
					sourceId: "zuse",
					sourceLabel: "Zuse Alpha",
					providerId: "codex",
					model: "gpt-5.4",
					sessionId: label,
					startedAt: new Date(1_800_000_000_000 + index),
					counts: { inputTokens: (index + 1) * 100, outputTokens: 0 },
					provenance: `page-fixture-${index}`,
				}),
		);
		const report = buildUsageReport({
			records,
			sources: [],
			bucket: "session",
			filters: { includePossibleDuplicates: true },
		});

		const page = paginateUsageSessions(report.bySession, {
			query: "alpha",
			sort: "tokens",
			offset: 1,
			limit: 1,
		});

		expect(page.total).toBe(2);
		expect(page.rows).toHaveLength(1);
		expect(page.rows[0]?.label).toBe("Alpha build");
		expect(page.nextOffset).toBeNull();
	});
});
