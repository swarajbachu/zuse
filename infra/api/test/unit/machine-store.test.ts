import { ManagedRuntime } from "effect";
import { describe, expect, test } from "vitest";
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";

const makeRuntime = () => ManagedRuntime.make(MachineStoreMemory);

describe("machine billing store", () => {
	test("allows one active machine for each offer kind", async () => {
		const runtime = makeRuntime();
		const store = await runtime.runPromise(MachineStore);
		for (const [entitlementId, offerId] of [
			["ent-persistent", "persistent-standard-v1"],
			["ent-sandbox", "sandbox-standard-v1"],
		] as const) {
			await runtime.runPromise(
				store.upsertEntitlement({
					entitlementId,
					accountId: "account-1",
					kind: "persistent-machine",
					offerId,
					provider: "manual",
					status: "active",
					createdAtMs: 100,
					updatedAtMs: 100,
				}),
			);
		}

		const persistent = await runtime.runPromise(
			store.createMachine({
				accountId: "account-1",
				offerId: "persistent-standard-v1",
				sameKindOfferIds: ["persistent-standard-v1"],
				idempotencyKey: "persistent",
				machineId: "machine-persistent",
				provider: "fake",
				providerLabel: "zuse-machine-persistent",
				nowMs: 100,
			}),
		);
		const sandbox = await runtime.runPromise(
			store.createMachine({
				accountId: "account-1",
				offerId: "sandbox-standard-v1",
				sameKindOfferIds: ["sandbox-standard-v1"],
				idempotencyKey: "sandbox",
				machineId: "machine-sandbox",
				provider: "fake",
				providerLabel: "zuse-machine-sandbox",
				nowMs: 100,
			}),
		);

		expect(persistent.kind).toBe("created");
		expect(sandbox.kind).toBe("created");
		await runtime.dispose();
	});

	test("does not postpone an in-progress reconciliation when payment extends", async () => {
		const runtime = makeRuntime();
		const store = await runtime.runPromise(MachineStore);
		const first = await runtime.runPromise(
			store.applyBillingEvent({
				sameKindOfferIds: ["persistent-standard-v1"],
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
				sameKindOfferIds: ["persistent-standard-v1"],
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
		await runtime.dispose();
	});

	test("reattaches a renewed entitlement to a suspended recoverable machine", async () => {
		const runtime = makeRuntime();
		const store = await runtime.runPromise(MachineStore);
		const original = await runtime.runPromise(
			store.applyBillingEvent({
				sameKindOfferIds: ["sandbox-standard-v1"],
				event: { provider: "billing-test", eventId: "event-1", nowMs: 100 },
				entitlement: {
					entitlementId: "ent-old",
					accountId: "account-1",
					kind: "persistent-machine",
					offerId: "sandbox-standard-v1",
					provider: "billing-test",
					status: "active",
					paidThroughMs: 1_000,
					createdAtMs: 100,
					updatedAtMs: 100,
				},
				provisioning: {
					machineId: "machine-1",
					idempotencyKey: "billing:ent-old",
					provider: "fake",
					providerLabel: "zuse-sandbox-1",
				},
				recoveryWindowMs: 1_000,
			}),
		);
		if (original.machine === undefined)
			throw new Error("machine was not created");
		await runtime.runPromise(
			store.saveMachine({
				...original.machine,
				state: "suspended",
				desiredState: "suspended",
				statusCode: "recovery-available",
				recoveryDeadlineMs: 2_000,
			}),
		);

		const renewed = await runtime.runPromise(
			store.applyBillingEvent({
				sameKindOfferIds: ["sandbox-standard-v1"],
				event: { provider: "billing-test", eventId: "event-2", nowMs: 1_500 },
				entitlement: {
					entitlementId: "ent-new",
					accountId: "account-1",
					kind: "persistent-machine",
					offerId: "sandbox-standard-v1",
					provider: "billing-test",
					status: "active",
					paidThroughMs: 3_000,
					createdAtMs: 1_500,
					updatedAtMs: 1_500,
				},
				provisioning: {
					machineId: "machine-2",
					idempotencyKey: "billing:ent-new",
					provider: "fake",
					providerLabel: "zuse-sandbox-2",
				},
				recoveryWindowMs: 1_000,
			}),
		);

		expect(renewed.machineCreated).toBe(false);
		expect(renewed.machine).toMatchObject({
			machineId: "machine-1",
			entitlementId: "ent-new",
			state: "resuming",
			desiredState: "ready",
			statusCode: "resume-queued",
			paidThroughMs: 3_000,
		});
		expect(renewed.machine?.recoveryDeadlineMs).toBeUndefined();
		await runtime.dispose();
	});
});
