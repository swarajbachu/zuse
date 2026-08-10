import type { BillingProviders } from "@zuse/billing-providers";
import type {
	SandboxEndpoint,
	SandboxProviderAdapter,
} from "@zuse/sandbox-providers";
import { Effect } from "effect";
import { deleteAccountIdentityWhenInfrastructureIsClean } from "./account-deletion.ts";
import type { AccountIdentity } from "./account-identity.ts";
import { cancelProviderSubscription } from "./billing-operations.ts";
import { RelayConfiguration } from "./config.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { MachineControlConfiguration } from "./machine-config.ts";
import { requestMachineDestruction } from "./machine-lifecycle.ts";
import type { MachinePersistenceRecord } from "./machine-store.ts";
import { MachineStore } from "./machine-store.ts";
import {
	MAX_RECONCILE_ATTEMPTS,
	retryAt,
	withBillingFailure,
	withCancellationBillingFailure,
	withProviderFailure,
} from "./reconciliation-failures.ts";
import { SandboxOfferConfiguration } from "./sandbox-provider-module.ts";
import { RelayStore } from "./store.ts";

export type SandboxReconcilerContext =
	| MachineStore
	| BillingProviders
	| RelayConfiguration
	| SandboxOfferConfiguration
	| RelayStore
	| AccountIdentity;

const SETUP_POLL_MS = 15_000;
const READY_POLL_MS = 5 * 60 * 1_000;
const SANDBOX_HOME = "/home/zuse";
const SANDBOX_ENTRYPOINT = "/usr/local/bin/zuse-entrypoint";

const sandboxEnvironment = (input: {
	readonly machineId: string;
	readonly relayIssuer: string;
	readonly enrollmentToken: string;
}): Readonly<Record<string, string>> => ({
	ZUSE_MACHINE_ID: input.machineId,
	ZUSE_RELAY_URL: input.relayIssuer,
	ZUSE_RELAY_ISSUER: input.relayIssuer,
	ZUSE_ENROLLMENT_TOKEN: input.enrollmentToken,
});

const startSandboxServer = (
	provider: SandboxProviderAdapter,
	providerSandboxId: string,
	env: Readonly<Record<string, string>>,
) =>
	provider.startProcess(providerSandboxId, {
		command: SANDBOX_ENTRYPOINT,
		cwd: SANDBOX_HOME,
		env,
		user: "zuse",
	});

const sandboxHealthReady = (endpoint: SandboxEndpoint) =>
	Effect.tryPromise(() =>
		fetch(`${endpoint.httpBaseUrl}/healthz`, {
			signal: AbortSignal.timeout(3_000),
		}).then((response) => response.ok),
	).pipe(Effect.catch(() => Effect.succeed(false)));

const SANDBOX_OFFER_PORT = 47_837;

const missingSandbox = (
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

const ensureRunning = Effect.fn("ensureSandboxRunning")(function* (
	machine: MachinePersistenceRecord,
	nowMs: number,
	provider: SandboxProviderAdapter,
) {
	if (machine.providerServerId === undefined) {
		return {
			machine: missingSandbox(machine, nowMs),
			running: false,
			missing: true,
		} as const;
	}
	const inspected = yield* provider
		.inspect(machine.providerServerId)
		.pipe(Effect.result);
	if (inspected._tag === "Failure") {
		return {
			machine: withProviderFailure(machine, nowMs, inspected.failure),
			running: false,
			missing: false,
		} as const;
	}
	if (inspected.success === null) {
		return {
			machine: missingSandbox(machine, nowMs),
			running: false,
			missing: true,
		} as const;
	}
	const config = yield* SandboxOfferConfiguration;
	if (inspected.success.state === "paused") {
		const resumed = yield* provider
			.resume(machine.providerServerId, config.keepAliveTimeoutSeconds)
			.pipe(Effect.result);
		if (resumed._tag === "Failure") {
			return {
				machine: withProviderFailure(machine, nowMs, resumed.failure),
				running: false,
				missing: false,
			} as const;
		}
	}
	const extended = yield* provider
		.extendTimeout(machine.providerServerId, config.keepAliveTimeoutSeconds)
		.pipe(Effect.result);
	if (extended._tag === "Failure") {
		return {
			machine: withProviderFailure(machine, nowMs, extended.failure),
			running: false,
			missing: false,
		} as const;
	}
	return { machine, running: true, missing: false } as const;
});

const reconcileReadyTarget = Effect.fn("reconcileSandboxReadyTarget")(
	function* (
		machine: MachinePersistenceRecord,
		nowMs: number,
		provider: SandboxProviderAdapter,
	) {
		const retryableCreateFailure =
			machine.state === "failed" &&
			machine.attemptCount < MAX_RECONCILE_ATTEMPTS &&
			machine.stableFailureCode === "provider-temporarily-unavailable";
		if (machine.state === "creating" || retryableCreateFailure) {
			const recoveredResult = yield* provider
				.recoverByLabel(machine.providerLabel)
				.pipe(Effect.result);
			if (recoveredResult._tag === "Failure") {
				return withProviderFailure(machine, nowMs, recoveredResult.failure);
			}
			if (recoveredResult.success !== null) {
				const endpointResult = yield* provider
					.resolveEndpoint(
						recoveredResult.success.providerSandboxId,
						SANDBOX_OFFER_PORT,
					)
					.pipe(Effect.result);
				if (endpointResult._tag === "Failure") {
					return withProviderFailure(machine, nowMs, endpointResult.failure);
				}
				if (yield* sandboxHealthReady(endpointResult.success)) {
					return {
						...machine,
						providerServerId: recoveredResult.success.providerSandboxId,
						providerEndpointHttpBaseUrl: endpointResult.success.httpBaseUrl,
						providerEndpointWsBaseUrl: endpointResult.success.wsBaseUrl,
						state: "bootstrapping" as const,
						statusCode: "bootstrap-pending" as const,
						stableFailureCode: undefined,
						lastError: undefined,
						attemptCount: 0,
						nextActionAtMs: nowMs + SETUP_POLL_MS,
						updatedAtMs: nowMs,
					};
				}
				const enrollmentToken = yield* randomToken("zenr");
				const enrollmentTokenHash = yield* sha256Hex(enrollmentToken);
				const machineConfig = yield* MachineControlConfiguration;
				const relay = yield* RelayConfiguration;
				const store = yield* MachineStore;
				const recovered: MachinePersistenceRecord = {
					...machine,
					providerServerId: recoveredResult.success.providerSandboxId,
					providerEndpointHttpBaseUrl: endpointResult.success.httpBaseUrl,
					providerEndpointWsBaseUrl: endpointResult.success.wsBaseUrl,
					enrollmentTokenHash,
					enrollmentExpiresAtMs: nowMs + machineConfig.enrollmentTtlMs,
					statusCode: "provider-provisioning" as const,
					updatedAtMs: nowMs,
				};
				const recoveredSaved = yield* store.compareAndSetMachine(
					recovered,
					machine.revision,
				);
				if (!recoveredSaved) return machine;
				const persisted = { ...recovered, revision: machine.revision + 1 };
				const started = yield* startSandboxServer(
					provider,
					recoveredResult.success.providerSandboxId,
					sandboxEnvironment({
						machineId: machine.machineId,
						relayIssuer: relay.relayIssuer,
						enrollmentToken,
					}),
				).pipe(Effect.result);
				if (started._tag === "Failure") {
					return withProviderFailure(persisted, nowMs, started.failure);
				}
				return {
					...persisted,
					state: "bootstrapping" as const,
					statusCode: "bootstrap-pending" as const,
					stableFailureCode: undefined,
					lastError: undefined,
					attemptCount: 0,
					nextActionAtMs: nowMs + SETUP_POLL_MS,
					updatedAtMs: nowMs,
				};
			}

			const enrollmentToken = yield* randomToken("zenr");
			const enrollmentTokenHash = yield* sha256Hex(enrollmentToken);
			const machineConfig = yield* MachineControlConfiguration;
			const sandboxConfig = yield* SandboxOfferConfiguration;
			const relay = yield* RelayConfiguration;
			const store = yield* MachineStore;
			const tokenReady: MachinePersistenceRecord = {
				...machine,
				enrollmentTokenHash,
				enrollmentExpiresAtMs: nowMs + machineConfig.enrollmentTtlMs,
				statusCode: "provider-provisioning",
				updatedAtMs: nowMs,
			};
			const tokenSaved = yield* store.compareAndSetMachine(
				tokenReady,
				machine.revision,
			);
			if (!tokenSaved) return machine;
			const persisted = { ...tokenReady, revision: machine.revision + 1 };
			const env = sandboxEnvironment({
				machineId: machine.machineId,
				relayIssuer: relay.relayIssuer,
				enrollmentToken,
			});
			const createdResult = yield* provider
				.create({
					sandboxId: machine.machineId,
					providerLabel: machine.providerLabel,
					timeoutSeconds: sandboxConfig.createTimeoutSeconds,
					env: {},
					network: { kind: "open" },
				})
				.pipe(Effect.result);
			if (createdResult._tag === "Failure") {
				return withProviderFailure(persisted, nowMs, createdResult.failure);
			}
			const endpointResult = yield* provider
				.resolveEndpoint(
					createdResult.success.providerSandboxId,
					SANDBOX_OFFER_PORT,
				)
				.pipe(Effect.result);
			if (endpointResult._tag === "Failure") {
				yield* provider
					.kill(createdResult.success.providerSandboxId)
					.pipe(Effect.ignore);
				return withProviderFailure(persisted, nowMs, endpointResult.failure);
			}
			const providerReady: MachinePersistenceRecord = {
				...persisted,
				providerServerId: createdResult.success.providerSandboxId,
				providerEndpointHttpBaseUrl: endpointResult.success.httpBaseUrl,
				providerEndpointWsBaseUrl: endpointResult.success.wsBaseUrl,
				updatedAtMs: nowMs,
			};
			const providerSaved = yield* store.compareAndSetMachine(
				providerReady,
				persisted.revision,
			);
			if (!providerSaved) {
				// Another lifecycle action won the row while create was in flight. The
				// new provider object is not represented by that row, so clean it up.
				yield* provider
					.kill(createdResult.success.providerSandboxId)
					.pipe(Effect.ignore);
				return persisted;
			}
			const providerPersisted = {
				...providerReady,
				revision: persisted.revision + 1,
			};
			const started = yield* startSandboxServer(
				provider,
				createdResult.success.providerSandboxId,
				env,
			).pipe(Effect.result);
			if (started._tag === "Failure") {
				return withProviderFailure(providerPersisted, nowMs, started.failure);
			}
			return {
				...providerPersisted,
				state: "bootstrapping" as const,
				statusCode: "bootstrap-pending" as const,
				stableFailureCode: undefined,
				lastError: undefined,
				attemptCount: 0,
				nextActionAtMs: nowMs + SETUP_POLL_MS,
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
			const ensured = yield* ensureRunning(machine, nowMs, provider);
			if (!ensured.running) return ensured.machine;
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
				nextActionAtMs: nowMs + SETUP_POLL_MS,
				updatedAtMs: nowMs,
			};
		}

		if (
			machine.state === "resuming" &&
			machine.providerServerId === undefined
		) {
			return {
				...machine,
				state: "creating" as const,
				statusCode: "creation-queued" as const,
				nextActionAtMs: nowMs,
				updatedAtMs: nowMs,
			};
		}

		if (machine.state === "ready" || machine.state === "resuming") {
			const ensured = yield* ensureRunning(machine, nowMs, provider);
			if (!ensured.running) {
				if (machine.state !== "resuming" || !ensured.missing) {
					return ensured.machine;
				}
				if (machine.environmentId !== undefined) {
					yield* (yield* RelayStore).deleteEnvironment(
						machine.environmentId,
						machine.accountId,
					);
				}
				return {
					...machine,
					state: "creating" as const,
					statusCode: "creation-queued" as const,
					providerServerId: undefined,
					providerEndpointHttpBaseUrl: undefined,
					providerEndpointWsBaseUrl: undefined,
					environmentId: undefined,
					enrolledEnvironmentPublicKey: undefined,
					enrollmentTokenHash: undefined,
					enrollmentExpiresAtMs: undefined,
					stableFailureCode: undefined,
					attemptCount: 0,
					nextActionAtMs: nowMs,
					updatedAtMs: nowMs,
				};
			}
			return {
				...machine,
				state: "ready" as const,
				statusCode:
					machine.desiredState === "suspended"
						? ("cancellation-scheduled" as const)
						: ("ready" as const),
				stableFailureCode: undefined,
				attemptCount: 0,
				nextActionAtMs: Math.min(
					nowMs + READY_POLL_MS,
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
	},
);

const cancelSubscription = Effect.fn("cancelSandboxSubscription")(function* (
	machine: MachinePersistenceRecord,
) {
	const store = yield* MachineStore;
	const entitlement = (yield* store.listEntitlements(machine.accountId)).find(
		(item) => item.entitlementId === machine.entitlementId,
	);
	if (entitlement?.providerSubscriptionId === undefined) return true;
	return (
		(yield* cancelProviderSubscription({
			providerId: entitlement.provider,
			providerSubscriptionId: entitlement.providerSubscriptionId,
		}).pipe(Effect.result))._tag === "Success"
	);
});

const reconcileSuspendedTarget = Effect.fn("reconcileSandboxSuspendedTarget")(
	function* (
		machine: MachinePersistenceRecord,
		nowMs: number,
		provider: SandboxProviderAdapter,
	) {
		if (
			machine.state !== "suspended" &&
			!(yield* cancelSubscription(machine))
		) {
			return withCancellationBillingFailure(machine, nowMs);
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
		if (machine.providerServerId !== undefined) {
			const paused = yield* provider
				.pause(machine.providerServerId)
				.pipe(Effect.result);
			if (paused._tag === "Failure") {
				return withProviderFailure(
					{ ...machine, state: "suspending" },
					nowMs,
					paused.failure,
				);
			}
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

const reconcileDestroyedTarget = Effect.fn("reconcileSandboxDestroyedTarget")(
	function* (
		machine: MachinePersistenceRecord,
		nowMs: number,
		provider: SandboxProviderAdapter,
	) {
		if (machine.state === "destroyed") {
			if (machine.accountDeletionRequestedAtMs === undefined) return machine;
			const identity =
				yield* deleteAccountIdentityWhenInfrastructureIsClean(machine);
			if (identity === "deferred") {
				return {
					...machine,
					nextActionAtMs: nowMs + 60_000,
					updatedAtMs: nowMs,
				};
			}
			if (identity === "failed") {
				return {
					...machine,
					statusCode: "reconciliation-failed" as const,
					stableFailureCode: "identity-deletion-failed",
					attemptCount: machine.attemptCount + 1,
					nextActionAtMs: retryAt(nowMs, machine.attemptCount + 1),
					updatedAtMs: nowMs,
				};
			}
			return {
				...machine,
				accountDeletionRequestedAtMs: undefined,
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				updatedAtMs: nowMs,
			};
		}
		if (machine.environmentId !== undefined) {
			yield* (yield* RelayStore).deleteEnvironment(
				machine.environmentId,
				machine.accountId,
			);
		}
		if (!(yield* cancelSubscription(machine))) {
			return withBillingFailure(machine, nowMs);
		}
		if (machine.providerServerId !== undefined) {
			const killed = yield* provider
				.kill(machine.providerServerId)
				.pipe(Effect.result);
			if (killed._tag === "Failure") {
				return withProviderFailure(machine, nowMs, killed.failure);
			}
		}
		let identityDeletion = "deleted" as "deleted" | "deferred" | "failed";
		if (machine.accountDeletionRequestedAtMs !== undefined) {
			identityDeletion =
				yield* deleteAccountIdentityWhenInfrastructureIsClean(machine);
			if (identityDeletion === "failed") {
				return {
					...machine,
					state: "destroying" as const,
					statusCode: "reconciliation-failed" as const,
					stableFailureCode: "identity-deletion-failed",
					attemptCount: machine.attemptCount + 1,
					nextActionAtMs: retryAt(nowMs, machine.attemptCount + 1),
					updatedAtMs: nowMs,
				};
			}
		}
		return {
			...machine,
			state: "destroyed" as const,
			statusCode: "destroyed" as const,
			environmentId: undefined,
			providerServerId: undefined,
			enrollmentTokenHash: undefined,
			enrollmentExpiresAtMs: undefined,
			destroyedAtMs: nowMs,
			accountDeletionRequestedAtMs:
				identityDeletion === "deferred"
					? machine.accountDeletionRequestedAtMs
					: undefined,
			attemptCount: 0,
			nextActionAtMs:
				identityDeletion === "deferred"
					? nowMs + 60_000
					: Number.MAX_SAFE_INTEGER,
			updatedAtMs: nowMs,
		};
	},
);

export const reconcileSandboxMachine = Effect.fn("reconcileSandboxMachine")(
	function* (
		machine: MachinePersistenceRecord,
		nowMs: number,
		provider: SandboxProviderAdapter,
	) {
		switch (machine.desiredState) {
			case "ready":
				return yield* reconcileReadyTarget(machine, nowMs, provider);
			case "suspended":
				return yield* reconcileSuspendedTarget(machine, nowMs, provider);
			case "destroyed":
				return yield* reconcileDestroyedTarget(machine, nowMs, provider);
		}
	},
);
