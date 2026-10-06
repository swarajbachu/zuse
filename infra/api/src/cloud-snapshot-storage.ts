import { SandboxProviders, zuseSnapshotName } from "@zuse/sandbox-providers";
import { Clock, Effect } from "effect";
import { ensureAccountCloudBillingPeriod } from "./cloud-billing-period.ts";
import { CloudBillingStore } from "./cloud-billing-store.ts";
import {
	type CloudSnapshotRecord,
	SNAPSHOT_GRACE_MS,
	SNAPSHOT_RATE_VERSION,
	SNAPSHOT_SETTLEMENT_INTERVAL_MS,
	SnapshotLifecycleLease,
	snapshotStorageCost,
} from "./cloud-snapshot-store.ts";
import {
	type CloudProjectBuildRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { conflict } from "./errors.ts";

const SNAPSHOT_LEASE_TTL_MS = 5 * 60_000;

/** Called under the account transaction. Existing saved images are never back-billed. */
const settleSnapshot = Effect.fn("settleSnapshot")(function* (
	record: CloudSnapshotRecord,
	nowMs: number,
) {
	const billing = yield* CloudBillingStore;
	const cutover = (yield* ApiConfiguration).cloudSnapshotBillingCutoverAtMs;
	if (cutover === undefined || record.retainedAtMs === undefined) return record;
	const end = Math.min(nowMs, record.stoppedAtMs ?? nowMs);
	let cursor = Math.max(record.checkpointAtMs ?? record.retainedAtMs, cutover);
	if (
		end <= cursor ||
		(record.stoppedAtMs === undefined &&
			end - cursor < SNAPSHOT_SETTLEMENT_INTERVAL_MS)
	)
		return end <= cursor
			? {
					...record,
					checkpointAtMs: Math.max(
						record.checkpointAtMs ?? record.retainedAtMs,
						end,
					),
				}
			: record;
	const periods = yield* billing.periodsOverlapping(
		record.accountId,
		cursor,
		end,
	);
	const rate = yield* billing.snapshots.price();
	let remainder = record.remainder;
	for (const period of periods) {
		const start = Math.max(cursor, period.periodStartMs);
		const until = Math.min(end, period.periodEndMs);
		if (until <= start) continue;
		// Gaps represent storage absorbed without a valid subscription, not catch-up charges.
		if (start > cursor) remainder = 0;
		const cost = snapshotStorageCost(until - start, remainder, rate);
		const eventId = `snapshot:${record.snapshotId}:${SNAPSHOT_RATE_VERSION}:${start}:${until}`;
		yield* billing.recordProviderEvent({
			provider: "box",
			eventId,
			type: "snapshot-storage",
			providerResourceId: record.snapshotId,
			payload: { priceVersion: SNAPSHOT_RATE_VERSION, start, until },
			receivedAtMs: nowMs,
			occurredAtMs: until,
			expiresAtMs: nowMs + 90 * 24 * 60 * 60_000,
		});
		yield* billing.recordProviderExecutionBatch({
			provider: "box",
			eventId,
			providerExecutionId: eventId,
			finalizedAtMs: nowMs,
			usage: [
				{
					entryId: `box:${eventId}`,
					providerEventId: eventId,
					providerExecutionId: eventId,
					provider: "box",
					periodId: period.periodId,
					accountId: record.accountId,
					resourceKind: "snapshot",
					resourceId: record.snapshotId,
					startedAt: start,
					endedAt: until,
					vcpuCount: 0,
					memoryMib: 0,
					providerCostMicros: cost.micros,
					status: "confirmed",
					nowMs,
				},
			],
		});
		remainder = cost.remainder;
		cursor = until;
	}
	// Preserve an unsettled interval if subscription period evidence is late. Explicitly ended
	// subscriptions are handled by their persisted stop time and retention deadline.
	return { ...record, checkpointAtMs: cursor, remainder };
});

export const prepareSnapshotIntent = Effect.fn("prepareSnapshotIntent")(
	function* (build: CloudProjectBuildRecord, name: string, nowMs: number) {
		if (build.provider !== "box") return;
		const billing = yield* CloudBillingStore;
		yield* snapshotTransaction(
			build.accountId,
			Effect.gen(function* () {
				const snapshotId = zuseSnapshotName(name);
				const existing = yield* billing.snapshots.get(
					build.accountId,
					snapshotId,
				);
				if (existing !== null) {
					if (
						existing.buildId !== build.buildId ||
						existing.state === "deleting" ||
						existing.state === "deleted"
					)
						return yield* Effect.fail(conflict("cloud_snapshot_unavailable"));
					return;
				}
				yield* billing.snapshots.save({
					snapshotId,
					provider: "box",
					accountId: build.accountId,
					buildId: build.buildId,
					state: "creating",
					createdAtMs: nowMs,
					remainder: 0,
					attempts: 0,
					nextAttemptAtMs: nowMs,
				});
			}),
		);
	},
);

/** Promotion and the saved build state share the transaction and account lock. */
export const promoteRetainedSnapshot = Effect.fn("promoteRetainedSnapshot")(
	function* (build: CloudProjectBuildRecord, nowMs: number) {
		const store = yield* CloudWorkspaceStore;
		if (build.provider !== "box" || build.snapshotId === undefined)
			return yield* store.saveBuild(build);
		const billing = yield* CloudBillingStore;
		yield* snapshotTransaction(
			build.accountId,
			Effect.gen(function* () {
				const records = yield* billing.snapshots.list(build.accountId, false);
				const image = records.find(
					(r) =>
						r.snapshotId === build.snapshotId && r.buildId === build.buildId,
				);
				if (
					image === undefined ||
					image.state === "deleting" ||
					image.state === "deleted"
				)
					return yield* Effect.fail(conflict("cloud_snapshot_unavailable"));
				if (image.state === "retained") return; // A retry cannot reset accrual.
				for (const previous of records.filter((r) => r.state === "retained")) {
					const stopped = yield* settleSnapshot(
						{ ...previous, stoppedAtMs: nowMs },
						nowMs,
					);
					yield* billing.snapshots.save({
						...stopped,
						state: "deleting",
						deletionReason: "superseded",
						nextAttemptAtMs: nowMs,
					});
				}
				yield* billing.snapshots.save({
					...image,
					state: "retained",
					retainedAtMs: nowMs,
					checkpointAtMs: nowMs,
				});
				yield* store.saveBuild(build);
			}),
		);
	},
);

export const deleteRetainedSnapshot = Effect.fn("deleteRetainedSnapshot")(
	function* (accountId: string, snapshotId: string, nowMs: number) {
		const billing = yield* CloudBillingStore;
		const store = yield* CloudWorkspaceStore;
		yield* snapshotTransaction(
			accountId,
			Effect.gen(function* () {
				const record = yield* billing.snapshots.get(accountId, snapshotId);
				if (record === null)
					return yield* Effect.fail(conflict("cloud_snapshot_not_found"));
				if (record.state === "deleting" || record.state === "deleted") return;
				const builds = yield* store.listAccountBuilds(accountId, "box");
				if (
					builds.some((b) =>
						["queued", "building", "sanitizing"].includes(b.state),
					)
				)
					return yield* Effect.fail(conflict("cloud_image_build_in_progress"));
				const stopped = yield* settleSnapshot(
					{ ...record, stoppedAtMs: nowMs },
					nowMs,
				);
				yield* billing.snapshots.save({
					...stopped,
					state: "deleting",
					deletionReason: "user",
					nextAttemptAtMs: nowMs,
				});
			}),
		);
	},
);

export const assertSnapshotUsable = Effect.fn("assertSnapshotUsable")(
	function* (
		accountId: string,
		provider: string,
		snapshotId: string | undefined,
	) {
		if (provider !== "box") return;
		if (snapshotId === undefined)
			return yield* Effect.fail(conflict("cloud_snapshot_unavailable"));
		const record = yield* (yield* CloudBillingStore).snapshots.get(
			accountId,
			snapshotId,
		);
		if (record !== null && record.state !== "retained")
			return yield* Effect.fail(conflict("cloud_snapshot_unavailable"));
	},
);

/** Provider calls that consume saved images share the same fence as deletion and promotion. */
export const withSnapshotLifecycleLock = <A, E, R>(
	accountId: string,
	provider: string,
	effect: Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		if (provider !== "box") return yield* effect;
		const snapshots = (yield* CloudBillingStore).snapshots;
		const owner = crypto.randomUUID();
		const ttlMs = SNAPSHOT_LEASE_TTL_MS;
		const acquire = Effect.gen(function* () {
			const deadline = (yield* Clock.currentTimeMillis) + 15_000;
			while (!(yield* snapshots.claimLease(accountId, owner, ttlMs))) {
				if ((yield* Clock.currentTimeMillis) >= deadline)
					return yield* Effect.fail(conflict("cloud_snapshot_busy"));
				yield* Effect.sleep("100 millis");
			}
		});
		const renew = Effect.gen(function* () {
			yield* Effect.sleep("30 seconds");
			if (!(yield* snapshots.renewLease(accountId, owner, ttlMs)))
				return yield* Effect.die(new Error("snapshot lifecycle lease lost"));
		}).pipe(Effect.forever);
		return yield* Effect.acquireUseRelease(
			acquire,
			() =>
				Effect.raceFirst(
					effect.pipe(
						Effect.provideService(SnapshotLifecycleLease, { accountId, owner }),
					),
					renew,
				),
			() => snapshots.releaseLease(accountId, owner),
		);
	});

/** Recheck immediately before provider side effects, including after a paused worker resumes. */
export const withSnapshotLeaseCheck = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
) =>
	Effect.gen(function* () {
		const lease = yield* SnapshotLifecycleLease;
		if (
			lease !== undefined &&
			!(yield* (yield* CloudBillingStore).snapshots.renewLease(
				lease.accountId,
				lease.owner,
				SNAPSHOT_LEASE_TTL_MS,
			))
		)
			return yield* Effect.die(new Error("snapshot lifecycle lease lost"));
		return yield* effect;
	});

/** All lifecycle mutations honor the provider-operation lease; SQL transactions stay short. */
const snapshotTransaction = <A, E, R>(
	accountId: string,
	effect: Effect.Effect<A, E, R>,
) =>
	withSnapshotLifecycleLock(
		accountId,
		"box",
		Effect.gen(function* () {
			return yield* (yield* CloudBillingStore).snapshots.transaction(
				accountId,
				effect,
			);
		}),
	);

/** Deletion intent has committed before any irreversible provider call. */
const cleanupAccountSnapshots = Effect.fn("cleanupAccountSnapshots")(function* (
	accountId: string,
	nowMs: number,
) {
	const billing = yield* CloudBillingStore;
	const store = yield* CloudWorkspaceStore;
	yield* Effect.gen(function* () {
		for (const record of yield* billing.snapshots.list(accountId, false)) {
			if (record.state === "deleting" && record.deletionReason === "expiry") {
				const period = yield* ensureAccountCloudBillingPeriod(accountId, nowMs);
				const status =
					period === null ? "ended" : (yield* billing.summary(period)).status;
				const replacement = (yield* billing.snapshots.list(
					accountId,
					false,
				)).some((r) => r.state === "retained");
				if (!replacement && (status === "active" || status === "manual")) {
					yield* billing.snapshots.save({
						...record,
						state: "retained",
						stoppedAtMs: undefined,
						deletionReason: undefined,
						graceUntilMs: undefined,
						checkpointAtMs: nowMs,
					});
					continue;
				}
			}
			if (record.state !== "deleting" || record.nextAttemptAtMs > nowMs)
				continue;
			const restoring = (yield* store.listWorkspaces(accountId)).some(
				(workspace) =>
					workspace.buildId === record.buildId &&
					workspace.state === "queued" &&
					workspace.desiredState === "ready" &&
					workspace.providerSandboxId !== undefined,
			);
			if (restoring) {
				yield* billing.snapshots.save({
					...record,
					nextAttemptAtMs: nowMs + 60_000,
					lastError: "workspace-restore-pending",
				});
				continue;
			}
			const provider = yield* (yield* SandboxProviders).get(record.provider);
			const result = yield* provider
				.deleteSnapshot(record.snapshotId)
				.pipe(withSnapshotLeaseCheck, Effect.result);
			if (result._tag === "Failure" && result.failure.code !== "not-found") {
				yield* billing.snapshots.save({
					...record,
					attempts: record.attempts + 1,
					lastError: result.failure.code,
					nextAttemptAtMs:
						nowMs +
						Math.min(60 * 60_000, 30_000 * 2 ** Math.min(record.attempts, 7)),
				});
				continue;
			}
			yield* billing.snapshots.transaction(
				accountId,
				Effect.gen(function* () {
					const build = yield* store.getBuild(record.buildId);
					if (build !== null && build.snapshotId === record.snapshotId)
						yield* store.saveBuild({
							...build,
							snapshotId: undefined,
							state: "failed",
							lastErrorCode: "saved-image-deleted",
							revision: build.revision + 1,
							updatedAtMs: nowMs,
						});
					yield* billing.snapshots.save({
						...record,
						state: "deleted",
						deletedAtMs: nowMs,
						lastError: undefined,
					});
				}),
			);
		}
	});
});

export const reconcileSnapshotStorage = Effect.fn("reconcileSnapshotStorage")(
	function* (nowMs: number) {
		const billing = yield* CloudBillingStore;
		const store = yield* CloudWorkspaceStore;
		const config = yield* ApiConfiguration;
		const accounts = [
			...new Set(
				(yield* billing.snapshots.list(
					undefined,
					false,
					config.cloudSnapshotBillingCutoverAtMs !== undefined,
				)).map((r) => r.accountId),
			),
		];
		yield* Effect.forEach(
			accounts,
			(accountId) =>
				withSnapshotLifecycleLock(
					accountId,
					"box",
					Effect.gen(function* () {
						const presence = new Map<
							string,
							"ready" | "saving" | "failed" | "unknown" | null
						>();
						for (const record of yield* billing.snapshots.list(
							accountId,
							false,
						)) {
							if (record.state !== "retained") continue;
							const provider = yield* (yield* SandboxProviders).get(
								record.provider,
							);
							const inspected =
								provider.inspectSnapshot === undefined
									? "unknown"
									: yield* provider
											.inspectSnapshot(record.snapshotId)
											.pipe(
												Effect.catchTag("SandboxProviderError", () =>
													Effect.succeed("unknown" as const),
												),
											);
							presence.set(record.snapshotId, inspected);
						}
						yield* billing.snapshots
							.transaction(
								accountId,
								Effect.gen(function* () {
									const period = yield* ensureAccountCloudBillingPeriod(
										accountId,
										nowMs,
									);
									for (const initial of yield* billing.snapshots.list(
										accountId,
										false,
										config.cloudSnapshotBillingCutoverAtMs !== undefined,
									)) {
										let record = initial;
										if (
											record.state === "deleting" ||
											record.state === "deleted"
										) {
											yield* billing.snapshots.save(
												yield* settleSnapshot(record, nowMs),
											);
											continue;
										}
										if (record.state === "retained") {
											if (presence.get(record.snapshotId) === null)
												record = {
													...record,
													state: "deleting",
													deletionReason: "missing",
													stoppedAtMs: nowMs,
													nextAttemptAtMs: nowMs,
												};
											record = yield* settleSnapshot(record, nowMs);
											const status =
												period === null
													? "ended"
													: (yield* billing.summary(period)).status;
											const held =
												status === "ended" ||
												status === "billing-hold" ||
												status === "grace";
											if (config.cloudBillingEnforcementEnabled) {
												if (!held)
													record = { ...record, graceUntilMs: undefined };
												else if (record.graceUntilMs === undefined)
													record = {
														...record,
														graceUntilMs: nowMs + SNAPSHOT_GRACE_MS,
													};
												else if (record.graceUntilMs <= nowMs)
													record = {
														...record,
														state: "deleting",
														deletionReason: "expiry",
														stoppedAtMs: nowMs,
														nextAttemptAtMs: nowMs,
													};
											}
											yield* billing.snapshots.save(record);
										}
										if (record.state === "creating") {
											const build = yield* store.getBuild(record.buildId);
											if (build === null || build.state === "failed") {
												record = {
													...record,
													state: "deleting",
													deletionReason: "failed-build",
													stoppedAtMs: nowMs,
													nextAttemptAtMs: nowMs,
												};
												yield* billing.snapshots.save(record);
											}
										}
									}
								}),
							)
							.pipe(Effect.andThen(cleanupAccountSnapshots(accountId, nowMs)));
					}),
				).pipe(
					Effect.catchCause((cause) => {
						console.warn("[cloud-snapshots] account reconciliation failed", {
							accountId,
							cause: String(cause),
						});
						return Effect.void;
					}),
				),
			{ concurrency: 4, discard: true },
		);
	},
);

export const queueAccountSnapshotDeletion = Effect.fn(
	"queueAccountSnapshotDeletion",
)(function* (accountId: string, nowMs: number) {
	const billing = yield* CloudBillingStore;
	return yield* snapshotTransaction(
		accountId,
		Effect.gen(function* () {
			for (const record of yield* billing.snapshots.list(accountId, false)) {
				if (record.state === "deleted" || record.state === "deleting") continue;
				const stopped = yield* settleSnapshot(
					{ ...record, stoppedAtMs: nowMs },
					nowMs,
				);
				yield* billing.snapshots.save({
					...stopped,
					state: "deleting",
					deletionReason: "account",
					nextAttemptAtMs: nowMs,
				});
			}
			return (yield* billing.snapshots.list(accountId, false)).some(
				(r) => r.state !== "deleted",
			);
		}),
	);
});
