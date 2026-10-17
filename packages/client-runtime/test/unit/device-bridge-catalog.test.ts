import type { DeviceBridgeResult } from "@zuse/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceBridgeCatalogController } from "../../src/device-bridge-catalog";

afterEach(() => vi.useRealTimers());
it("does not overwrite an explicit selection with a stale discovery response", async () => {
	vi.useFakeTimers();
	let finish!: (result: DeviceBridgeResult) => void;
	const listener = vi.fn();
	const controller = new DeviceBridgeCatalogController({
		list: async () => [],
		status: () =>
			new Promise((resolve) => {
				finish = resolve;
			}),
		select: async () => {},
	});
	const stop = controller.start(listener);
	await controller.select("chosen");
	finish({ deviceId: "previous" } as DeviceBridgeResult);
	await vi.advanceTimersByTimeAsync(0);
	expect(listener.mock.lastCall?.[0].selected).toBe("chosen");
	stop();
	expect(vi.getTimerCount()).toBe(0);
});
it("ignores results after disposal", async () => {
	const listener = vi.fn();
	let finish!: (result: DeviceBridgeResult) => void;
	const controller = new DeviceBridgeCatalogController({
		list: async () => [],
		status: () =>
			new Promise((resolve) => {
				finish = resolve;
			}),
		select: async () => {},
	});
	const stop = controller.start(listener);
	stop();
	finish({ deviceId: "old-account" } as DeviceBridgeResult);
	await Promise.resolve();
	await Promise.resolve();
	expect(listener).toHaveBeenCalledTimes(1);
});
