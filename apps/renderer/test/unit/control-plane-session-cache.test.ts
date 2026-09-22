import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/rpc-client.ts", () => ({
	getControlPlaneRpcClient: vi.fn(async () => ({})),
}));

const { clearControlPlaneSessionCache, runCachedControlPlane } = await import(
	"../../src/lib/control-plane-client.ts"
);

describe("control-plane session cache", () => {
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

	it("reloads mutable values after their TTL", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const load = () =>
			runCachedControlPlane("mutable", () => Effect.succeed(++calls), {
				maxAgeMs: 5_000,
			});

		expect(await load()).toBe(1);
		await vi.advanceTimersByTimeAsync(4_999);
		expect(await load()).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await load()).toBe(2);
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
});
