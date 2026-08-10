import {
	type BillingProviderAdapter,
	BillingProviderError,
	BillingProviders,
	BillingProvidersManual,
} from "@zuse/billing-providers";
import { MachineProviders } from "@zuse/machine-providers";
import {
	FakeMachineProviderControlService,
	MachineProvidersFake,
} from "@zuse/machine-providers/testing";
import { SandboxProviders } from "@zuse/sandbox-providers";
import {
	FakeSandboxProviderControlService,
	SandboxProvidersFake,
} from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted, Ref } from "effect";
import { describe, expect, test } from "vitest";
import * as Config from "../../src/config.ts";
import {
	AccountIdentity,
	MachineControlConfiguration,
	reconcileMachines,
} from "../../src/index.ts";
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";
import {
	ManagedTunnelProvider,
	type ManagedTunnelProviderApi,
} from "../../src/managed-tunnel.ts";
import { SandboxOfferConfiguration } from "../../src/sandbox-provider-module.ts";
import { RelayStoreMemory } from "../../src/store.ts";

const noTunnel: ManagedTunnelProviderApi = {
	enabled: false,
	provision: () => Effect.die("disabled"),
	deprovision: () => Effect.void,
};

const makeTestLayer = (billing?: BillingProviderAdapter) =>
	Layer.mergeAll(
		Config.layer({
			relayIssuer: "https://relay.test",
			workosJwksUrl: "https://unused.test/jwks",
			workosIssuer: "https://unused.test",
			mintPrivateKey: Redacted.make("{}"),
			mintPublicKey: '{"kty":"OKP"}',
		}),
		MachineStoreMemory,
		MachineProvidersFake,
		SandboxProvidersFake,
		Layer.succeed(SandboxOfferConfiguration, {
			port: 47_837,
			createTimeoutSeconds: 3_600,
			keepAliveTimeoutSeconds: 3_600,
		}),
		billing === undefined
			? BillingProvidersManual
			: BillingProviders.layer({
					adapters: [billing],
					defaultProviderId: billing.providerId,
				}).pipe(Layer.orDie),
		RelayStoreMemory,
		Layer.succeed(ManagedTunnelProvider, noTunnel),
		Layer.succeed(
			AccountIdentity,
			AccountIdentity.of({ deleteUser: () => Effect.void }),
		),
		Layer.succeed(MachineControlConfiguration, {
			allowlistedAccountIds: new Set(["user_a"]),
			manualEntitlementsEnabled: true,
			liveCheckoutEnabled: false,
			enrollmentTtlMs: 30 * 60 * 1_000,
			recoveryWindowMs: 7 * 24 * 60 * 60 * 1_000,
			finalSnapshotRetentionMs: 14 * 24 * 60 * 60 * 1_000,
			reconcileLeaseMs: 5 * 60 * 1_000,
		}),
	);

const testLayer = makeTestLayer();

const seedMachine = Effect.fn("seedMachine")(function* (nowMs: number) {
	const store = yield* MachineStore;
	const providers = yield* MachineProviders;
	const provider = yield* providers.getDefault;
	yield* store.upsertEntitlement({
		entitlementId: "ent_1",
		accountId: "user_a",
		kind: "persistent-machine",
		offerId: "persistent-standard-v1",
		provider: "manual",
		status: "active",
		paidThroughMs: nowMs + 30 * 24 * 60 * 60 * 1_000,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
	});
	const outcome = yield* store.createMachine({
		accountId: "user_a",
		offerId: "persistent-standard-v1",
		sameKindOfferIds: ["persistent-standard-v1"],
		idempotencyKey: "create_1",
		machineId: "machine_1",
		provider: provider.providerId,
		providerLabel: "zuse-machine_1",
		nowMs,
	});
	if (outcome.kind !== "created") return yield* Effect.die(outcome.kind);
	return outcome.machine;
});

const seedSandbox = Effect.fn("seedSandbox")(function* (nowMs: number) {
	const store = yield* MachineStore;
	const provider = yield* (yield* SandboxProviders).getDefault;
	yield* store.upsertEntitlement({
		entitlementId: "ent_sandbox",
		accountId: "user_a",
		kind: "persistent-machine",
		offerId: "sandbox-standard-v1",
		provider: "manual",
		status: "active",
		paidThroughMs: nowMs + 30 * 24 * 60 * 60 * 1_000,
		createdAtMs: nowMs,
		updatedAtMs: nowMs,
	});
	const outcome = yield* store.createMachine({
		accountId: "user_a",
		offerId: "sandbox-standard-v1",
		sameKindOfferIds: ["sandbox-standard-v1"],
		idempotencyKey: "create_sandbox",
		machineId: "machine_sandbox",
		provider: provider.providerId,
		providerLabel: "zuse-machine_sandbox",
		nowMs,
	});
	if (outcome.kind !== "created") return yield* Effect.die(outcome.kind);
	return outcome.machine;
});

describe("machine reconciler", () => {
	test("creates, self-heals, pauses, and destroys a sandbox", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedSandbox(Date.now() - 1_000);
				const store = yield* MachineStore;
				const control = yield* FakeSandboxProviderControlService;

				yield* reconcileMachines({ owner: "create" });
				const created = yield* store.getMachine(seeded.machineId);
				if (created?.providerServerId === undefined) {
					return yield* Effect.die("sandbox was not created");
				}
				const sandboxes = yield* Ref.get(control.sandboxes);
				yield* Ref.set(
					control.sandboxes,
					new Map([
						[
							created.providerServerId,
							{
								...(sandboxes.get(created.providerServerId) as NonNullable<
									ReturnType<typeof sandboxes.get>
								>),
								state: "paused" as const,
							},
						],
					]),
				);
				yield* store.saveMachine({
					...created,
					state: "ready",
					statusCode: "ready",
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "self-heal" });
				const healed = yield* store.getMachine(seeded.machineId);
				if (healed === null) return yield* Effect.die("missing sandbox");

				yield* store.saveMachine({
					...healed,
					desiredState: "suspended",
					paidThroughMs: 0,
					recoveryDeadlineMs: Date.now() + 60_000,
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "pause" });
				const paused = yield* store.getMachine(seeded.machineId);
				if (paused === null) return yield* Effect.die("missing sandbox");

				yield* store.saveMachine({
					...paused,
					state: "destroying",
					desiredState: "destroyed",
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "destroy" });
				return {
					created,
					healed,
					paused,
					destroyed: yield* store.getMachine(seeded.machineId),
					providerSandboxes: yield* Ref.get(control.sandboxes),
					startProcessCalls: yield* Ref.get(control.startProcessCalls),
					createInputs: yield* Ref.get(control.createInputs),
					resumeInputs: yield* Ref.get(control.resumeInputs),
					network: yield* Ref.get(control.networkBySandbox),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.created.providerEndpointHttpBaseUrl).toBe(
			`https://47837-${result.created.providerServerId}.sandbox.test`,
		);
		expect(result.created.providerEndpointWsBaseUrl).toBe(
			`wss://47837-${result.created.providerServerId}.sandbox.test`,
		);
		expect(result.startProcessCalls).toEqual([result.created.providerServerId]);
		expect(result.createInputs).toEqual([
			{ timeoutSeconds: 3_600, onTimeout: "pause" },
		]);
		expect(result.resumeInputs).toEqual([
			{ timeoutSeconds: 3_600, onTimeout: "pause" },
		]);
		expect(result.created.nextActionAtMs - result.created.updatedAtMs).toBe(
			15_000,
		);
		expect(
			result.network.get(result.created.providerServerId as string),
		).toEqual({ kind: "open" });
		expect(result.healed.state).toBe("ready");
		expect(result.paused.state).toBe("suspended");
		expect(result.destroyed?.state).toBe("destroyed");
		expect(result.providerSandboxes.size).toBe(0);
	});

	test("recreates a resumed sandbox after provider retention expires", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedSandbox(Date.now() - 1_000);
				const store = yield* MachineStore;
				const control = yield* FakeSandboxProviderControlService;
				yield* reconcileMachines({ owner: "create-before-gc" });
				const created = yield* store.getMachine(seeded.machineId);
				if (created === null) return yield* Effect.die("missing sandbox");
				yield* Ref.set(control.sandboxes, new Map());
				yield* store.saveMachine({
					...created,
					state: "resuming",
					desiredState: "ready",
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "recover-after-gc" });
				return yield* store.getMachine(seeded.machineId);
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result).toMatchObject({
			state: "creating",
			statusCode: "creation-queued",
			providerServerId: undefined,
			providerEndpointHttpBaseUrl: undefined,
			providerEndpointWsBaseUrl: undefined,
		});
	});

	test("keeps a machine retryable when its persisted provider is unavailable", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedMachine(Date.now() - 1_000);
				const store = yield* MachineStore;
				yield* store.saveMachine({
					...seeded,
					provider: "temporarily-missing",
					nextActionAtMs: 0,
				});
				for (let attempt = 0; attempt < 10; attempt += 1) {
					yield* reconcileMachines({ owner: `worker-${attempt}` });
					const current = yield* store.getMachine(seeded.machineId);
					if (current === null) return yield* Effect.die("missing machine");
					yield* store.saveMachine({ ...current, nextActionAtMs: 0 });
				}
				return yield* store.getMachine(seeded.machineId);
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result?.state).toBe("creating");
		expect(result?.statusCode).toBe("provider-unavailable");
		expect(result?.stableFailureCode).toBe("machine-provider-not-configured");
		expect(result?.attemptCount).toBe(0);
		expect(result?.nextActionAtMs).toBeLessThan(Number.MAX_SAFE_INTEGER);
	});

	test("rejects stale lifecycle writes after destruction is requested", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const stale = yield* seedMachine(Date.now());
				const store = yield* MachineStore;
				const destroyed = yield* store.compareAndSetMachine(
					{
						...stale,
						state: "destroying",
						desiredState: "destroyed",
						statusCode: "destruction-queued",
					},
					stale.revision,
				);
				const staleBoot = yield* store.compareAndSetMachine(
					{
						...stale,
						state: "bootstrapping",
						statusCode: "bootstrap-pending",
					},
					stale.revision,
				);
				return {
					destroyed,
					staleBoot,
					machine: yield* store.getMachine(stale.machineId),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.destroyed).toBe(true);
		expect(result.staleBoot).toBe(false);
		expect(result.machine?.state).toBe("destroying");
		expect(result.machine?.desiredState).toBe("destroyed");
	});

	test("transactional leases let only one concurrent worker claim a machine", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				yield* seedMachine(Date.now() - 1_000);
				return yield* Effect.all(
					[
						reconcileMachines({ owner: "worker-a" }),
						reconcileMachines({ owner: "worker-b" }),
					],
					{ concurrency: "unbounded" },
				);
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result[0].claimed + result[1].claimed).toBe(1);
		expect(result[0].processed + result[1].processed).toBe(1);
	});

	test("recovers a timed-out create by deterministic label without a duplicate", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedMachine(Date.now() - 1_000);
				const control = yield* FakeMachineProviderControlService;
				yield* Ref.set(control.failNextCreateAfterProvision, true);

				yield* reconcileMachines({ owner: "worker-a" });
				const store = yield* MachineStore;
				const afterTimeout = yield* store.getMachine(seeded.machineId);
				if (afterTimeout === null) return yield* Effect.die("missing machine");
				yield* store.saveMachine({ ...afterTimeout, nextActionAtMs: 0 });

				yield* reconcileMachines({ owner: "worker-b" });
				return {
					machine: yield* store.getMachine(seeded.machineId),
					createCalls: yield* Ref.get(control.createCalls),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.createCalls).toBe(1);
		expect(result.machine?.state).toBe("bootstrapping");
		expect(result.machine?.providerServerId).toBe("fake-machine_1");
	});

	test("bounds setup by the persisted enrollment deadline", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedMachine(Date.now() - 1_000);
				yield* reconcileMachines({ owner: "provision" });
				const store = yield* MachineStore;
				const provisioned = yield* store.getMachine(seeded.machineId);
				if (provisioned === null) return yield* Effect.die("missing machine");
				yield* store.saveMachine({
					...provisioned,
					attemptCount: 24,
					enrollmentExpiresAtMs: Date.now() + 60_000,
					nextActionAtMs: 0,
				});

				yield* reconcileMachines({ owner: "bootstrap-check" });
				const continued = yield* store.getMachine(seeded.machineId);
				if (continued === null) return yield* Effect.die("missing machine");
				yield* store.saveMachine({
					...continued,
					enrollmentExpiresAtMs: 0,
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "bootstrap-timeout" });
				return {
					continued,
					timedOut: yield* store.getMachine(seeded.machineId),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.continued.state).toBe("bootstrapping");
		expect(result.continued.statusCode).toBe("bootstrap-pending");
		expect(result.continued.attemptCount).toBe(0);
		expect(result.timedOut?.state).toBe("failed");
		expect(result.timedOut?.stableFailureCode).toBe("bootstrap-timeout");
		expect(result.timedOut?.attemptCount).toBe(0);
	});

	test("durably retries subscription cancellation before waiting for paid-through", async () => {
		let cancellationAttempts = 0;
		const billing: BillingProviderAdapter = {
			providerId: "billing-test",
			checkout: () => new BillingProviderError({ code: "checkout-disabled" }),
			verifyEvent: () =>
				new BillingProviderError({ code: "checkout-disabled" }),
			reconcileSubscription: () =>
				new BillingProviderError({ code: "checkout-disabled" }),
			cancel: () => {
				cancellationAttempts += 1;
				return cancellationAttempts === 1
					? new BillingProviderError({ code: "provider-unavailable" })
					: Effect.void;
			},
			customerPortal: () =>
				new BillingProviderError({ code: "checkout-disabled" }),
		};
		const nowMs = Date.now();
		const paidThroughMs = nowMs + 60_000;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedMachine(nowMs);
				const store = yield* MachineStore;
				yield* reconcileMachines({ owner: "provision" });
				const provisioned = yield* store.getMachine(seeded.machineId);
				if (provisioned === null) return yield* Effect.die("missing machine");
				yield* store.upsertEntitlement({
					entitlementId: "ent_1",
					accountId: "user_a",
					kind: "persistent-machine",
					offerId: "persistent-standard-v1",
					provider: billing.providerId,
					providerSubscriptionId: "subscription_1",
					status: "active",
					paidThroughMs,
					createdAtMs: nowMs,
					updatedAtMs: nowMs,
				});
				yield* store.saveMachine({
					...provisioned,
					state: "ready",
					desiredState: "suspended",
					statusCode: "cancellation-scheduled",
					paidThroughMs,
					nextActionAtMs: 0,
				});

				yield* reconcileMachines({ owner: "cancel-fails" });
				const afterFailure = yield* store.getMachine(seeded.machineId);
				if (afterFailure === null) return yield* Effect.die("missing machine");
				yield* store.saveMachine({ ...afterFailure, nextActionAtMs: 0 });
				yield* reconcileMachines({ owner: "cancel-retries" });
				return {
					afterFailure,
					afterRetry: yield* store.getMachine(seeded.machineId),
				};
			}).pipe(Effect.provide(makeTestLayer(billing))),
		);

		expect(cancellationAttempts).toBe(2);
		expect(result.afterFailure.stableFailureCode).toBe(
			"billing-provider-unavailable",
		);
		expect(result.afterRetry).toMatchObject({
			state: "ready",
			desiredState: "suspended",
			statusCode: "cancellation-scheduled",
			nextActionAtMs: paidThroughMs,
		});
	});

	test("finishes provisioning after cancellation while the machine is paid through", async () => {
		let cancellationAttempts = 0;
		const billing: BillingProviderAdapter = {
			providerId: "billing-test",
			checkout: () => new BillingProviderError({ code: "checkout-disabled" }),
			verifyEvent: () =>
				new BillingProviderError({ code: "checkout-disabled" }),
			reconcileSubscription: () =>
				new BillingProviderError({ code: "checkout-disabled" }),
			cancel: () =>
				Effect.sync(() => {
					cancellationAttempts += 1;
				}),
			customerPortal: () =>
				new BillingProviderError({ code: "checkout-disabled" }),
		};
		const nowMs = Date.now();
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedMachine(nowMs);
				const store = yield* MachineStore;
				const control = yield* FakeMachineProviderControlService;
				yield* store.upsertEntitlement({
					entitlementId: "ent_1",
					accountId: "user_a",
					kind: "persistent-machine",
					offerId: "persistent-standard-v1",
					provider: billing.providerId,
					providerSubscriptionId: "subscription_1",
					status: "active",
					paidThroughMs: nowMs + 60_000,
					createdAtMs: nowMs,
					updatedAtMs: nowMs,
				});
				yield* store.saveMachine({
					...seeded,
					desiredState: "suspended",
					statusCode: "cancellation-scheduled",
					paidThroughMs: nowMs + 60_000,
					nextActionAtMs: 0,
				});

				yield* reconcileMachines({ owner: "cancel-during-create" });
				return {
					machine: yield* store.getMachine(seeded.machineId),
					createCalls: yield* Ref.get(control.createCalls),
				};
			}).pipe(Effect.provide(makeTestLayer(billing))),
		);

		expect(cancellationAttempts).toBe(1);
		expect(result.createCalls).toBe(1);
		expect(result.machine).toMatchObject({
			state: "bootstrapping",
			desiredState: "suspended",
			statusCode: "bootstrap-pending",
		});
	});

	test("suspends, resumes, snapshots, destroys, and later expires the snapshot", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedMachine(Date.now() - 2_000);
				const store = yield* MachineStore;
				const control = yield* FakeMachineProviderControlService;

				yield* reconcileMachines({ owner: "create" });
				const provisioned = yield* store.getMachine(seeded.machineId);
				if (provisioned?.providerServerId === undefined) {
					return yield* Effect.die("machine was not provisioned");
				}

				yield* store.saveMachine({
					...provisioned,
					state: "ready",
					desiredState: "suspended",
					statusCode: "cancellation-scheduled",
					paidThroughMs: 0,
					recoveryDeadlineMs: Date.now() + 60_000,
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "suspend" });
				const suspended = yield* store.getMachine(seeded.machineId);
				if (suspended === null) return yield* Effect.die("missing suspended");
				const poweredOff = (yield* Ref.get(control.servers)).get(
					provisioned.providerServerId,
				);

				yield* store.saveMachine({
					...suspended,
					state: "resuming",
					desiredState: "ready",
					statusCode: "resume-queued",
					paidThroughMs: Date.now() + 60_000,
					recoveryDeadlineMs: undefined,
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "resume" });
				const resumed = yield* store.getMachine(seeded.machineId);
				if (resumed === null) return yield* Effect.die("missing resumed");
				const poweredOn = (yield* Ref.get(control.servers)).get(
					provisioned.providerServerId,
				);

				yield* store.saveMachine({
					...resumed,
					state: "destroying",
					desiredState: "destroyed",
					statusCode: "destruction-queued",
					credentialCleanupCompletedAtMs: Date.now(),
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "destroy" });
				const destroyed = yield* store.getMachine(seeded.machineId);
				if (destroyed === null) return yield* Effect.die("missing destroyed");
				const snapshotsBeforeExpiry = yield* Ref.get(control.snapshots);
				const serversAfterDestroy = yield* Ref.get(control.servers);

				yield* store.saveMachine({
					...destroyed,
					finalSnapshotDeleteAtMs: 0,
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "expire-snapshot" });
				return {
					suspended,
					poweredOff,
					resumed,
					poweredOn,
					destroyed,
					snapshotsBeforeExpiry,
					serversAfterDestroy,
					final: yield* store.getMachine(seeded.machineId),
					snapshotsAfterExpiry: yield* Ref.get(control.snapshots),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.suspended.state).toBe("suspended");
		expect(result.poweredOff?.powerState).toBe("off");
		expect(result.resumed.state).toBe("ready");
		expect(result.poweredOn?.powerState).toBe("running");
		expect(result.destroyed.state).toBe("destroyed");
		expect(result.snapshotsBeforeExpiry.size).toBe(1);
		expect(result.serversAfterDestroy.size).toBe(0);
		expect(result.final?.finalSnapshotId).toBeUndefined();
		expect(result.snapshotsAfterExpiry.size).toBe(0);
	});

	test("waits for credential cleanup before taking a final snapshot", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedMachine(Date.now() - 2_000);
				const store = yield* MachineStore;
				const control = yield* FakeMachineProviderControlService;
				yield* reconcileMachines({ owner: "create-cleanup" });
				const provisioned = yield* store.getMachine(seeded.machineId);
				if (provisioned?.providerServerId === undefined) {
					return yield* Effect.die("machine was not provisioned");
				}
				yield* Ref.update(control.servers, (servers) => {
					const server = servers.get(provisioned.providerServerId as string);
					return server === undefined
						? servers
						: new Map(servers).set(provisioned.providerServerId as string, {
								...server,
								powerState: "off",
							});
				});
				yield* store.saveMachine({
					...provisioned,
					environmentId: "env_cleanup",
					state: "destroying",
					desiredState: "destroyed",
					statusCode: "destruction-queued",
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "request-cleanup" });
				const waiting = yield* store.getMachine(seeded.machineId);
				if (waiting === null)
					return yield* Effect.die("missing waiting machine");
				const snapshotsWhileWaiting = yield* Ref.get(control.snapshots);
				const serverWhileWaiting = (yield* Ref.get(control.servers)).get(
					provisioned.providerServerId,
				);
				yield* store.saveMachine({
					...waiting,
					credentialCleanupCompletedAtMs: Date.now(),
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "finish-cleanup" });
				return {
					waiting,
					serverWhileWaiting,
					snapshotsWhileWaiting,
					final: yield* store.getMachine(seeded.machineId),
					snapshotsAfterCleanup: yield* Ref.get(control.snapshots),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.waiting.credentialCleanupRequestedAtMs).toBeTypeOf("number");
		expect(result.serverWhileWaiting?.powerState).toBe("running");
		expect(result.snapshotsWhileWaiting.size).toBe(0);
		expect(result.final?.state).toBe("destroyed");
		expect(result.snapshotsAfterCleanup.size).toBe(1);
	});

	test("deletes without a final snapshot when cleanup cannot be verified", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedMachine(Date.now() - 2_000);
				const store = yield* MachineStore;
				const control = yield* FakeMachineProviderControlService;
				yield* reconcileMachines({ owner: "create-unverified" });
				const provisioned = yield* store.getMachine(seeded.machineId);
				if (provisioned?.providerServerId === undefined) {
					return yield* Effect.die("machine was not provisioned");
				}
				yield* store.saveMachine({
					...provisioned,
					environmentId: "env_unverified",
					state: "destroying",
					desiredState: "destroyed",
					statusCode: "destruction-queued",
					credentialCleanupRequestedAtMs: 1,
					credentialCleanupDeadlineMs: 2,
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "skip-snapshot" });
				return {
					machine: yield* store.getMachine(seeded.machineId),
					snapshots: yield* Ref.get(control.snapshots),
					servers: yield* Ref.get(control.servers),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.machine).toMatchObject({
			state: "destroyed",
			finalSnapshotSkipped: true,
			stableFailureCode: "credential-cleanup-unverified",
		});
		expect(result.snapshots.size).toBe(0);
		expect(result.servers.size).toBe(0);
	});

	test("fails closed when a machine has no environment to acknowledge cleanup", async () => {
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const seeded = yield* seedMachine(Date.now() - 2_000);
				const store = yield* MachineStore;
				const control = yield* FakeMachineProviderControlService;
				yield* reconcileMachines({ owner: "create-without-environment" });
				const provisioned = yield* store.getMachine(seeded.machineId);
				if (provisioned?.providerServerId === undefined) {
					return yield* Effect.die("machine was not provisioned");
				}
				yield* store.saveMachine({
					...provisioned,
					state: "destroying",
					desiredState: "destroyed",
					statusCode: "destruction-queued",
					nextActionAtMs: 0,
				});
				yield* reconcileMachines({ owner: "destroy-without-environment" });
				return {
					machine: yield* store.getMachine(seeded.machineId),
					snapshots: yield* Ref.get(control.snapshots),
				};
			}).pipe(Effect.provide(testLayer)),
		);

		expect(result.machine).toMatchObject({
			state: "destroyed",
			finalSnapshotSkipped: true,
			stableFailureCode: "credential-cleanup-unverified",
		});
		expect(result.snapshots.size).toBe(0);
	});
});
