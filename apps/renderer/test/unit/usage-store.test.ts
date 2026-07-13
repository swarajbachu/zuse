import type { UsageOverview } from "@zuse/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

let reportCalls: Array<{
	readonly forceRefresh?: boolean;
	readonly since?: Date;
	readonly until?: Date;
}> = [];
let pendingReports: Array<{
	readonly resolve: (report: UsageOverview) => void;
	readonly reject: (error: unknown) => void;
}> = [];

const { setUsageRpcClientForTest, useUsageStore } = await import(
	"../../src/store/usage.ts"
);

setUsageRpcClientForTest(
	async () =>
		({
			"usage.overview": (payload: {
				readonly forceRefresh?: boolean;
				readonly since?: Date;
				readonly until?: Date;
			}) => {
				reportCalls.push(payload);
				return Effect.promise(
					() =>
						new Promise<UsageOverview>((resolve, reject) => {
							pendingReports.push({ resolve, reject });
						}),
				);
			},
		}) as unknown as Awaited<
			ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
		>,
);

const makeReport = (recordCount: number): UsageOverview =>
	({
		bucket: "daily",
		generatedAt: new Date("2026-06-21T00:00:00.000Z"),
		summary: {
			inputTokens: recordCount,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheCreationTokens: 0,
			reasoningTokens: 0,
			costUsd: null,
			costStatus: "unknown",
			recordCount,
			possibleDuplicateCount: 0,
		},
		groups: [],
		bySource: [],
		byModel: [],
		byProject: [],
		previousBySource: [],
		previousByModel: [],
		previousByProject: [],
		sessionCount: recordCount,
		previousSummary: null,
		previousSessionCount: null,
		sources: [],
	}) as UsageOverview;

describe("usage store", () => {
	beforeEach(() => {
		reportCalls = [];
		pendingReports = [];
		useUsageStore.setState({
			report: null,
			loading: false,
			refreshing: false,
			error: null,
			period: "7d",
			selectedRange: null,
			requestId: 0,
			cache: {},
		});
	});

	it("keeps the newest usage response when older requests resolve later", async () => {
		const first = useUsageStore.getState().refresh(null);
		const second = useUsageStore.getState().refresh(null);
		await Promise.resolve();

		expect(pendingReports).toHaveLength(2);
		pendingReports[1]?.resolve(makeReport(2));
		await second;
		expect(useUsageStore.getState().report?.summary.recordCount).toBe(2);

		pendingReports[0]?.resolve(makeReport(1));
		await first;
		expect(useUsageStore.getState().report?.summary.recordCount).toBe(2);
	});

	it("passes forceRefresh only for explicit refreshes", async () => {
		const request = useUsageStore
			.getState()
			.refresh(null, { forceRefresh: true });
		await Promise.resolve();

		expect(reportCalls[0]?.forceRefresh).toBe(true);
		pendingReports[0]?.resolve(makeReport(1));
		await request;
	});

	it("keeps cached content visible while a period refresh is pending", async () => {
		const initial = makeReport(7);
		useUsageStore.setState({ report: initial });

		const request = useUsageStore.getState().setPeriod("30d", null);
		await Promise.resolve();

		expect(useUsageStore.getState().report).toBe(initial);
		expect(useUsageStore.getState().loading).toBe(false);
		expect(useUsageStore.getState().refreshing).toBe(true);
		expect(reportCalls[0]?.since).toBeInstanceOf(Date);

		pendingReports[0]?.resolve(makeReport(30));
		await request;
		expect(useUsageStore.getState().report?.summary.recordCount).toBe(30);
		expect(useUsageStore.getState().refreshing).toBe(false);
	});

	it("reuses a cached period immediately before revalidating", async () => {
		const cached = makeReport(90);
		useUsageStore.setState({
			report: makeReport(7),
			cache: { "global:90d": cached },
		});

		const request = useUsageStore.getState().setPeriod("90d", null);
		await Promise.resolve();

		expect(useUsageStore.getState().report).toBe(cached);
		expect(useUsageStore.getState().refreshing).toBe(true);
		pendingReports[0]?.resolve(makeReport(91));
		await request;
	});

	it("requests the selected timeline range", async () => {
		const since = new Date("2026-06-10T00:00:00.000Z");
		const until = new Date("2026-06-11T00:00:00.000Z");
		const request = useUsageStore
			.getState()
			.setRange({ since, until, label: "Jun 10" }, null);
		await Promise.resolve();

		expect(reportCalls[0]).toMatchObject({ since, until });
		pendingReports[0]?.resolve(makeReport(1));
		await request;
	});
});
