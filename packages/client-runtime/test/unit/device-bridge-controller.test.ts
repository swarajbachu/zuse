import type { DeviceBridgeResult, DeviceBridgeStatus } from "@zuse/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceBridgeController } from "../../src/device-bridge-controller.ts";

const status: DeviceBridgeStatus = {
	version: 1,
	deviceId: "desktop",
	deviceName: "My Mac",
	homeDirectory: "/Users/test",
	connected: true,
	enabled: true,
	commands: [],
	grants: [],
};
afterEach(() => vi.useRealTimers());
describe("device bridge client lifecycle", () => {
	it("does not publish an old chat's in-flight response after its view closes", async () => {
		let complete: (value: DeviceBridgeResult) => void = () => {};
		const send = () =>
			new Promise<DeviceBridgeResult>((resolve) => {
				complete = resolve;
			});
		const controller = new DeviceBridgeController(send);
		const changed = vi.fn();
		const close = controller.start(changed);
		close();
		complete(status);
		await Promise.resolve();
		expect(changed).toHaveBeenCalledTimes(1);
	});
	it("recovers from an offline computer and clears the stale error", async () => {
		vi.useFakeTimers();
		const send = vi
			.fn()
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue(status);
		const changed = vi.fn();
		const controller = new DeviceBridgeController(send);
		const close = controller.start(changed);
		await vi.advanceTimersByTimeAsync(0);
		expect(changed.mock.lastCall?.[0].error).toContain("unavailable");
		await vi.advanceTimersByTimeAsync(15000);
		expect(changed.mock.lastCall?.[0]).toMatchObject({ status, error: null });
		close();
	});
	it("prevents duplicate approval submissions while the first is unresolved", async () => {
		let complete: () => void = () => {};
		const controller = new DeviceBridgeController(async () => status);
		const close = controller.start(() => {});
		const task = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
		);
		const first = controller.run(task);
		await controller.run(task);
		expect(task).toHaveBeenCalledTimes(1);
		complete();
		await first;
		close();
	});
});
