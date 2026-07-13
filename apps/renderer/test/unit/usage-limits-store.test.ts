import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();
const historyRpc = vi.fn();

const { setUsageLimitsRpcClientForTest, useUsageLimitsStore } = await import(
	"../../src/store/usage-limits.ts"
);

setUsageLimitsRpcClientForTest(
	async () =>
		({
			"usage.limits": rpc,
			"usage.limits.history": historyRpc,
		}) as unknown as Awaited<
			ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
		>,
);

describe("usage limits store", () => {
	beforeEach(() => {
		rpc.mockReset();
		historyRpc.mockReset();
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
