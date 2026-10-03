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

	it("forces a refresh even while cached readings are fresh", async () => {
		rpc.mockReturnValue(Effect.succeed({ providers: [] }));
		await useUsageLimitsStore.getState().load();
		await useUsageLimitsStore.getState().refresh(true);
		expect(rpc).toHaveBeenCalledTimes(2);
		expect(rpc).toHaveBeenLastCalledWith({
			forceRefresh: true,
			providerId: undefined,
		});
	});

	it("retains readings and their timestamp on failure and recovers on retry", async () => {
		const provider = {
			providerId: "codex" as const,
			planLabel: "Plus",
			windows: [],
			creditsRemaining: 25,
			fetchedAt: new Date().toISOString(),
			source: "api" as const,
		};
		rpc.mockReturnValue(Effect.succeed({ providers: [provider] }));
		await useUsageLimitsStore.getState().load();
		const lastLoadedAt = useUsageLimitsStore.getState().lastLoadedAt;
		rpc.mockImplementation(() => {
			throw new Error("Offline");
		});
		await useUsageLimitsStore.getState().refresh(true);
		expect(useUsageLimitsStore.getState()).toMatchObject({
			providers: [provider],
			lastLoadedAt,
			error: "Offline",
			loading: false,
		});
		rpc.mockReturnValue(Effect.succeed({ providers: [provider] }));
		await useUsageLimitsStore.getState().refresh(true);
		expect(useUsageLimitsStore.getState().error).toBeNull();
	});

	it("does not cache initial request failures as successful readings", async () => {
		rpc.mockImplementation(() => {
			throw new Error("Offline");
		});
		await useUsageLimitsStore.getState().load();
		await useUsageLimitsStore.getState().load();
		expect(rpc).toHaveBeenCalledTimes(2);
		expect(useUsageLimitsStore.getState()).toMatchObject({
			providers: [],
			lastLoadedAt: null,
			error: "Offline",
			loading: false,
		});
	});

	it("reloads readings after the cache expires", async () => {
		rpc.mockReturnValue(Effect.succeed({ providers: [] }));
		await useUsageLimitsStore.getState().load();
		useUsageLimitsStore.setState({ lastLoadedAt: Date.now() - 60_001 });
		await useUsageLimitsStore.getState().load();
		expect(rpc).toHaveBeenCalledTimes(2);
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

describe("usage refresh ordering", () => {
	const value = (providerId: "claude" | "codex", usedPercent: number) => ({
		providerId,
		planLabel: null,
		creditsRemaining: null,
		fetchedAt: new Date().toISOString(),
		source: "api" as const,
		windows: [
			{
				id: "session",
				label: "Session",
				scope: "session" as const,
				usedPercent,
				resetsAt: null,
				windowMinutes: 300,
			},
		],
	});
	beforeEach(() => {
		rpc.mockReset();
		useUsageLimitsStore.setState({
			providers: [],
			history: [],
			loading: false,
			error: null,
			lastLoadedAt: null,
		});
	});
	it("retries Claude failures after five seconds without requiring a Kiro failure", async () => {
		rpc.mockReturnValue(
			Effect.succeed({
				providers: [{ ...value("claude", 1), unavailableReason: "expired" }],
			}),
		);
		await useUsageLimitsStore.getState().load();
		await useUsageLimitsStore.getState().load();
		expect(rpc).toHaveBeenCalledTimes(1);
		useUsageLimitsStore.setState({ lastLoadedAt: Date.now() - 5001 });
		await useUsageLimitsStore.getState().load();
		expect(rpc).toHaveBeenCalledTimes(2);
	});
	it("deduplicates concurrent manual refreshes", async () => {
		rpc.mockReturnValue(Effect.succeed({ providers: [value("claude", 1)] }));
		await Promise.all([
			useUsageLimitsStore.getState().refresh(true),
			useUsageLimitsStore.getState().refresh(true),
		]);
		expect(rpc).toHaveBeenCalledTimes(1);
	});
	it("does not let an older full response overwrite a newer provider read", async () => {
		let resolve!: (response: { providers: ReturnType<typeof value>[] }) => void;
		rpc.mockReturnValueOnce(
			Effect.promise(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			),
		);
		const all = useUsageLimitsStore.getState().refresh(true);
		rpc.mockReturnValueOnce(
			Effect.succeed({ providers: [value("claude", 50)] }),
		);
		await useUsageLimitsStore.getState().refresh(true, "claude");
		expect(useUsageLimitsStore.getState().loading).toBe(true);
		resolve({ providers: [value("claude", 10), value("codex", 20)] });
		await all;
		expect(
			useUsageLimitsStore
				.getState()
				.providers.find((p) => p.providerId === "claude")?.windows[0]
				?.usedPercent,
		).toBe(50);
		expect(
			useUsageLimitsStore
				.getState()
				.providers.find((p) => p.providerId === "codex")?.windows[0]
				?.usedPercent,
		).toBe(20);
		expect(useUsageLimitsStore.getState().loading).toBe(false);
	});
	it("clears an account and ignores its pending response", async () => {
		let resolve!: (response: { providers: ReturnType<typeof value>[] }) => void;
		rpc.mockReturnValueOnce(
			Effect.promise(
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			),
		);
		const pending = useUsageLimitsStore.getState().refresh(true, "claude");
		useUsageLimitsStore.getState().invalidate("claude");
		resolve({ providers: [value("claude", 10)] });
		await pending;
		expect(useUsageLimitsStore.getState().providers).toEqual([]);
	});
});
