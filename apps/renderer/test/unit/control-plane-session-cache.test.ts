import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getControlPlaneRpcClient: vi.fn(async () => ({})),
}));

const {
	clearControlPlaneSessionCache,
	runCachedControlPlane,
	subscribeControlPlaneSessionCache,
} = await import("../../src/lib/control-plane-client.ts");

describe("control-plane session cache", () => {
	afterEach(() => vi.useRealTimers());
	beforeEach(() => {
		clearControlPlaneSessionCache();
		vi.useRealTimers();
	});

	it("reuses immutable values until explicitly refreshed", async () => {
		let calls = 0;
		const load = (refresh = false) =>
			runCachedControlPlane("stable", () => Effect.succeed(++calls), {
				refresh,
			});

		expect(await load()).toBe(1);
		expect(await load()).toBe(1);
		expect(await load(true)).toBe(2);
	});

	it("reuses successful reads for the entire app session", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const load = () =>
			runCachedControlPlane("mutable", () => Effect.succeed(++calls));

		expect(await load()).toBe(1);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(await load()).toBe(1);
		await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1_000);
		expect(await load()).toBe(1);
		expect(calls).toBe(1);
	});

	it("evicts failed requests so callers can retry", async () => {
		let calls = 0;
		const load = () =>
			runCachedControlPlane("retry", () => {
				calls += 1;
				return calls === 1
					? Effect.fail(new Error("offline"))
					: Effect.succeed(calls);
			});

		await expect(load()).rejects.toThrow("offline");
		expect(await load()).toBe(2);
	});
	it("returns cached data during explicit refreshes and publishes the update", async () => {
		vi.useFakeTimers();
		let complete!: (value: number) => void;
		const pending = new Promise<number>((resolve) => {
			complete = resolve;
		});
		let calls = 0;
		const load = (refresh = false) =>
			runCachedControlPlane(
				"cloud",
				() => {
					calls += 1;
					return calls === 1
						? Effect.succeed(1)
						: Effect.promise(() => pending);
				},
				{ refresh },
			);
		expect(await load()).toBe(1);
		await vi.advanceTimersByTimeAsync(5_000);
		const changed = vi.fn();
		const unsubscribe = subscribeControlPlaneSessionCache(changed);
		expect(await load()).toBe(1);
		const refreshing = load(true);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(await load()).toBe(1);
		expect(calls).toBe(2);
		complete(2);
		expect(await refreshing).toBe(2);
		expect(changed).toHaveBeenCalledExactlyOnceWith("cloud");
		expect(await load()).toBe(2);
		expect(calls).toBe(2);
		unsubscribe();
	});

	it("keeps successful data after failed refreshes and still reports explicit refresh errors", async () => {
		vi.useFakeTimers();
		let offline = false;
		const load = (refresh = false) =>
			runCachedControlPlane(
				"cloud",
				() => (offline ? Effect.fail(new Error("offline")) : Effect.succeed(1)),
				{ refresh },
			);
		expect(await load()).toBe(1);
		offline = true;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(await load()).toBe(1);
		await expect(load(true)).rejects.toThrow("offline");
		expect(await load()).toBe(1);
	});

	it("does not restore cleared account data when an old request finishes", async () => {
		let complete!: (value: number) => void;
		const pending = new Promise<number>((resolve) => {
			complete = resolve;
		});
		const previous = runCachedControlPlane("cloud-workspace:account", () =>
			Effect.promise(() => pending),
		);
		clearControlPlaneSessionCache("cloud-workspace:");
		expect(
			await runCachedControlPlane("cloud-workspace:account", () =>
				Effect.succeed(2),
			),
		).toBe(2);
		complete(1);
		await previous;
		expect(
			await runCachedControlPlane("cloud-workspace:account", () =>
				Effect.succeed(3),
			),
		).toBe(2);
	});

	it("deduplicates slow cold reads and retains their results", async () => {
		vi.useFakeTimers();
		let complete!: (value: number) => void;
		const pending = new Promise<number>((resolve) => {
			complete = resolve;
		});
		const read = vi.fn(() => Effect.promise(() => pending));
		const load = () => runCachedControlPlane("slow", read);
		const first = load();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(load()).toBe(first);
		complete(1);
		await first;
		await vi.advanceTimersByTimeAsync(4_999);
		expect(await load()).toBe(1);
		expect(read).toHaveBeenCalledTimes(1);
	});
	it("refreshes after a mutation without reusing an older in-flight read", async () => {
		let complete!: (value: number) => void;
		const pending = new Promise<number>((resolve) => {
			complete = resolve;
		});
		const oldRead = runCachedControlPlane("cloud", () =>
			Effect.promise(() => pending),
		);
		expect(
			await runCachedControlPlane("cloud", () => Effect.succeed(2), {
				refresh: true,
			}),
		).toBe(2);
		complete(1);
		await oldRead;
		expect(await runCachedControlPlane("cloud", () => Effect.succeed(3))).toBe(
			2,
		);
	});
});
