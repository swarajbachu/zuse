import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rpc = vi.fn();

const { setUsageLimitsRpcClientForTest, useUsageLimitsStore } = await import(
	"../../src/store/usage-limits.ts"
);

setUsageLimitsRpcClientForTest(
	async () =>
		({ "usage.limits": rpc }) as unknown as Awaited<
			ReturnType<typeof import("../../src/lib/rpc-client.ts").getRpcClient>
		>,
);

describe("usage limits store", () => {
	beforeEach(() => {
		rpc.mockReset();
		useUsageLimitsStore.setState({
			providers: [],
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
});
