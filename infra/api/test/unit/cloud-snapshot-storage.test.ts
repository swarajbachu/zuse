import { CLOUD_WORKSPACE_OFFER_ID } from "@zuse/contracts";
import {
	makeSandboxProviders,
	SandboxProviderError,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CloudBillingStore } from "../../src/cloud-billing-store.ts";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	deleteRetainedSnapshot,
	prepareSnapshotIntent,
	promoteRetainedSnapshot,
	reconcileSnapshotStorage,
	withSnapshotLeaseCheck,
	withSnapshotLifecycleLock,
} from "../../src/cloud-snapshot-storage.ts";
import {
	makeCloudSnapshotStoreMemory,
	SNAPSHOT_GRACE_MS,
	SNAPSHOT_MONTH_MS,
	SnapshotLifecycleLease,
	snapshotStorageCost,
} from "../../src/cloud-snapshot-store.ts";
import {
	type CloudProjectBuildRecord,
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { MachineStore, MachineStoreMemory } from "../../src/machine-store.ts";

const start = Date.parse("2026-10-01T00:00:00Z");
const periodId = `cloud:account:${start}`;
const build = (id = "build"): CloudProjectBuildRecord => ({
	buildId: id,
	projectId: "project",
	accountId: "account",
	provider: "box",
	snapshotId: `zuse-${id}`,
	templateVersion: "v1",
	configurationDigest: "digest",
	state: "ready",
	idempotencyKey: id,
	nextActionAtMs: Number.MAX_SAFE_INTEGER,
	revision: 0,
	createdAtMs: start,
	updatedAtMs: start,
});

const setup = async (
	options: {
		enforce?: boolean;
		cutover?: number;
		deletionFails?: () => boolean;
		missing?: boolean;
		inspectFails?: boolean;
	} = {},
) => {
	const deletes: string[] = [];
	const providers = Layer.effect(
		SandboxProviders,
		Effect.gen(function* () {
			const fake = yield* (yield* SandboxProviders).get("fake");
			return yield* makeSandboxProviders({
				registrations: [
					{
						adapter: {
							...fake,
							providerId: "box",
							inspectSnapshot: () =>
								options.inspectFails
									? Effect.fail(new SandboxProviderError({ code: "transient" }))
									: Effect.succeed(options.missing ? null : "ready"),
							deleteSnapshot: (id) => {
								deletes.push(id);
								return options.deletionFails?.()
									? Effect.fail(new SandboxProviderError({ code: "transient" }))
									: Effect.void;
							},
						},
					},
				],
				defaultProviderId: "box",
			});
		}),
	).pipe(Layer.provide(makeSandboxProvidersFake()), Layer.orDie);
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			CloudBillingStoreMemory,
			CloudWorkspaceStoreMemory,
			MachineStoreMemory,
			providers,
			configurationLayer({
				apiIssuer: "https://api.test",
				workosJwksUrl: "https://unused.test/jwks",
				workosIssuer: "https://unused.test",
				mintPrivateKey: Redacted.make("{}"),
				mintPublicKey: "{}",
				cloudBillingEnforcementEnabled: options.enforce ?? false,
				cloudSnapshotBillingCutoverAtMs: options.cutover ?? start,
			}),
		),
	);
	const billing = await runtime.runPromise(CloudBillingStore);
	const store = await runtime.runPromise(CloudWorkspaceStore);
	const machines = await runtime.runPromise(MachineStore);
	const entitlement = {
		entitlementId: "entitlement",
		accountId: "account",
		kind: "cloud-workspace" as const,
		offerId: CLOUD_WORKSPACE_OFFER_ID,
		provider: "polar",
		status: "active" as const,
		periodStartMs: start,
		paidThroughMs: start + 2 * SNAPSHOT_MONTH_MS,
		createdAtMs: start,
		updatedAtMs: start,
	};
	await runtime.runPromise(machines.upsertEntitlement(entitlement));
	await runtime.runPromise(
		billing.ensurePeriod({
			periodId,
			accountId: "account",
			status: "active",
			periodStartMs: start,
			periodEndMs: start + 2 * SNAPSHOT_MONTH_MS,
			nowMs: start,
		}),
	);
	const saveImage = async (id = "build", at = start) => {
		await runtime.runPromise(
			store.createBuild({
				...build(id),
				state: "sanitizing",
				snapshotId: undefined,
			}),
		);
		await runtime.runPromise(prepareSnapshotIntent(build(id), id, at));
		await runtime.runPromise(promoteRetainedSnapshot(build(id), at));
	};
	return { runtime, billing, store, machines, entitlement, deletes, saveImage };
};

describe("Boat image storage", () => {
	it("leaves customer-key images with the provider and outside platform storage billing", async () => {
		const s = await setup();
		try {
			const image = {
				...build("customer"),
				settings: { providerConnectionId: "customer-key" },
			};
			await s.runtime.runPromise(
				prepareSnapshotIntent(image, "customer", start),
			);
			await s.runtime.runPromise(promoteRetainedSnapshot(image, start));
			expect(
				await s.runtime.runPromise(s.billing.snapshots.list("account")),
			).toEqual([]);
			expect(
				await s.runtime.runPromise(s.store.getBuild(image.buildId)),
			).toMatchObject({
				snapshotId: image.snapshotId,
				settings: image.settings,
			});
			await s.saveImage("platform", start + 100);
			const replacement = { ...build("replacement"), settings: image.settings };
			const stop = start + SNAPSHOT_MONTH_MS / 2;
			await s.runtime.runPromise(
				prepareSnapshotIntent(replacement, "replacement", stop),
			);
			await s.runtime.runPromise(promoteRetainedSnapshot(replacement, stop));
			expect(
				await s.runtime.runPromise(
					s.billing.snapshots.get("account", "zuse-platform"),
				),
			).toMatchObject({ state: "deleting", stoppedAtMs: stop });
			await s.saveImage("latest", stop + 100);
			await s.runtime.runPromise(
				promoteRetainedSnapshot(replacement, stop + 200),
			);
			expect(
				await s.runtime.runPromise(
					s.billing.snapshots.get("account", "zuse-latest"),
				),
			).toMatchObject({ state: "retained" });
		} finally {
			await s.runtime.dispose();
		}
	});
	it("prorates exactly and carries fractional micro-USD over arbitrary checkpoints", () => {
		expect(snapshotStorageCost(SNAPSHOT_MONTH_MS / 2)).toEqual({
			micros: 850_000,
			remainder: 0,
		});
		expect(snapshotStorageCost(SNAPSHOT_MONTH_MS)).toEqual({
			micros: 1_700_000,
			remainder: 0,
		});
		let total = 0,
			remainder = 0;
		for (let i = 0; i < 1001; i++) {
			const cost = snapshotStorageCost(1234567, remainder);
			total += cost.micros;
			remainder = cost.remainder;
		}
		expect({ micros: total, remainder }).toEqual(
			snapshotStorageCost(1234567 * 1001),
		);
		expect(() => snapshotStorageCost(-1)).toThrow();
	});
	it("settles storage against allowance and exports once on duplicate cron delivery", async () => {
		const s = await setup();
		try {
			await s.saveImage();
			const now = start + SNAPSHOT_MONTH_MS / 2;
			await s.runtime.runPromise(reconcileSnapshotStorage(now));
			await s.runtime.runPromise(reconcileSnapshotStorage(now));
			const usage = await s.runtime.runPromise(
				s.billing.listUsage(periodId, undefined, 100),
			);
			expect(usage.items).toHaveLength(1);
			const legacyUsage = Schema.Struct({
				resourceKind: Schema.Literals(["workspace", "build", "other"]),
				providerCostMicros: Schema.Number,
			});
			expect(Schema.decodeUnknownSync(legacyUsage)(usage.items[0])).toEqual({
				resourceKind: "other",
				providerCostMicros: 850_000,
			});
			expect(usage.items[0]).toMatchObject({
				resourceKind: "other",
				usageKind: "snapshot-storage",
				resourceId: "zuse-build",
				providerCostMicros: 850_000,
			});
			const period = await s.runtime.runPromise(
				s.billing.currentPeriod("account", now),
			);
			if (period === null) throw new Error("missing period");
			expect(
				await s.runtime.runPromise(s.billing.summary(period)),
			).toMatchObject({
				storageCostMicros: 850_000,
				includedRemainingMicros: 34_150_000,
				overageChargeMicros: 0,
			});
			const exports = await s.runtime.runPromise(
				s.billing.pendingUsageExports(now, 100),
			);
			expect(exports).toHaveLength(1);
			expect(exports[0]?.metadata).toMatchObject({
				resource_kind: "snapshot",
				provider_snapshot_id: "zuse-build",
				billable: "false",
				cost_source: "approved-storage-schedule",
			});
		} finally {
			await s.runtime.dispose();
		}
	});
	it("clips cutover and switches accrual without billing temporary rebuild overlap", async () => {
		const s = await setup({ cutover: start + SNAPSHOT_MONTH_MS / 4 });
		try {
			await s.saveImage();
			await s.runtime.runPromise(
				prepareSnapshotIntent(build("second"), "second", start),
			);
			await s.runtime.runPromise(
				s.store.createBuild({ ...build("second"), state: "sanitizing" }),
			);
			await s.runtime.runPromise(
				promoteRetainedSnapshot(build("second"), start + SNAPSHOT_MONTH_MS / 2),
			);
			await s.runtime.runPromise(
				promoteRetainedSnapshot(
					build("second"),
					start + SNAPSHOT_MONTH_MS / 2 + 1,
				),
			);
			await s.runtime.runPromise(
				reconcileSnapshotStorage(start + SNAPSHOT_MONTH_MS),
			);
			const usage = await s.runtime.runPromise(
				s.billing.listUsage(periodId, undefined, 100),
			);
			expect(usage.items.reduce((n, r) => n + r.providerCostMicros, 0)).toBe(
				1_275_000,
			);
			expect(s.deletes).toEqual(["zuse-build"]);
		} finally {
			await s.runtime.dispose();
		}
	});
	it("preserves failed cleanup references and retries with backoff", async () => {
		let failing = true;
		const s = await setup({ deletionFails: () => failing });
		try {
			await s.saveImage();
			await s.runtime.runPromise(
				deleteRetainedSnapshot("account", "zuse-build", start + 100),
			);
			await s.runtime.runPromise(reconcileSnapshotStorage(start + 100));
			expect(
				(await s.runtime.runPromise(s.store.getBuild("build")))?.snapshotId,
			).toBe("zuse-build");
			expect(
				(await s.runtime.runPromise(s.billing.snapshots.list("account")))[0],
			).toMatchObject({ state: "deleting", attempts: 1 });
			await s.runtime.runPromise(reconcileSnapshotStorage(start + 101));
			expect(s.deletes).toHaveLength(1);
			failing = false;
			await s.runtime.runPromise(reconcileSnapshotStorage(start + 60_000));
			expect(
				(await s.runtime.runPromise(s.store.getBuild("build")))?.snapshotId,
			).toBeUndefined();
			await s.runtime.runPromise(
				deleteRetainedSnapshot("account", "zuse-build", start + 60_000),
			);
		} finally {
			await s.runtime.dispose();
		}
	});
	it("preserves workspace disks and waits for an in-flight replacement before cleanup", async () => {
		const s = await setup();
		try {
			await s.saveImage();
			const workspace = {
				workspaceId: "workspace",
				accountId: "account",
				projectId: "project",
				buildId: "build",
				provider: "box",
				providerSandboxId: "existing-disk",
				runtimeState: "offline" as const,
				chatId: "chat",
				initialSessionId: "session",
				branch: "task",
				baseRef: "main",
				state: "queued" as const,
				desiredState: "ready" as const,
				statusCode: "resume-queued",
				idempotencyKey: "workspace",
				requestConfig: {},
				nextActionAtMs: start,
				revision: 0,
				createdAtMs: start,
				updatedAtMs: start,
				lastActivityAtMs: start,
			};
			await s.runtime.runPromise(s.store.saveWorkspace(workspace));
			await s.runtime.runPromise(
				deleteRetainedSnapshot("account", "zuse-build", start + 1),
			);
			await s.runtime.runPromise(reconcileSnapshotStorage(start + 1));
			expect(s.deletes).toHaveLength(0);
			expect(
				(await s.runtime.runPromise(s.store.getWorkspace("workspace")))
					?.providerSandboxId,
			).toBe("existing-disk");
			await s.runtime.runPromise(
				s.store.saveWorkspace({
					...workspace,
					state: "ready",
					revision: 1,
					updatedAtMs: start + 2,
				}),
			);
			await s.runtime.runPromise(reconcileSnapshotStorage(start + 60_002));
			expect(s.deletes).toEqual(["zuse-build"]);
			expect(
				(await s.runtime.runPromise(s.store.getWorkspace("workspace")))
					?.providerSandboxId,
			).toBe("existing-disk");
		} finally {
			await s.runtime.dispose();
		}
	});

	it("fences ownership and pending builds when deleting", async () => {
		const s = await setup();
		try {
			await s.saveImage();
			await expect(
				s.runtime.runPromise(
					deleteRetainedSnapshot("other", "zuse-build", start),
				),
			).rejects.toThrow();
			await s.runtime.runPromise(
				s.store.createBuild({
					...build("pending"),
					state: "queued",
					snapshotId: undefined,
				}),
			);
			await expect(
				s.runtime.runPromise(
					deleteRetainedSnapshot("account", "zuse-build", start),
				),
			).rejects.toThrow();
			expect(
				(await s.runtime.runPromise(s.billing.snapshots.list("account")))[0]
					?.state,
			).toBe("retained");
		} finally {
			await s.runtime.dispose();
		}
	});
	it("starts seven-day grace, cancels it on recovery, and deletes on expiry", async () => {
		const s = await setup({ enforce: true });
		try {
			await s.saveImage();
			await s.runtime.runPromise(
				s.machines.upsertEntitlement({ ...s.entitlement, status: "grace" }),
			);
			await s.runtime.runPromise(reconcileSnapshotStorage(start + 1));
			expect(
				(await s.runtime.runPromise(s.billing.snapshots.list("account")))[0]
					?.graceUntilMs,
			).toBe(start + 1 + SNAPSHOT_GRACE_MS);
			await s.runtime.runPromise(s.machines.upsertEntitlement(s.entitlement));
			await s.runtime.runPromise(reconcileSnapshotStorage(start + 2));
			expect(
				(await s.runtime.runPromise(s.billing.snapshots.list("account")))[0]
					?.graceUntilMs,
			).toBeUndefined();
			await s.runtime.runPromise(
				s.machines.upsertEntitlement({
					...s.entitlement,
					status: "ended",
					paidThroughMs: start + 2,
				}),
			);
			await s.runtime.runPromise(reconcileSnapshotStorage(start + 3));
			await s.runtime.runPromise(
				reconcileSnapshotStorage(start + 3 + SNAPSHOT_GRACE_MS),
			);
			expect(s.deletes).toEqual(["zuse-build"]);
			expect(
				(await s.runtime.runPromise(s.billing.snapshots.list("account")))[0]
					?.state,
			).toBe("deleted");
		} finally {
			await s.runtime.dispose();
		}
	});
	it("recovers an expired image before provider deletion begins", async () => {
		const s = await setup({ enforce: true });
		try {
			await s.saveImage();
			const record = (
				await s.runtime.runPromise(s.billing.snapshots.list("account"))
			)[0];
			if (record === undefined) throw new Error("missing snapshot");
			await s.runtime.runPromise(
				s.billing.snapshots.save({
					...record,
					state: "deleting",
					deletionReason: "expiry",
					stoppedAtMs: start + 10,
					graceUntilMs: start + 10,
					nextAttemptAtMs: start + 10,
				}),
			);
			await s.runtime.runPromise(reconcileSnapshotStorage(start + 11));
			expect(s.deletes).toHaveLength(0);
			expect(
				(await s.runtime.runPromise(s.billing.snapshots.list("account")))[0],
			).toMatchObject({ state: "retained", checkpointAtMs: start + 11 });
		} finally {
			await s.runtime.dispose();
		}
	});

	it("provider inspection failures preserve retained images while settlement and queued cleanup continue", async () => {
		const s = await setup({ inspectFails: true });
		try {
			await s.saveImage();
			await s.saveImage("replacement", start + 100);
			await s.runtime.runPromise(
				reconcileSnapshotStorage(start + SNAPSHOT_MONTH_MS / 2),
			);
			expect(
				(
					await s.runtime.runPromise(
						s.billing.listUsage(periodId, undefined, 100),
					)
				).items,
			).toHaveLength(2);
			expect(s.deletes).toEqual(["zuse-build"]);
			expect(
				await s.runtime.runPromise(
					s.billing.snapshots.get("account", "zuse-replacement"),
				),
			).toMatchObject({
				state: "retained",
				checkpointAtMs: start + SNAPSHOT_MONTH_MS / 2,
			});
		} finally {
			await s.runtime.dispose();
		}
		const missing = await setup({ missing: true });
		try {
			await missing.saveImage();
			await missing.runtime.runPromise(reconcileSnapshotStorage(start + 100));
			expect(
				(
					await missing.runtime.runPromise(
						missing.billing.snapshots.list("account"),
					)
				)[0]?.state,
			).toBe("deleted");
		} finally {
			await missing.runtime.dispose();
		}
	});

	it("renews a lifecycle lease and interrupts provider work if ownership is lost", async () => {
		vi.useFakeTimers();
		const s = await setup();
		let started = false;
		const renew = vi
			.spyOn(s.billing.snapshots, "renewLease")
			.mockReturnValue(Effect.succeed(false));
		try {
			const pending = s.runtime.runPromiseExit(
				withSnapshotLifecycleLock(
					"account",
					"box",
					Effect.sync(() => {
						started = true;
					}).pipe(Effect.andThen(Effect.never)),
				),
			);
			await vi.advanceTimersByTimeAsync(1);
			expect(started).toBe(true);
			await vi.advanceTimersByTimeAsync(30_000);
			expect((await pending)._tag).toBe("Failure");
			expect(renew).toHaveBeenCalledOnce();
			expect(
				await s.runtime.runPromise(
					s.billing.snapshots.claimLease(
						"account",
						"replacement-owner",
						60_000,
					),
				),
			).toBe(true);
		} finally {
			vi.useRealTimers();
			await s.runtime.dispose();
		}
	});

	it("expired leases can be reclaimed and stale owners cannot renew or release them", async () => {
		vi.useFakeTimers();
		const snapshots = makeCloudSnapshotStoreMemory();
		try {
			expect(
				await Effect.runPromise(
					snapshots.claimLease("account", "first", 1_000),
				),
			).toBe(true);
			expect(
				await Effect.runPromise(
					snapshots.claimLease("account", "second", 1_000),
				),
			).toBe(false);
			await vi.advanceTimersByTimeAsync(1_001);
			expect(
				await Effect.runPromise(
					snapshots.claimLease("account", "second", 1_000),
				),
			).toBe(true);
			expect(
				await Effect.runPromise(
					snapshots.renewLease("account", "first", 1_000),
				),
			).toBe(false);
			const staleContext = Effect.provideService(SnapshotLifecycleLease, {
				accountId: "account",
				owner: "first",
			});
			let mutated = false;
			const sideEffect = Effect.sync(() => {
				mutated = true;
			});
			await expect(
				Effect.runPromise(
					snapshots.transaction("account", sideEffect).pipe(staleContext),
				),
			).rejects.toThrow("lease lost");
			const s = await setup();
			try {
				await s.runtime.runPromise(
					s.billing.snapshots.claimLease("account", "second", 60_000),
				);
				await expect(
					s.runtime.runPromise(
						withSnapshotLeaseCheck(sideEffect).pipe(staleContext),
					),
				).rejects.toThrow("lease lost");
			} finally {
				await s.runtime.dispose();
			}
			expect(mutated).toBe(false);
			await Effect.runPromise(snapshots.releaseLease("account", "first"));
			expect(
				await Effect.runPromise(
					snapshots.claimLease("account", "third", 1_000),
				),
			).toBe(false);
			expect(
				await Effect.runPromise(
					snapshots.renewLease("account", "second", 1_000),
				),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

it("settles stopped images after confirmed deletion when period evidence arrives late", async () => {
	const s = await setup();
	try {
		await s.saveImage();
		const missing = vi
			.spyOn(s.billing, "periodsOverlapping")
			.mockReturnValue(Effect.succeed([]));
		const stop = start + SNAPSHOT_MONTH_MS / 2;
		await s.runtime.runPromise(
			deleteRetainedSnapshot("account", "zuse-build", stop),
		);
		await s.runtime.runPromise(reconcileSnapshotStorage(stop));
		expect(
			(
				await s.runtime.runPromise(
					s.billing.snapshots.get("account", "zuse-build"),
				)
			)?.state,
		).toBe("deleted");
		missing.mockRestore();
		await s.runtime.runPromise(reconcileSnapshotStorage(stop + 1));
		const usage = await s.runtime.runPromise(
			s.billing.listUsage(periodId, undefined, 100),
		);
		expect(usage.items).toHaveLength(1);
		expect(usage.items[0]?.providerCostMicros).toBe(850_000);
		expect(
			await s.runtime.runPromise(
				s.billing.snapshots.list(undefined, false, true),
			),
		).toEqual([]);
		await s.runtime.runPromise(reconcileSnapshotStorage(stop + 2));
		expect(
			(
				await s.runtime.runPromise(
					s.billing.listUsage(periodId, undefined, 100),
				)
			).items,
		).toHaveLength(1);
	} finally {
		vi.restoreAllMocks();
		await s.runtime.dispose();
	}
});

it("allows concurrent snapshot readers while fencing lifecycle writers and stale readers", async () => {
	const store = makeCloudSnapshotStoreMemory();
	const claim = (owner: string, mode: "shared" | "exclusive") =>
		Effect.runPromise(store.claimLease("account", owner, 60_000, mode));
	expect(await claim("reader-a", "shared")).toBe(true);
	expect(await claim("reader-b", "shared")).toBe(true);
	expect(await claim("delete", "exclusive")).toBe(false);
	await expect(
		Effect.runPromise(
			store.transaction("account", Effect.void).pipe(
				Effect.provideService(SnapshotLifecycleLease, {
					accountId: "account",
					owner: "reader-a",
					mode: "shared",
				}),
			),
		),
	).rejects.toThrow();
	await Effect.runPromise(store.releaseLease("account", "reader-a"));
	expect(await claim("delete", "exclusive")).toBe(false);
	expect(
		await Effect.runPromise(store.renewLease("account", "reader-a", 60_000)),
	).toBe(false);
	await Effect.runPromise(store.releaseLease("account", "reader-b"));
	expect(await claim("delete", "exclusive")).toBe(true);
	expect(await claim("reader-c", "shared")).toBe(false);
	expect(
		await Effect.runPromise(
			store.claimLease("other-account", "reader-c", 60_000, "shared"),
		),
	).toBe(true);
	await Effect.runPromise(store.releaseLease("account", "delete"));
	expect(await claim("reader-c", "shared")).toBe(true);
});
