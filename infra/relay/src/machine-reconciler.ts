import type { BillingProviders } from "@zuse/billing-providers";
import {
	type MachineProviderAdapter,
	type MachineProviderError,
	MachineProviders,
} from "@zuse/machine-providers";
import { Clock, Effect } from "effect";
import { AccountIdentity } from "./account-identity.ts";
import { cancelProviderSubscription } from "./billing-operations.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { MachineControlConfiguration } from "./machine-config.ts";
import { requestMachineDestruction } from "./machine-lifecycle.ts";
import { findMachineOffer } from "./machine-offers.ts";
import {
	type MachinePersistenceRecord,
	MachineStore,
} from "./machine-store.ts";
import { ManagedTunnelProvider } from "./managed-tunnel.ts";
import { RelayStore } from "./store.ts";

export type MachineReconcilerContext =
	| MachineStore
	| MachineProviders
	| BillingProviders
	| ManagedTunnelProvider
	| RelayStore
	| AccountIdentity;

const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 15 * 60 * 1_000;

const retryAt = (nowMs: number, attemptCount: number): number =>
	nowMs +
	Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(attemptCount, MAX_ATTEMPTS));

const withProviderFailure = (
	machine: MachinePersistenceRecord,
	nowMs: number,
	error: MachineProviderError,
): MachinePersistenceRecord => {
	const attemptCount = machine.attemptCount + 1;
	const exhausted = attemptCount >= MAX_ATTEMPTS || error.code === "rejected";
	return {
		...machine,
		state: exhausted ? "failed" : machine.state,
		statusCode: exhausted ? "reconciliation-failed" : "provider-unavailable",
		stableFailureCode:
			error.code === "rejected"
				? "provider-rejected"
				: error.code === "not-found"
					? "provider-machine-missing"
					: "provider-temporarily-unavailable",
		attemptCount,
		nextActionAtMs: exhausted
			? nowMs + MAX_BACKOFF_MS
			: retryAt(nowMs, attemptCount),
		updatedAtMs: nowMs,
	};
};

const withBillingFailure = (
	machine: MachinePersistenceRecord,
	nowMs: number,
): MachinePersistenceRecord => {
	const attemptCount = machine.attemptCount + 1;
	return {
		...machine,
		state: "destroying",
		statusCode: "reconciliation-failed",
		stableFailureCode: "billing-provider-unavailable",
		attemptCount,
		nextActionAtMs: retryAt(nowMs, attemptCount),
		updatedAtMs: nowMs,
	};
};

const withCancellationBillingFailure = (
	machine: MachinePersistenceRecord,
	nowMs: number,
): MachinePersistenceRecord => {
	const attemptCount = machine.attemptCount + 1;
	return {
		...machine,
		statusCode: "reconciliation-failed",
		stableFailureCode: "billing-provider-unavailable",
		attemptCount,
		nextActionAtMs: retryAt(nowMs, attemptCount),
		updatedAtMs: nowMs,
	};
};

const withMissingProviderMachine = (
	machine: MachinePersistenceRecord,
	nowMs: number,
): MachinePersistenceRecord => ({
	...machine,
	state: "failed",
	statusCode: "reconciliation-failed",
	stableFailureCode: "provider-machine-missing",
	nextActionAtMs: Number.MAX_SAFE_INTEGER,
	updatedAtMs: nowMs,
});

const reconcileReadyTarget = Effect.fn("reconcileReadyTarget")(function* (
	machine: MachinePersistenceRecord,
	nowMs: number,
	provider: MachineProviderAdapter,
) {
	const store = yield* MachineStore;

	const retryableCreateFailure =
		machine.state === "failed" &&
		machine.attemptCount < MAX_ATTEMPTS &&
		machine.stableFailureCode === "provider-temporarily-unavailable";
	if (machine.state === "creating" || retryableCreateFailure) {
		const offer = findMachineOffer(machine.offerId);
		if (offer === undefined) {
			return {
				...machine,
				state: "failed" as const,
				statusCode: "reconciliation-failed" as const,
				stableFailureCode: "unknown-offer",
				nextActionAtMs: nowMs + MAX_BACKOFF_MS,
				updatedAtMs: nowMs,
			};
		}
		const recoveredResult = yield* provider
			.recoverByLabel(machine.providerLabel)
			.pipe(Effect.result);
		if (recoveredResult._tag === "Failure") {
			return withProviderFailure(machine, nowMs, recoveredResult.failure);
		}
		const recovered = recoveredResult.success;
		if (recovered !== null) {
			return {
				...machine,
				providerServerId: recovered.providerServerId,
				state: "bootstrapping" as const,
				statusCode: "bootstrap-pending" as const,
				stableFailureCode: undefined,
				lastError: undefined,
				attemptCount: 0,
				nextActionAtMs: nowMs + 60_000,
				updatedAtMs: nowMs,
			};
		}
		const enrollmentToken = yield* randomToken("zenr");
		const enrollmentTokenHash = yield* sha256Hex(enrollmentToken);
		const config = yield* MachineControlConfiguration;
		const tokenReady: MachinePersistenceRecord = {
			...machine,
			enrollmentTokenHash,
			enrollmentExpiresAtMs: nowMs + config.enrollmentTtlMs,
			statusCode: "provider-provisioning",
			updatedAtMs: nowMs,
		};
		// Persist the hash before the plaintext token is sent to provider bootstrap.
		const tokenSaved = yield* store.compareAndSetMachine(
			tokenReady,
			machine.revision,
		);
		if (!tokenSaved) return machine;
		const persistedTokenReady = {
			...tokenReady,
			revision: machine.revision + 1,
		};
		const createdResult = yield* provider
			.create({
				machineId: machine.machineId,
				providerLabel: machine.providerLabel,
				offer,
				enrollmentToken,
			})
			.pipe(Effect.result);
		if (createdResult._tag === "Failure") {
			return withProviderFailure(
				persistedTokenReady,
				nowMs,
				createdResult.failure,
			);
		}
		const created = createdResult.success;
		return {
			...persistedTokenReady,
			providerServerId: created.providerServerId,
			state: "bootstrapping" as const,
			statusCode: "bootstrap-pending" as const,
			stableFailureCode: undefined,
			lastError: undefined,
			attemptCount: 0,
			nextActionAtMs: nowMs + 60_000,
			updatedAtMs: nowMs,
		};
	}

	if (machine.state === "failed") {
		return {
			...machine,
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
			updatedAtMs: nowMs,
		};
	}

	if (machine.state === "bootstrapping" || machine.state === "enrolling") {
		if (machine.providerServerId === undefined) {
			return withMissingProviderMachine(machine, nowMs);
		}
		const inspected = yield* provider
			.inspect(machine.providerServerId)
			.pipe(Effect.result);
		if (inspected._tag === "Failure") {
			return withProviderFailure(machine, nowMs, inspected.failure);
		}
		if (inspected.success === null) {
			return withMissingProviderMachine(machine, nowMs);
		}
		if (
			machine.enrollmentExpiresAtMs === undefined ||
			machine.enrollmentExpiresAtMs <= nowMs
		) {
			return {
				...machine,
				state: "failed" as const,
				statusCode:
					machine.state === "bootstrapping"
						? ("bootstrap-failed" as const)
						: ("enrollment-failed" as const),
				stableFailureCode:
					machine.state === "bootstrapping"
						? "bootstrap-timeout"
						: "enrollment-timeout",
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				updatedAtMs: nowMs,
			};
		}
		return {
			...machine,
			attemptCount: 0,
			nextActionAtMs: nowMs + 60_000,
			updatedAtMs: nowMs,
		};
	}

	if (machine.state === "resuming") {
		if (machine.providerServerId === undefined) {
			return {
				...machine,
				state: "creating" as const,
				statusCode: "creation-queued" as const,
				nextActionAtMs: nowMs,
				updatedAtMs: nowMs,
			};
		}
		const result = yield* provider
			.powerOn(machine.providerServerId)
			.pipe(Effect.result);
		if (result._tag === "Failure") {
			return withProviderFailure(machine, nowMs, result.failure);
		}
		return {
			...machine,
			state: "ready" as const,
			statusCode: "ready" as const,
			stableFailureCode: undefined,
			attemptCount: 0,
			nextActionAtMs: Math.min(
				nowMs + 5 * 60 * 1_000,
				machine.paidThroughMs ?? Number.MAX_SAFE_INTEGER,
			),
			updatedAtMs: nowMs,
		};
	}

	if (machine.state === "ready") {
		if (machine.providerServerId === undefined) {
			return withMissingProviderMachine(machine, nowMs);
		}
		const inspected = yield* provider
			.inspect(machine.providerServerId)
			.pipe(Effect.result);
		if (inspected._tag === "Failure") {
			return withProviderFailure(machine, nowMs, inspected.failure);
		}
		if (inspected.success === null) {
			return withMissingProviderMachine(machine, nowMs);
		}
		return {
			...machine,
			statusCode:
				machine.desiredState === "suspended"
					? ("cancellation-scheduled" as const)
					: ("ready" as const),
			attemptCount: 0,
			nextActionAtMs: Math.min(
				nowMs + 5 * 60 * 1_000,
				machine.paidThroughMs ?? Number.MAX_SAFE_INTEGER,
			),
			updatedAtMs: nowMs,
		};
	}

	return {
		...machine,
		nextActionAtMs: machine.paidThroughMs ?? Number.MAX_SAFE_INTEGER,
		updatedAtMs: nowMs,
	};
});

const reconcileSuspendedTarget = Effect.fn("reconcileSuspendedTarget")(
	function* (
		machine: MachinePersistenceRecord,
		nowMs: number,
		provider: MachineProviderAdapter,
	) {
		if (machine.state !== "suspended") {
			const store = yield* MachineStore;
			const entitlements = yield* store.listEntitlements(machine.accountId);
			const entitlement = entitlements.find(
				(item) => item.entitlementId === machine.entitlementId,
			);
			if (entitlement?.providerSubscriptionId !== undefined) {
				const cancelled = yield* cancelProviderSubscription({
					providerId: entitlement.provider,
					providerSubscriptionId: entitlement.providerSubscriptionId,
				}).pipe(Effect.result);
				if (cancelled._tag === "Failure") {
					return withCancellationBillingFailure(machine, nowMs);
				}
			}
		}
		if (
			machine.state === "suspended" &&
			machine.recoveryDeadlineMs !== undefined &&
			machine.recoveryDeadlineMs <= nowMs
		) {
			return requestMachineDestruction(machine, nowMs);
		}
		if (machine.state === "suspended") {
			return {
				...machine,
				statusCode: "recovery-available" as const,
				nextActionAtMs: machine.recoveryDeadlineMs ?? Number.MAX_SAFE_INTEGER,
				updatedAtMs: nowMs,
			};
		}
		if (machine.paidThroughMs !== undefined && machine.paidThroughMs > nowMs) {
			return yield* reconcileReadyTarget(machine, nowMs, provider);
		}
		if (machine.providerServerId === undefined) {
			return {
				...machine,
				state: "suspended" as const,
				statusCode: "recovery-available" as const,
				suspendedAtMs: nowMs,
				nextActionAtMs: machine.recoveryDeadlineMs ?? Number.MAX_SAFE_INTEGER,
				updatedAtMs: nowMs,
			};
		}
		const result = yield* provider
			.powerOff(machine.providerServerId)
			.pipe(Effect.result);
		if (result._tag === "Failure") {
			return withProviderFailure(
				{ ...machine, state: "suspending" },
				nowMs,
				result.failure,
			);
		}
		return {
			...machine,
			state: "suspended" as const,
			statusCode: "recovery-available" as const,
			suspendedAtMs: nowMs,
			attemptCount: 0,
			nextActionAtMs: machine.recoveryDeadlineMs ?? Number.MAX_SAFE_INTEGER,
			updatedAtMs: nowMs,
		};
	},
);

const reconcileDestroyedTarget = Effect.fn("reconcileDestroyedTarget")(
	function* (
		machine: MachinePersistenceRecord,
		nowMs: number,
		provider: MachineProviderAdapter,
	) {
		const config = yield* MachineControlConfiguration;

		if (machine.state === "destroyed") {
			if (
				machine.finalSnapshotId !== undefined &&
				(machine.finalSnapshotDeleteAtMs ?? Number.MAX_SAFE_INTEGER) <= nowMs
			) {
				const deleted = yield* provider
					.deleteSnapshot(machine.finalSnapshotId)
					.pipe(Effect.result);
				if (deleted._tag === "Failure") {
					return withProviderFailure(machine, nowMs, deleted.failure);
				}
				return {
					...machine,
					finalSnapshotId: undefined,
					finalSnapshotDeleteAtMs: undefined,
					nextActionAtMs: Number.MAX_SAFE_INTEGER,
					updatedAtMs: nowMs,
				};
			}
			return machine;
		}

		let updated = machine;
		if (
			machine.providerServerId !== undefined &&
			machine.finalSnapshotId === undefined
		) {
			const snapshot = yield* provider
				.snapshot(machine.providerServerId, `final-${machine.machineId}`)
				.pipe(Effect.result);
			if (snapshot._tag === "Failure") {
				return withProviderFailure(
					{ ...machine, state: "destroying" },
					nowMs,
					snapshot.failure,
				);
			}
			updated = {
				...updated,
				finalSnapshotId: snapshot.success,
				finalSnapshotDeleteAtMs: nowMs + config.finalSnapshotRetentionMs,
			};
		}

		if (updated.environmentId !== undefined) {
			const relayStore = yield* RelayStore;
			const environment = yield* relayStore.getEnvironment(
				updated.environmentId,
			);
			if (environment?.tunnelId !== undefined) {
				const tunnel = yield* ManagedTunnelProvider;
				const deprovisioned = yield* tunnel
					.deprovision({
						tunnelId: environment.tunnelId,
						dnsRecordId: environment.dnsRecordId,
					})
					.pipe(Effect.result);
				if (deprovisioned._tag === "Failure") {
					return {
						...updated,
						state: "destroying" as const,
						statusCode: "reconciliation-failed" as const,
						stableFailureCode: "tunnel-cleanup-failed",
						attemptCount: updated.attemptCount + 1,
						nextActionAtMs: retryAt(nowMs, updated.attemptCount + 1),
						updatedAtMs: nowMs,
					};
				}
			}
			yield* relayStore.deleteEnvironment(
				updated.environmentId,
				updated.accountId,
			);
		}

		const machineStore = yield* MachineStore;
		const entitlements = yield* machineStore.listEntitlements(
			updated.accountId,
		);
		const entitlement = entitlements.find(
			(item) => item.entitlementId === updated.entitlementId,
		);
		if (entitlement?.providerSubscriptionId !== undefined) {
			const cancelled = yield* cancelProviderSubscription({
				providerId: entitlement.provider,
				providerSubscriptionId: entitlement.providerSubscriptionId,
			}).pipe(Effect.result);
			if (cancelled._tag === "Failure") {
				return withBillingFailure(updated, nowMs);
			}
		}

		if (updated.providerServerId !== undefined) {
			const deleted = yield* provider
				.delete(updated.providerServerId)
				.pipe(Effect.result);
			if (deleted._tag === "Failure") {
				return withProviderFailure(updated, nowMs, deleted.failure);
			}
		}
		if (updated.accountDeletionRequestedAtMs !== undefined) {
			const identity = yield* AccountIdentity;
			const deleted = yield* identity
				.deleteUser(updated.accountId)
				.pipe(Effect.result);
			if (deleted._tag === "Failure") {
				return {
					...updated,
					state: "destroying" as const,
					statusCode: "reconciliation-failed" as const,
					stableFailureCode: "identity-deletion-failed",
					attemptCount: updated.attemptCount + 1,
					nextActionAtMs: retryAt(nowMs, updated.attemptCount + 1),
					updatedAtMs: nowMs,
				};
			}
		}

		return {
			...updated,
			state: "destroyed" as const,
			statusCode: "destroyed" as const,
			environmentId: undefined,
			enrollmentTokenHash: undefined,
			enrollmentExpiresAtMs: undefined,
			destroyedAtMs: nowMs,
			accountDeletionRequestedAtMs: undefined,
			attemptCount: 0,
			nextActionAtMs:
				updated.finalSnapshotDeleteAtMs ?? Number.MAX_SAFE_INTEGER,
			updatedAtMs: nowMs,
		};
	},
);

const reconcileOne = Effect.fn("reconcileOne")(function* (
	machine: MachinePersistenceRecord,
	nowMs: number,
) {
	const providers = yield* MachineProviders;
	const selected = yield* providers.get(machine.provider).pipe(Effect.result);
	if (selected._tag === "Failure") {
		return {
			...machine,
			statusCode: "provider-unavailable",
			stableFailureCode: "machine-provider-not-configured",
			nextActionAtMs: nowMs + MAX_BACKOFF_MS,
			updatedAtMs: nowMs,
		} satisfies MachinePersistenceRecord;
	}
	const provider = selected.success;
	switch (machine.desiredState) {
		case "ready":
			return yield* reconcileReadyTarget(machine, nowMs, provider);
		case "suspended":
			return yield* reconcileSuspendedTarget(machine, nowMs, provider);
		case "destroyed":
			return yield* reconcileDestroyedTarget(machine, nowMs, provider);
	}
});

const reconcileClaimed = Effect.fn("reconcileClaimed")(function* (
	claimed: ReadonlyArray<MachinePersistenceRecord>,
	owner: string,
	nowMs: number,
) {
	const store = yield* MachineStore;
	let processed = 0;
	for (const machine of claimed) {
		const reconciled = yield* reconcileOne(machine, nowMs);
		const saved = yield* store.saveReconciledMachine(
			reconciled,
			owner,
			reconciled.revision,
		);
		if (saved) processed += 1;
	}
	return { claimed: claimed.length, processed };
});

export const reconcileMachines = Effect.fn("reconcileMachines")(
	function* (input: { readonly owner: string }) {
		const nowMs = yield* Clock.currentTimeMillis;
		const config = yield* MachineControlConfiguration;
		const store = yield* MachineStore;
		const claimed = yield* store.claimDueMachines({
			nowMs,
			owner: input.owner,
			leaseDurationMs: config.reconcileLeaseMs,
			// Claim one row so its lease never waits behind another provider call.
			limit: 1,
		});
		return yield* reconcileClaimed(claimed, input.owner, nowMs);
	},
);

export const reconcileMachine = Effect.fn("reconcileMachine")(
	function* (input: { readonly machineId: string; readonly owner: string }) {
		const nowMs = yield* Clock.currentTimeMillis;
		const config = yield* MachineControlConfiguration;
		const store = yield* MachineStore;
		const claimed = yield* store.claimMachine({
			machineId: input.machineId,
			nowMs,
			owner: input.owner,
			leaseDurationMs: config.reconcileLeaseMs,
		});
		return yield* reconcileClaimed(
			claimed === null ? [] : [claimed],
			input.owner,
			nowMs,
		);
	},
);
