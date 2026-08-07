import { ManagedRuntime } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";

const runtime = ManagedRuntime.make(MachineStoreMemory);

afterEach(async () => {
	await runtime.dispose();
});

describe("machine billing store", () => {
	test("does not postpone an in-progress reconciliation when payment extends", async () => {
		const store = await runtime.runPromise(MachineStore);
		const first = await runtime.runPromise(
			store.applyBillingEvent({
				event: {
					provider: "billing-test",
					eventId: "event-1",
					nowMs: 100,
				},
				entitlement: {
					entitlementId: "ent-1",
					accountId: "account-1",
					kind: "persistent-machine",
					offerId: "persistent-standard-v1",
					provider: "billing-test",
					providerSubscriptionId: "subscription-1",
					status: "active",
					paidThroughMs: 10_000,
					createdAtMs: 100,
					updatedAtMs: 100,
				},
				provisioning: {
					machineId: "machine-1",
					idempotencyKey: "billing:ent-1",
					provider: "fake",
					providerLabel: "zuse-machine-1",
				},
				recoveryWindowMs: 1_000,
			}),
		);
		const machine = first.machine;
		if (machine === undefined) throw new Error("machine was not created");
		await runtime.runPromise(
			store.saveMachine({
				...machine,
				state: "bootstrapping",
				nextActionAtMs: 160,
			}),
		);

		await runtime.runPromise(
			store.applyBillingEvent({
				event: {
					provider: "billing-test",
					eventId: "event-2",
					nowMs: 110,
				},
				entitlement: {
					entitlementId: "ent-1",
					accountId: "account-1",
					kind: "persistent-machine",
					offerId: "persistent-standard-v1",
					provider: "billing-test",
					providerSubscriptionId: "subscription-1",
					status: "active",
					paidThroughMs: 20_000,
					createdAtMs: 100,
					updatedAtMs: 110,
				},
				recoveryWindowMs: 1_000,
			}),
		);

		const updated = await runtime.runPromise(store.getMachine("machine-1"));
		expect(updated?.nextActionAtMs).toBe(160);
		expect(updated?.paidThroughMs).toBe(20_000);
	});
});
