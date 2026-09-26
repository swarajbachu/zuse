import { Effect, ManagedRuntime } from "effect";
import { expect, test } from "vitest";
import { ApiStore, ApiStoreMemory } from "../../src/store.ts";

test("late registration cannot restore a revoked device or reuse its key", async () => {
	const runtime = ManagedRuntime.make(ApiStoreMemory);
	try {
		const store = await runtime.runPromise(ApiStore);
		const device = {
			deviceId: "phone",
			accountId: "account",
			platform: "ios" as const,
			dpopThumbprint: "old-key",
			pushToken: "token",
			updatedAtMs: 1,
		};
		expect(await runtime.runPromise(store.upsertDevice(device))).toBe(true);
		expect(
			await runtime.runPromise(
				store.revokeDevice(device.deviceId, device.accountId),
			),
		).toBe(true);
		expect(await runtime.runPromise(store.upsertDevice(device))).toBe(false);
		expect(
			await runtime.runPromise(
				store.upsertDevice({ ...device, deviceId: "late-phone" }),
			),
		).toBe(false);
		expect(
			await runtime.runPromise(store.listDevices(device.accountId)),
		).toEqual([]);
		expect(
			await runtime.runPromise(
				store.upsertDevice({ ...device, dpopThumbprint: "new-key" }),
			),
		).toBe(true);
		await runtime.runPromise(
			Effect.all(
				[
					store.revokeDevice(device.deviceId, device.accountId),
					store.upsertDevice({ ...device, dpopThumbprint: "new-key" }),
				],
				{ concurrency: "unbounded" },
			),
		);
		expect(
			await runtime.runPromise(store.listDevices(device.accountId)),
		).toEqual([]);
	} finally {
		await runtime.dispose();
	}
});
