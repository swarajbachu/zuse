import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const historyRpc = vi.fn();
const environmentIds: string[] = [];

const { setUsageCommandForTest, useUsageLimitsStore } = await import(
	"../../src/store/usage-limits.ts"
);

setUsageCommandForTest(async (environmentId, kind, payload) => {
	environmentIds.push(environmentId);
	const effect = kind === "usage.limits" ? rpc(payload) : historyRpc(payload);
	return Effect.runPromise(effect);
});

describe("usage limits store", () => {
	beforeEach(() => {
		rpc.mockReset();
		historyRpc.mockReset();
		environmentIds.length = 0;
		useUsageLimitsStore.setState({
			providers: [],
			history: [],
			loading: false,
			error: null,
			lastLoadedAt: null,
		});
	});

	it("deduplicates concurrent menu prefetches and reuses loaded limits", async () => {
		rpc.mockReturnValue(Effect.succeed({ providers: [] }));

		const store = useUsageLimitsStore.getState();
		await Promise.all([store.load(), store.load()]);
		await useUsageLimitsStore.getState().load();

		expect(rpc).toHaveBeenCalledTimes(1);
		expect(rpc).toHaveBeenCalledWith({
			forceRefresh: false,
			providerId: undefined,
		});
		expect(environmentIds).toEqual(["local"]);
	});

	it("loads persisted limit history for dashboard sparklines", async () => {
		const point = {
			providerId: "claude" as const,
			windowId: "five_hour",
			capturedAt: new Date("2026-07-13T12:00:00.000Z"),
			usedPercent: 45,
		};
		historyRpc.mockReturnValue(Effect.succeed({ points: [point] }));

		await useUsageLimitsStore.getState().loadHistory();

		expect(useUsageLimitsStore.getState().history).toEqual([point]);
	});
});
