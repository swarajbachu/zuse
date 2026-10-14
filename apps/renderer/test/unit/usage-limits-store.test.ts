import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	setUsageCommandForTest,
	useUsageLimitsStore,
} from "../../src/store/usage-limits.ts";

const rpc = vi.fn();
const historyRpc = vi.fn();
const environmentIds: string[] = [];
const ids = ["claude", "codex", "grok", "gemini", "kiro"];
const value = (providerId: "claude" | "codex", usedPercent = 10) => ({
	providerId,
	planLabel: "Pro",
	creditsRemaining: 25,
	fetchedAt: "2026-10-12T12:00:00.000Z",
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
const deferred = () => {
	let resolve!: (response: { providers: ReturnType<typeof value>[] }) => void;
	const promise = new Promise<{ providers: ReturnType<typeof value>[] }>(
		(done) => {
			resolve = done;
		},
	);
	return { promise, resolve };
};

describe("usage limits store", () => {
	beforeEach(() => {
		rpc.mockReset().mockResolvedValue({ providers: [] });
		historyRpc.mockReset();
		environmentIds.length = 0;
		setUsageCommandForTest(async (environmentId, kind, payload) => {
			environmentIds.push(environmentId);
			return kind === "usage.limits" ? rpc(payload) : historyRpc(payload);
		});
		useUsageLimitsStore.setState({
			providers: [],
			history: [],
			loading: false,
			loadingProviders: [],
			error: null,
			lastLoadedAt: null,
		});
	});

	it("deduplicates menu prefetches and reuses loaded limits", async () => {
		await Promise.all([
			useUsageLimitsStore.getState().load(),
			useUsageLimitsStore.getState().load(),
		]);
		await useUsageLimitsStore.getState().load();
		expect(rpc).toHaveBeenCalledTimes(5);
		expect(rpc.mock.calls.map(([payload]) => payload)).toEqual(
			ids.map((providerId) => ({ forceRefresh: false, providerId })),
		);
		expect(environmentIds).toEqual(ids.map(() => "local"));
	});
	it("forces a refresh even while cached readings are fresh", async () => {
		await useUsageLimitsStore.getState().load();
		await useUsageLimitsStore.getState().refresh(true);
		expect(rpc).toHaveBeenCalledTimes(10);
		expect(rpc).toHaveBeenLastCalledWith({
			forceRefresh: true,
			providerId: "kiro",
		});
	});
	it("retains readings and timestamp on failure and recovers", async () => {
		rpc.mockResolvedValue({ providers: [value("codex")] });
		await useUsageLimitsStore.getState().load();
		const lastLoadedAt = useUsageLimitsStore.getState().lastLoadedAt;
		rpc.mockRejectedValue(new Error("Offline"));
		await useUsageLimitsStore.getState().refresh(true);
		expect(useUsageLimitsStore.getState()).toMatchObject({
			providers: [value("codex")],
			lastLoadedAt,
			error: "Offline",
			loading: false,
			loadingProviders: [],
		});
		rpc.mockResolvedValue({ providers: [value("codex")] });
		await useUsageLimitsStore.getState().refresh(true);
		expect(useUsageLimitsStore.getState().error).toBeNull();
	});
	it("does not cache failed initial loads as successful readings", async () => {
		rpc.mockRejectedValue(new Error("Offline"));
		await useUsageLimitsStore.getState().load();
		await useUsageLimitsStore.getState().load();
		expect(rpc).toHaveBeenCalledTimes(10);
		expect(useUsageLimitsStore.getState()).toMatchObject({
			providers: [],
			lastLoadedAt: null,
			error: "Offline",
			loading: false,
		});
	});
	it("reloads after the cache expires", async () => {
		await useUsageLimitsStore.getState().load();
		useUsageLimitsStore.setState({ lastLoadedAt: Date.now() - 60_001 });
		await useUsageLimitsStore.getState().load();
		expect(rpc).toHaveBeenCalledTimes(10);
	});
	it("loads persisted limit history", async () => {
		const point = {
			providerId: "claude" as const,
			windowId: "session",
			capturedAt: new Date(),
			usedPercent: 45,
		};
		historyRpc.mockResolvedValue({ points: [point] });
		await useUsageLimitsStore.getState().loadHistory();
		expect(useUsageLimitsStore.getState().history).toEqual([point]);
	});
	it("retries unavailable readings after five seconds", async () => {
		rpc.mockResolvedValue({
			providers: [{ ...value("claude"), unavailableReason: "expired" }],
		});
		await useUsageLimitsStore.getState().load();
		await useUsageLimitsStore.getState().load();
		expect(rpc).toHaveBeenCalledTimes(5);
		useUsageLimitsStore.setState({ lastLoadedAt: Date.now() - 5001 });
		await useUsageLimitsStore.getState().load();
		expect(rpc).toHaveBeenCalledTimes(10);
	});
	it("deduplicates concurrent manual refreshes", async () => {
		await Promise.all([
			useUsageLimitsStore.getState().refresh(true),
			useUsageLimitsStore.getState().refresh(true),
		]);
		expect(rpc).toHaveBeenCalledTimes(5);
	});
	it("keeps a healthy provider and its loading state when another fails", async () => {
		const slow = deferred();
		rpc.mockImplementation(({ providerId }) =>
			providerId === "claude"
				? Promise.resolve({ providers: [value("claude")] })
				: slow.promise,
		);
		const pending = useUsageLimitsStore.getState().load();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(useUsageLimitsStore.getState().providers).toHaveLength(1);
		expect(useUsageLimitsStore.getState().loadingProviders).not.toContain(
			"claude",
		);
		expect(useUsageLimitsStore.getState().loadingProviders).toContain("codex");
		slow.resolve({ providers: [] });
		await pending;
		rpc.mockImplementation(({ providerId }) =>
			providerId === "claude"
				? Promise.resolve({ providers: [value("claude", 50)] })
				: Promise.reject(new Error("Offline")),
		);
		await useUsageLimitsStore.getState().refresh(true);
		expect(
			useUsageLimitsStore.getState().providers[0]?.windows[0]?.usedPercent,
		).toBe(50);
		expect(useUsageLimitsStore.getState().error).toBe("Offline");
	});
	it("does not let older full reads overwrite newer provider reads", async () => {
		const old = deferred();
		rpc.mockImplementation(() => old.promise);
		const all = useUsageLimitsStore.getState().refresh(true);
		rpc.mockResolvedValue({ providers: [value("claude", 50)] });
		await useUsageLimitsStore.getState().refresh(true, "claude");
		expect(useUsageLimitsStore.getState().loadingProviders).toContain("claude");
		old.resolve({ providers: [value("claude", 10), value("codex", 20)] });
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
	it("sends forced requests while normal refreshes are pending", async () => {
		const old = deferred();
		rpc.mockImplementation(() => old.promise);
		const normal = useUsageLimitsStore.getState().refresh(false);
		rpc.mockResolvedValue({ providers: [value("claude", 50)] });
		await useUsageLimitsStore.getState().refresh(true);
		expect(rpc).toHaveBeenCalledTimes(10);
		old.resolve({ providers: [value("claude", 10)] });
		await normal;
		expect(
			useUsageLimitsStore.getState().providers[0]?.windows[0]?.usedPercent,
		).toBe(50);
	});
	it("reloads an invalidated provider after a partial full response", async () => {
		const old = deferred();
		rpc.mockImplementation(() => old.promise);
		const pending = useUsageLimitsStore.getState().load();
		useUsageLimitsStore.getState().invalidate("claude");
		old.resolve({ providers: [value("claude", 10), value("codex", 20)] });
		await pending;
		expect(useUsageLimitsStore.getState().lastLoadedAt).toBeNull();
		expect(
			useUsageLimitsStore
				.getState()
				.providers.some((p) => p.providerId === "claude"),
		).toBe(false);
		rpc.mockResolvedValue({ providers: [value("claude", 50)] });
		await useUsageLimitsStore.getState().load();
		expect(rpc).toHaveBeenCalledTimes(10);
	});
	it("ignores pending account and history responses after invalidation", async () => {
		const old = deferred();
		let finishHistory!: (response: { points: [] }) => void;
		historyRpc.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishHistory = resolve;
				}),
		);
		rpc.mockImplementation(() => old.promise);
		const pending = useUsageLimitsStore.getState().refresh(true, "claude");
		const history = useUsageLimitsStore.getState().loadHistory();
		useUsageLimitsStore.getState().invalidate("claude");
		old.resolve({ providers: [value("claude")] });
		finishHistory({ points: [] });
		await Promise.all([pending, history]);
		expect(useUsageLimitsStore.getState().providers).toEqual([]);
		expect(useUsageLimitsStore.getState().loadingProviders).toEqual([]);
	});
});
