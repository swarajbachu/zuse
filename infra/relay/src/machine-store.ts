import type {
	DesiredMachineState,
	EntitlementKind,
	EntitlementStatus,
	MachineBootPhase,
	MachineState,
	MachineStatusCode,
} from "@zuse/contracts";
import { Context, Effect, Layer, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql";

export interface MachinePersistenceRecord {
	readonly machineId: string;
	readonly accountId: string;
	readonly offerId: string;
	readonly idempotencyKey: string;
	readonly environmentId?: string;
	readonly provider: string;
	readonly providerServerId?: string;
	readonly providerLabel: string;
	readonly label?: string;
	readonly state: MachineState;
	readonly desiredState: DesiredMachineState;
	readonly statusCode: MachineStatusCode;
	readonly bootPhase?: MachineBootPhase;
	readonly stableFailureCode?: string;
	readonly lastError?: string;
	readonly entitlementId: string;
	readonly enrollmentTokenHash?: string;
	readonly enrollmentExpiresAtMs?: number;
	readonly enrolledEnvironmentPublicKey?: string;
	readonly finalSnapshotId?: string;
	readonly finalSnapshotDeleteAtMs?: number;
	readonly paidThroughMs?: number;
	readonly recoveryDeadlineMs?: number;
	readonly accountDeletionRequestedAtMs?: number;
	readonly credentialCleanupRequestedAtMs?: number;
	readonly credentialCleanupDeadlineMs?: number;
	readonly credentialCleanupCompletedAtMs?: number;
	readonly finalSnapshotSkipped?: boolean;
	readonly nextActionAtMs: number;
	readonly attemptCount: number;
	readonly leaseOwner?: string;
	readonly leaseExpiresAtMs?: number;
	readonly revision: number;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly suspendedAtMs?: number;
	readonly destroyedAtMs?: number;
}

export interface EntitlementPersistenceRecord {
	readonly entitlementId: string;
	readonly accountId: string;
	readonly kind: EntitlementKind;
	readonly offerId?: string;
	readonly provider: string;
	readonly providerSubscriptionId?: string;
	readonly status: EntitlementStatus;
	readonly periodStartMs?: number;
	readonly paidThroughMs?: number;
	readonly endedAtMs?: number;
	readonly creditBalance?: number;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export type CreateMachineOutcome =
	| {
			readonly kind: "created" | "existing";
			readonly machine: MachinePersistenceRecord;
	  }
	| { readonly kind: "entitlement-required" }
	| { readonly kind: "machine-limit-reached" };

export interface BillingProvisioningInput {
	readonly machineId: string;
	readonly idempotencyKey: string;
	readonly provider: string;
	readonly providerLabel: string;
	readonly label?: string;
}

export interface ApplyBillingEventInput {
	readonly sameKindOfferIds: ReadonlyArray<string>;
	readonly event: {
		readonly provider: string;
		readonly eventId: string;
		readonly payload?: unknown;
		readonly nowMs: number;
	};
	readonly entitlement: EntitlementPersistenceRecord;
	readonly provisioning?: BillingProvisioningInput;
	readonly recoveryWindowMs: number;
}

export interface ApplyBillingEventOutcome {
	readonly duplicate: boolean;
	readonly machineCreated: boolean;
	readonly machine?: MachinePersistenceRecord;
}

export interface MachineStoreApi {
	readonly upsertEntitlement: (
		entitlement: EntitlementPersistenceRecord,
	) => Effect.Effect<void>;
	readonly listEntitlements: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<EntitlementPersistenceRecord>>;
	readonly createMachine: (input: {
		readonly accountId: string;
		readonly offerId: string;
		readonly sameKindOfferIds: ReadonlyArray<string>;
		readonly idempotencyKey: string;
		readonly machineId: string;
		readonly provider: string;
		readonly providerLabel: string;
		readonly label?: string;
		readonly nowMs: number;
	}) => Effect.Effect<CreateMachineOutcome>;
	readonly listMachines: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<MachinePersistenceRecord>>;
	readonly getMachine: (
		machineId: string,
	) => Effect.Effect<MachinePersistenceRecord | null>;
	readonly findMachineByEnvironmentId: (
		environmentId: string,
	) => Effect.Effect<MachinePersistenceRecord | null>;
	readonly saveMachine: (
		machine: MachinePersistenceRecord,
	) => Effect.Effect<void>;
	readonly compareAndSetMachine: (
		machine: MachinePersistenceRecord,
		expectedRevision: number,
	) => Effect.Effect<boolean>;
	readonly completeEnrollment: (
		machine: MachinePersistenceRecord,
		expectedEnrollmentTokenHash: string,
		expectedRevision: number,
	) => Effect.Effect<boolean>;
	readonly claimDueMachines: (input: {
		readonly nowMs: number;
		readonly owner: string;
		readonly leaseDurationMs: number;
		readonly limit: number;
	}) => Effect.Effect<ReadonlyArray<MachinePersistenceRecord>>;
	readonly claimMachine: (input: {
		readonly machineId: string;
		readonly nowMs: number;
		readonly owner: string;
		readonly leaseDurationMs: number;
	}) => Effect.Effect<MachinePersistenceRecord | null>;
	readonly saveReconciledMachine: (
		machine: MachinePersistenceRecord,
		owner: string,
		expectedRevision: number,
	) => Effect.Effect<boolean>;
	readonly findMachineByEnrollmentHash: (
		tokenHash: string,
	) => Effect.Effect<MachinePersistenceRecord | null>;
	readonly consumeBillingEvent: (input: {
		readonly provider: string;
		readonly eventId: string;
		readonly payload?: unknown;
		readonly nowMs: number;
	}) => Effect.Effect<boolean>;
	readonly applyBillingEvent: (
		input: ApplyBillingEventInput,
	) => Effect.Effect<ApplyBillingEventOutcome>;
}

export class MachineStore extends Context.Service<
	MachineStore,
	MachineStoreApi
>()("@zuse/relay/MachineStore") {}

interface MemoryState {
	readonly machines: Map<string, MachinePersistenceRecord>;
	readonly entitlements: Map<string, EntitlementPersistenceRecord>;
	readonly billingEvents: Set<string>;
}

const eligibleEntitlement = (
	state: MemoryState,
	accountId: string,
	offerId: string,
	nowMs: number,
): EntitlementPersistenceRecord | undefined => {
	const attached = new Set(
		[...state.machines.values()]
			.filter((machine) => machine.state !== "destroyed")
			.map((machine) => machine.entitlementId),
	);
	return [...state.entitlements.values()].find(
		(entitlement) =>
			entitlement.accountId === accountId &&
			entitlement.offerId === offerId &&
			(entitlement.status === "active" ||
				entitlement.status === "pending" ||
				entitlement.status === "grace") &&
			(entitlement.paidThroughMs === undefined ||
				entitlement.paidThroughMs > nowMs) &&
			!attached.has(entitlement.entitlementId),
	);
};

const machineForBillingEvent = (
	machine: MachinePersistenceRecord,
	entitlement: EntitlementPersistenceRecord,
	nowMs: number,
	recoveryWindowMs: number,
): MachinePersistenceRecord => {
	const paidThroughMs =
		entitlement.paidThroughMs ?? machine.paidThroughMs ?? nowMs;
	return entitlement.status === "ended"
		? {
				...machine,
				desiredState: "suspended",
				statusCode: "cancellation-scheduled",
				paidThroughMs,
				recoveryDeadlineMs: paidThroughMs + recoveryWindowMs,
				nextActionAtMs: Math.max(nowMs, paidThroughMs),
				updatedAtMs: nowMs,
			}
		: {
				...machine,
				paidThroughMs,
				nextActionAtMs:
					machine.desiredState === "ready"
						? Math.min(machine.nextActionAtMs, paidThroughMs)
						: machine.nextActionAtMs,
				updatedAtMs: nowMs,
			};
};

const newMachineForBillingEvent = (
	input: ApplyBillingEventInput,
	provisioning: BillingProvisioningInput,
): MachinePersistenceRecord => ({
	machineId: provisioning.machineId,
	accountId: input.entitlement.accountId,
	offerId: input.entitlement.offerId as string,
	idempotencyKey: provisioning.idempotencyKey,
	provider: provisioning.provider,
	providerLabel: provisioning.providerLabel,
	label: provisioning.label,
	state: "creating",
	desiredState: "ready",
	statusCode: "creation-queued",
	entitlementId: input.entitlement.entitlementId,
	paidThroughMs: input.entitlement.paidThroughMs,
	nextActionAtMs: input.event.nowMs,
	attemptCount: 0,
	revision: 0,
	createdAtMs: input.event.nowMs,
	updatedAtMs: input.event.nowMs,
});

const renewedMachineForBillingEvent = (
	machine: MachinePersistenceRecord,
	entitlement: EntitlementPersistenceRecord,
	nowMs: number,
): MachinePersistenceRecord => ({
	...machine,
	entitlementId: entitlement.entitlementId,
	state: "resuming",
	desiredState: "ready",
	statusCode: "resume-queued",
	paidThroughMs: entitlement.paidThroughMs,
	recoveryDeadlineMs: undefined,
	nextActionAtMs: nowMs,
	attemptCount: 0,
	stableFailureCode: undefined,
	lastError: undefined,
	updatedAtMs: nowMs,
});

export const MachineStoreMemory = Layer.effect(
	MachineStore,
	Effect.gen(function* () {
		const state = yield* Ref.make<MemoryState>({
			machines: new Map(),
			entitlements: new Map(),
			billingEvents: new Set(),
		});

		return MachineStore.of({
			upsertEntitlement: (entitlement) =>
				Ref.update(state, (current) => ({
					...current,
					entitlements: new Map(current.entitlements).set(
						entitlement.entitlementId,
						entitlement,
					),
				})),
			listEntitlements: (accountId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.entitlements.values()].filter(
							(entitlement) => entitlement.accountId === accountId,
						),
					),
				),
			createMachine: (input) =>
				Ref.modify(state, (current): [CreateMachineOutcome, MemoryState] => {
					const existing = [...current.machines.values()].find(
						(machine) =>
							machine.accountId === input.accountId &&
							machine.idempotencyKey === input.idempotencyKey,
					);
					if (existing !== undefined) {
						return [{ kind: "existing", machine: existing }, current];
					}
					const hasActiveMachine = [...current.machines.values()].some(
						(machine) =>
							machine.accountId === input.accountId &&
							input.sameKindOfferIds.includes(machine.offerId) &&
							machine.state !== "destroyed",
					);
					if (hasActiveMachine) {
						return [{ kind: "machine-limit-reached" }, current];
					}
					const entitlement = eligibleEntitlement(
						current,
						input.accountId,
						input.offerId,
						input.nowMs,
					);
					if (entitlement === undefined) {
						return [{ kind: "entitlement-required" }, current];
					}
					const machine: MachinePersistenceRecord = {
						machineId: input.machineId,
						accountId: input.accountId,
						offerId: input.offerId,
						idempotencyKey: input.idempotencyKey,
						provider: input.provider,
						providerLabel: input.providerLabel,
						label: input.label,
						state: "creating",
						desiredState: "ready",
						statusCode: "creation-queued",
						entitlementId: entitlement.entitlementId,
						paidThroughMs: entitlement.paidThroughMs,
						nextActionAtMs: input.nowMs,
						attemptCount: 0,
						revision: 0,
						createdAtMs: input.nowMs,
						updatedAtMs: input.nowMs,
					};
					return [
						{ kind: "created", machine },
						{
							...current,
							machines: new Map(current.machines).set(
								machine.machineId,
								machine,
							),
						},
					];
				}),
			listMachines: (accountId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.machines.values()]
							.filter((machine) => machine.accountId === accountId)
							.sort((left, right) => right.createdAtMs - left.createdAtMs),
					),
				),
			getMachine: (machineId) =>
				Ref.get(state).pipe(
					Effect.map((current) => current.machines.get(machineId) ?? null),
				),
			findMachineByEnvironmentId: (environmentId) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) =>
							[...current.machines.values()].find(
								(machine) => machine.environmentId === environmentId,
							) ?? null,
					),
				),
			saveMachine: (machine) =>
				Ref.update(state, (current) => {
					const stored = current.machines.get(machine.machineId);
					return {
						...current,
						machines: new Map(current.machines).set(machine.machineId, {
							...machine,
							revision: (stored?.revision ?? machine.revision) + 1,
						}),
					};
				}),
			compareAndSetMachine: (machine, expectedRevision) =>
				Ref.modify(state, (current) => {
					const stored = current.machines.get(machine.machineId);
					if (stored?.revision !== expectedRevision) return [false, current];
					return [
						true,
						{
							...current,
							machines: new Map(current.machines).set(machine.machineId, {
								...machine,
								revision: expectedRevision + 1,
							}),
						},
					];
				}),
			completeEnrollment: (
				machine,
				expectedEnrollmentTokenHash,
				expectedRevision,
			) =>
				Ref.modify(state, (current) => {
					const stored = current.machines.get(machine.machineId);
					if (
						stored === undefined ||
						stored.revision !== expectedRevision ||
						stored.enrollmentTokenHash !== expectedEnrollmentTokenHash ||
						stored.desiredState === "destroyed" ||
						stored.state === "destroying" ||
						stored.state === "destroyed"
					) {
						return [false, current];
					}
					return [
						true,
						{
							...current,
							machines: new Map(current.machines).set(machine.machineId, {
								...machine,
								revision: expectedRevision + 1,
							}),
						},
					];
				}),
			claimDueMachines: (input) =>
				Ref.modify(state, (current) => {
					const due = [...current.machines.values()]
						.filter(
							(machine) =>
								machine.nextActionAtMs <= input.nowMs &&
								(machine.state !== "destroyed" ||
									(machine.finalSnapshotId !== undefined &&
										machine.finalSnapshotDeleteAtMs !== undefined)) &&
								(machine.leaseExpiresAtMs === undefined ||
									machine.leaseExpiresAtMs <= input.nowMs),
						)
						.sort((left, right) => left.nextActionAtMs - right.nextActionAtMs)
						.slice(0, input.limit)
						.map((machine) => ({
							...machine,
							leaseOwner: input.owner,
							leaseExpiresAtMs: input.nowMs + input.leaseDurationMs,
							revision: machine.revision + 1,
						}));
					const machines = new Map(current.machines);
					for (const machine of due) machines.set(machine.machineId, machine);
					return [due, { ...current, machines }];
				}),
			claimMachine: (input) =>
				Ref.modify(state, (current) => {
					const machine = current.machines.get(input.machineId);
					if (
						machine === undefined ||
						machine.nextActionAtMs > input.nowMs ||
						(machine.leaseExpiresAtMs !== undefined &&
							machine.leaseExpiresAtMs > input.nowMs)
					) {
						return [null, current];
					}
					const claimed: MachinePersistenceRecord = {
						...machine,
						leaseOwner: input.owner,
						leaseExpiresAtMs: input.nowMs + input.leaseDurationMs,
						revision: machine.revision + 1,
					};
					return [
						claimed,
						{
							...current,
							machines: new Map(current.machines).set(
								claimed.machineId,
								claimed,
							),
						},
					];
				}),
			saveReconciledMachine: (machine, owner, expectedRevision) =>
				Ref.modify(state, (current) => {
					const stored = current.machines.get(machine.machineId);
					if (
						stored?.leaseOwner !== owner ||
						stored.revision !== expectedRevision
					) {
						return [false, current];
					}
					const next = {
						...machine,
						leaseOwner: undefined,
						leaseExpiresAtMs: undefined,
						revision: expectedRevision + 1,
					};
					return [
						true,
						{
							...current,
							machines: new Map(current.machines).set(machine.machineId, next),
						},
					];
				}),
			findMachineByEnrollmentHash: (tokenHash) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) =>
							[...current.machines.values()].find(
								(machine) => machine.enrollmentTokenHash === tokenHash,
							) ?? null,
					),
				),
			consumeBillingEvent: (input) =>
				Ref.modify(state, (current) => {
					const key = `${input.provider}|${input.eventId}`;
					if (current.billingEvents.has(key)) return [false, current];
					return [
						true,
						{
							...current,
							billingEvents: new Set(current.billingEvents).add(key),
						},
					];
				}),
			applyBillingEvent: (input) =>
				Ref.modify(
					state,
					(current): [ApplyBillingEventOutcome, MemoryState] => {
						const eventKey = `${input.event.provider}|${input.event.eventId}`;
						if (current.billingEvents.has(eventKey)) {
							const machine = [...current.machines.values()].find(
								(item) =>
									item.entitlementId === input.entitlement.entitlementId &&
									item.state !== "destroyed",
							);
							return [
								{ duplicate: true, machineCreated: false, machine },
								current,
							];
						}

						const entitlements = new Map(current.entitlements).set(
							input.entitlement.entitlementId,
							input.entitlement,
						);
						const machines = new Map(current.machines);
						let machine = [...machines.values()].find(
							(item) =>
								item.entitlementId === input.entitlement.entitlementId &&
								item.state !== "destroyed",
						);
						let machineCreated = false;
						if (
							machine === undefined &&
							input.entitlement.status === "active" &&
							input.entitlement.offerId !== undefined
						) {
							const recoverable = [...machines.values()].find(
								(item) =>
									item.accountId === input.entitlement.accountId &&
									input.sameKindOfferIds.includes(item.offerId) &&
									item.state === "suspended" &&
									(item.recoveryDeadlineMs ?? 0) > input.event.nowMs,
							);
							if (recoverable !== undefined) {
								machine = renewedMachineForBillingEvent(
									recoverable,
									input.entitlement,
									input.event.nowMs,
								);
							}
						}

						if (
							machine === undefined &&
							input.entitlement.status === "active" &&
							input.entitlement.offerId !== undefined &&
							input.provisioning !== undefined
						) {
							const accountHasMachine = [...machines.values()].some(
								(item) =>
									item.accountId === input.entitlement.accountId &&
									input.sameKindOfferIds.includes(item.offerId) &&
									item.state !== "destroyed",
							);
							if (!accountHasMachine) {
								machine = newMachineForBillingEvent(input, input.provisioning);
								machines.set(machine.machineId, machine);
								machineCreated = true;
							}
						}

						if (machine !== undefined && !machineCreated) {
							machine = {
								...machineForBillingEvent(
									machine,
									input.entitlement,
									input.event.nowMs,
									input.recoveryWindowMs,
								),
								revision: machine.revision + 1,
							};
							machines.set(machine.machineId, machine);
						}

						return [
							{
								duplicate: false,
								machineCreated,
								machine,
							},
							{
								machines,
								entitlements,
								billingEvents: new Set(current.billingEvents).add(eventKey),
							},
						];
					},
				),
		});
	}),
);

interface MachineRow {
	readonly machine_id: string;
	readonly account_id: string;
	readonly offer_id: string;
	readonly idempotency_key: string;
	readonly environment_id: string | null;
	readonly provider: string;
	readonly provider_server_id: string | null;
	readonly provider_label: string;
	readonly label: string | null;
	readonly state: MachineState;
	readonly desired_state: DesiredMachineState;
	readonly status_code: MachineStatusCode;
	readonly boot_phase: MachineBootPhase | null;
	readonly stable_failure_code: string | null;
	readonly last_error: string | null;
	readonly entitlement_id: string;
	readonly enrollment_token_hash: string | null;
	readonly enrollment_expires_at: number | null;
	readonly enrolled_environment_public_key: string | null;
	readonly final_snapshot_id: string | null;
	readonly final_snapshot_delete_at: number | null;
	readonly paid_through: number | null;
	readonly recovery_deadline: number | null;
	readonly account_deletion_requested_at: number | null;
	readonly credential_cleanup_requested_at: number | null;
	readonly credential_cleanup_deadline: number | null;
	readonly credential_cleanup_completed_at: number | null;
	readonly final_snapshot_skipped: boolean;
	readonly next_action_at: number;
	readonly attempt_count: number;
	readonly lease_owner: string | null;
	readonly lease_expires_at: number | null;
	readonly revision: number;
	readonly created_at: number;
	readonly updated_at: number;
	readonly suspended_at: number | null;
	readonly destroyed_at: number | null;
}

interface EntitlementRow {
	readonly entitlement_id: string;
	readonly account_id: string;
	readonly kind: EntitlementKind;
	readonly offer_id: string | null;
	readonly provider: string;
	readonly provider_subscription_id: string | null;
	readonly status: EntitlementStatus;
	readonly period_start: number | null;
	readonly paid_through: number | null;
	readonly ended_at: number | null;
	readonly credit_balance: number | null;
	readonly created_at: number;
	readonly updated_at: number;
}

const optionalNumber = (value: number | null): number | undefined =>
	value === null ? undefined : Number(value);

const toMachine = (row: MachineRow): MachinePersistenceRecord => ({
	machineId: row.machine_id,
	accountId: row.account_id,
	offerId: row.offer_id,
	idempotencyKey: row.idempotency_key,
	environmentId: row.environment_id ?? undefined,
	provider: row.provider,
	providerServerId: row.provider_server_id ?? undefined,
	providerLabel: row.provider_label,
	label: row.label ?? undefined,
	state: row.state,
	desiredState: row.desired_state,
	statusCode: row.status_code,
	bootPhase: row.boot_phase ?? undefined,
	stableFailureCode: row.stable_failure_code ?? undefined,
	lastError: row.last_error ?? undefined,
	entitlementId: row.entitlement_id,
	enrollmentTokenHash: row.enrollment_token_hash ?? undefined,
	enrollmentExpiresAtMs: optionalNumber(row.enrollment_expires_at),
	enrolledEnvironmentPublicKey:
		row.enrolled_environment_public_key ?? undefined,
	finalSnapshotId: row.final_snapshot_id ?? undefined,
	finalSnapshotDeleteAtMs: optionalNumber(row.final_snapshot_delete_at),
	paidThroughMs: optionalNumber(row.paid_through),
	recoveryDeadlineMs: optionalNumber(row.recovery_deadline),
	accountDeletionRequestedAtMs: optionalNumber(
		row.account_deletion_requested_at,
	),
	credentialCleanupRequestedAtMs: optionalNumber(
		row.credential_cleanup_requested_at,
	),
	credentialCleanupDeadlineMs: optionalNumber(row.credential_cleanup_deadline),
	credentialCleanupCompletedAtMs: optionalNumber(
		row.credential_cleanup_completed_at,
	),
	finalSnapshotSkipped: row.final_snapshot_skipped,
	nextActionAtMs: Number(row.next_action_at),
	attemptCount: Number(row.attempt_count),
	leaseOwner: row.lease_owner ?? undefined,
	leaseExpiresAtMs: optionalNumber(row.lease_expires_at),
	revision: Number(row.revision),
	createdAtMs: Number(row.created_at),
	updatedAtMs: Number(row.updated_at),
	suspendedAtMs: optionalNumber(row.suspended_at),
	destroyedAtMs: optionalNumber(row.destroyed_at),
});

const toEntitlement = (row: EntitlementRow): EntitlementPersistenceRecord => ({
	entitlementId: row.entitlement_id,
	accountId: row.account_id,
	kind: row.kind,
	offerId: row.offer_id ?? undefined,
	provider: row.provider,
	providerSubscriptionId: row.provider_subscription_id ?? undefined,
	status: row.status,
	periodStartMs: optionalNumber(row.period_start),
	paidThroughMs: optionalNumber(row.paid_through),
	endedAtMs: optionalNumber(row.ended_at),
	creditBalance: optionalNumber(row.credit_balance),
	createdAtMs: Number(row.created_at),
	updatedAtMs: Number(row.updated_at),
});

export const MachineStorePg: Layer.Layer<
	MachineStore,
	never,
	SqlClient.SqlClient
> = Layer.effect(
	MachineStore,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const orDie = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
			effect.pipe(Effect.orDie);

		const save = (
			machine: MachinePersistenceRecord,
			leaseOwner?: string,
			releaseLease = false,
			expectedEnrollmentTokenHash?: string,
			expectedRevision?: number,
		): Effect.Effect<boolean> =>
			orDie(
				sql<{ readonly machine_id: string }>`
					UPDATE relay_machines SET
						environment_id = ${machine.environmentId ?? null},
						provider_server_id = ${machine.providerServerId ?? null},
						label = ${machine.label ?? null},
						state = ${machine.state},
						desired_state = ${machine.desiredState},
						status_code = ${machine.statusCode},
						boot_phase = ${machine.bootPhase ?? null},
						stable_failure_code = ${machine.stableFailureCode ?? null},
						last_error = ${machine.lastError ?? null},
						enrollment_token_hash = ${machine.enrollmentTokenHash ?? null},
						enrollment_expires_at = ${machine.enrollmentExpiresAtMs ?? null},
						enrolled_environment_public_key = ${machine.enrolledEnvironmentPublicKey ?? null},
						final_snapshot_id = ${machine.finalSnapshotId ?? null},
						final_snapshot_delete_at = ${machine.finalSnapshotDeleteAtMs ?? null},
						paid_through = ${machine.paidThroughMs ?? null},
						recovery_deadline = ${machine.recoveryDeadlineMs ?? null},
						account_deletion_requested_at = ${machine.accountDeletionRequestedAtMs ?? null},
						credential_cleanup_requested_at = ${machine.credentialCleanupRequestedAtMs ?? null},
						credential_cleanup_deadline = ${machine.credentialCleanupDeadlineMs ?? null},
						credential_cleanup_completed_at = ${machine.credentialCleanupCompletedAtMs ?? null},
						final_snapshot_skipped = ${machine.finalSnapshotSkipped ?? false},
						next_action_at = ${machine.nextActionAtMs},
						attempt_count = ${machine.attemptCount},
						lease_owner = ${releaseLease ? null : (machine.leaseOwner ?? null)},
						lease_expires_at = ${releaseLease ? null : (machine.leaseExpiresAtMs ?? null)},
						revision = revision + 1,
						updated_at = ${machine.updatedAtMs},
						suspended_at = ${machine.suspendedAtMs ?? null},
						destroyed_at = ${machine.destroyedAtMs ?? null}
					WHERE machine_id = ${machine.machineId}
						AND (${leaseOwner ?? null}::text IS NULL OR lease_owner = ${leaseOwner ?? null})
						AND (${expectedRevision ?? null}::bigint IS NULL OR revision = ${expectedRevision ?? null})
						AND (
							${expectedEnrollmentTokenHash ?? null}::text IS NULL
							OR (
								enrollment_token_hash = ${expectedEnrollmentTokenHash ?? null}
								AND desired_state <> 'destroyed'
								AND state NOT IN ('destroying', 'destroyed')
							)
						)
					RETURNING machine_id
				`.pipe(Effect.map((rows) => rows.length === 1)),
			);

		return MachineStore.of({
			upsertEntitlement: (entitlement) =>
				orDie(
					sql`
						INSERT INTO relay_entitlements (
							entitlement_id, account_id, kind, offer_id, provider,
							provider_subscription_id, status, period_start, paid_through, ended_at,
							credit_balance, created_at, updated_at
						) VALUES (
							${entitlement.entitlementId}, ${entitlement.accountId},
							${entitlement.kind}, ${entitlement.offerId ?? null},
							${entitlement.provider},
							${entitlement.providerSubscriptionId ?? null},
							${entitlement.status}, ${entitlement.periodStartMs ?? null}, ${entitlement.paidThroughMs ?? null},
							${entitlement.endedAtMs ?? null},
							${entitlement.creditBalance ?? null},
							${entitlement.createdAtMs}, ${entitlement.updatedAtMs}
						)
						ON CONFLICT (entitlement_id) DO UPDATE SET
							kind = EXCLUDED.kind,
							offer_id = EXCLUDED.offer_id,
							status = EXCLUDED.status,
							period_start = EXCLUDED.period_start,
							paid_through = EXCLUDED.paid_through,
							ended_at = EXCLUDED.ended_at,
							credit_balance = EXCLUDED.credit_balance,
							updated_at = EXCLUDED.updated_at
					`.pipe(Effect.asVoid),
				),
			listEntitlements: (accountId) =>
				orDie(
					sql<EntitlementRow>`
						SELECT * FROM relay_entitlements
						WHERE account_id = ${accountId}
						ORDER BY created_at DESC
					`.pipe(Effect.map((rows) => rows.map(toEntitlement))),
				),
			createMachine: (input) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtext(${input.accountId}))`;
						const existing = yield* sql<MachineRow>`
							SELECT * FROM relay_machines
							WHERE account_id = ${input.accountId}
								AND idempotency_key = ${input.idempotencyKey}
						`;
						if (existing[0] !== undefined) {
							return {
								kind: "existing",
								machine: toMachine(existing[0]),
							} satisfies CreateMachineOutcome;
						}
						const active = yield* sql<{ readonly machine_id: string }>`
							SELECT machine_id FROM relay_machines
							WHERE account_id = ${input.accountId}
								AND offer_id IN ${sql.in(input.sameKindOfferIds)}
								AND state <> 'destroyed'
							LIMIT 1
						`;
						if (active.length > 0) {
							return {
								kind: "machine-limit-reached",
							} satisfies CreateMachineOutcome;
						}
						const entitlements = yield* sql<EntitlementRow>`
							SELECT entitlement.* FROM relay_entitlements entitlement
							WHERE entitlement.account_id = ${input.accountId}
								AND entitlement.offer_id = ${input.offerId}
								AND entitlement.status IN ('pending', 'active', 'grace')
								AND (
									entitlement.paid_through IS NULL
									OR entitlement.paid_through > ${input.nowMs}
								)
								AND NOT EXISTS (
									SELECT 1 FROM relay_machines machine
									WHERE machine.entitlement_id = entitlement.entitlement_id
										AND machine.state <> 'destroyed'
								)
							ORDER BY entitlement.created_at ASC
							LIMIT 1
							FOR UPDATE
						`;
						const entitlement = entitlements[0];
						if (entitlement === undefined) {
							return {
								kind: "entitlement-required",
							} satisfies CreateMachineOutcome;
						}
						const inserted = yield* sql<MachineRow>`
							INSERT INTO relay_machines (
								machine_id, account_id, offer_id, idempotency_key,
								provider, provider_label, label, state, desired_state,
								status_code, entitlement_id, paid_through, next_action_at,
								attempt_count, created_at, updated_at
							) VALUES (
								${input.machineId}, ${input.accountId}, ${input.offerId},
								${input.idempotencyKey}, ${input.provider},
								${input.providerLabel}, ${input.label ?? null}, 'creating',
								'ready', 'creation-queued',
								${entitlement.entitlement_id},
								${entitlement.paid_through}, ${input.nowMs}, 0,
								${input.nowMs}, ${input.nowMs}
							)
							RETURNING *
						`;
						return {
							kind: "created",
							machine: toMachine(inserted[0] as MachineRow),
						} satisfies CreateMachineOutcome;
					}).pipe(sql.withTransaction),
				),
			listMachines: (accountId) =>
				orDie(
					sql<MachineRow>`
						SELECT * FROM relay_machines
						WHERE account_id = ${accountId}
						ORDER BY created_at DESC
					`.pipe(Effect.map((rows) => rows.map(toMachine))),
				),
			getMachine: (machineId) =>
				orDie(
					sql<MachineRow>`
						SELECT * FROM relay_machines WHERE machine_id = ${machineId}
					`.pipe(Effect.map((rows) => (rows[0] ? toMachine(rows[0]) : null))),
				),
			findMachineByEnvironmentId: (environmentId) =>
				orDie(
					sql<MachineRow>`
						SELECT * FROM relay_machines WHERE environment_id = ${environmentId}
					`.pipe(Effect.map((rows) => (rows[0] ? toMachine(rows[0]) : null))),
				),
			saveMachine: (machine) => save(machine).pipe(Effect.asVoid),
			compareAndSetMachine: (machine, expectedRevision) =>
				save(machine, undefined, false, undefined, expectedRevision),
			completeEnrollment: (
				machine,
				expectedEnrollmentTokenHash,
				expectedRevision,
			) =>
				save(
					machine,
					undefined,
					false,
					expectedEnrollmentTokenHash,
					expectedRevision,
				),
			claimDueMachines: (input) =>
				orDie(
					sql<MachineRow>`
						WITH due AS (
							SELECT machine_id FROM relay_machines
							WHERE next_action_at <= ${input.nowMs}
								AND (
									state <> 'destroyed'
									OR (
										final_snapshot_id IS NOT NULL
										AND final_snapshot_delete_at IS NOT NULL
									)
								)
								AND (lease_expires_at IS NULL OR lease_expires_at <= ${input.nowMs})
							ORDER BY next_action_at ASC
							LIMIT ${input.limit}
							FOR UPDATE SKIP LOCKED
						)
						UPDATE relay_machines machine SET
							lease_owner = ${input.owner},
							lease_expires_at = ${input.nowMs + input.leaseDurationMs},
							revision = revision + 1
						FROM due
						WHERE machine.machine_id = due.machine_id
						RETURNING machine.*
					`.pipe(
						sql.withTransaction,
						Effect.map((rows) => rows.map(toMachine)),
					),
				),
			claimMachine: (input) =>
				orDie(
					sql<MachineRow>`
						UPDATE relay_machines SET
							lease_owner = ${input.owner},
							lease_expires_at = ${input.nowMs + input.leaseDurationMs},
							revision = revision + 1
						WHERE machine_id = ${input.machineId}
							AND next_action_at <= ${input.nowMs}
							AND (lease_expires_at IS NULL OR lease_expires_at <= ${input.nowMs})
						RETURNING *
					`.pipe(Effect.map((rows) => (rows[0] ? toMachine(rows[0]) : null))),
				),
			saveReconciledMachine: (machine, owner, expectedRevision) =>
				save(machine, owner, true, undefined, expectedRevision),
			findMachineByEnrollmentHash: (tokenHash) =>
				orDie(
					sql<MachineRow>`
						SELECT * FROM relay_machines
						WHERE enrollment_token_hash = ${tokenHash}
					`.pipe(Effect.map((rows) => (rows[0] ? toMachine(rows[0]) : null))),
				),
			consumeBillingEvent: (input) =>
				orDie(
					sql<{ readonly event_id: string }>`
						INSERT INTO relay_billing_events (
							provider, event_id, payload, received_at, processed_at
						) VALUES (
							${input.provider}, ${input.eventId},
							${input.payload === undefined ? null : JSON.stringify(input.payload)},
							${input.nowMs}, ${input.nowMs}
						)
						ON CONFLICT (provider, event_id) DO NOTHING
						RETURNING event_id
					`.pipe(Effect.map((rows) => rows.length === 1)),
				),
			applyBillingEvent: (input) =>
				orDie(
					Effect.gen(function* () {
						const consumed = yield* sql<{ readonly event_id: string }>`
							INSERT INTO relay_billing_events (
								provider, event_id, payload, received_at, processed_at
							) VALUES (
								${input.event.provider}, ${input.event.eventId},
								${
									input.event.payload === undefined
										? null
										: JSON.stringify(input.event.payload)
								},
								${input.event.nowMs}, ${input.event.nowMs}
							)
							ON CONFLICT (provider, event_id) DO NOTHING
							RETURNING event_id
						`;
						if (consumed.length === 0) {
							const existing = yield* sql<MachineRow>`
								SELECT * FROM relay_machines
								WHERE entitlement_id = ${input.entitlement.entitlementId}
									AND state <> 'destroyed'
								LIMIT 1
							`;
							return {
								duplicate: true,
								machineCreated: false,
								machine: existing[0] ? toMachine(existing[0]) : undefined,
							} satisfies ApplyBillingEventOutcome;
						}

						yield* sql`
							SELECT pg_advisory_xact_lock(
								hashtext(${input.entitlement.accountId})
							)
						`;
						yield* sql`
							INSERT INTO relay_entitlements (
								entitlement_id, account_id, kind, offer_id, provider,
								provider_subscription_id, status, period_start, paid_through, ended_at,
								credit_balance, created_at, updated_at
							) VALUES (
								${input.entitlement.entitlementId},
								${input.entitlement.accountId},
								${input.entitlement.kind},
								${input.entitlement.offerId ?? null},
								${input.entitlement.provider},
								${input.entitlement.providerSubscriptionId ?? null},
								${input.entitlement.status},
								${input.entitlement.periodStartMs ?? null},
								${input.entitlement.paidThroughMs ?? null},
								${input.entitlement.endedAtMs ?? null},
								${input.entitlement.creditBalance ?? null},
								${input.entitlement.createdAtMs},
								${input.entitlement.updatedAtMs}
							)
							ON CONFLICT (entitlement_id) DO UPDATE SET
								kind = EXCLUDED.kind,
								offer_id = EXCLUDED.offer_id,
								status = EXCLUDED.status,
								period_start = EXCLUDED.period_start,
								paid_through = EXCLUDED.paid_through,
								ended_at = EXCLUDED.ended_at,
								credit_balance = EXCLUDED.credit_balance,
								updated_at = EXCLUDED.updated_at
						`;

						const attachedRows = yield* sql<MachineRow>`
							SELECT * FROM relay_machines
							WHERE entitlement_id = ${input.entitlement.entitlementId}
								AND state <> 'destroyed'
							LIMIT 1
							FOR UPDATE
						`;
						let machine = attachedRows[0]
							? toMachine(attachedRows[0])
							: undefined;
						let machineCreated = false;

						if (
							machine === undefined &&
							input.entitlement.status === "active" &&
							input.entitlement.offerId !== undefined
						) {
							const recoverableRows = yield* sql<MachineRow>`
								SELECT * FROM relay_machines
								WHERE account_id = ${input.entitlement.accountId}
									AND offer_id IN ${sql.in(input.sameKindOfferIds)}
									AND state = 'suspended'
									AND recovery_deadline > ${input.event.nowMs}
								LIMIT 1
								FOR UPDATE
							`;
							if (recoverableRows[0] !== undefined) {
								machine = renewedMachineForBillingEvent(
									toMachine(recoverableRows[0]),
									input.entitlement,
									input.event.nowMs,
								);
							}
						}

						if (
							machine === undefined &&
							input.entitlement.status === "active" &&
							input.entitlement.offerId !== undefined &&
							input.provisioning !== undefined
						) {
							const activeRows = yield* sql<{ readonly machine_id: string }>`
								SELECT machine_id FROM relay_machines
								WHERE account_id = ${input.entitlement.accountId}
									AND offer_id IN ${sql.in(input.sameKindOfferIds)}
									AND state <> 'destroyed'
								LIMIT 1
								FOR UPDATE
							`;
							if (activeRows.length === 0) {
								const inserted = yield* sql<MachineRow>`
									INSERT INTO relay_machines (
										machine_id, account_id, offer_id, idempotency_key,
										provider, provider_label, label, state, desired_state,
										status_code, entitlement_id, paid_through, next_action_at,
										attempt_count, created_at, updated_at
									) VALUES (
										${input.provisioning.machineId},
										${input.entitlement.accountId},
										${input.entitlement.offerId},
										${input.provisioning.idempotencyKey},
										${input.provisioning.provider},
										${input.provisioning.providerLabel},
										${input.provisioning.label ?? null},
										'creating', 'ready', 'creation-queued',
										${input.entitlement.entitlementId},
										${input.entitlement.paidThroughMs ?? null},
										${input.event.nowMs}, 0,
										${input.event.nowMs}, ${input.event.nowMs}
									)
									RETURNING *
								`;
								machine = toMachine(inserted[0] as MachineRow);
								machineCreated = true;
							}
						}

						if (machine !== undefined && !machineCreated) {
							const updated = machineForBillingEvent(
								machine,
								input.entitlement,
								input.event.nowMs,
								input.recoveryWindowMs,
							);
							const saved = yield* save(
								updated,
								undefined,
								false,
								undefined,
								machine.revision,
							);
							if (!saved) {
								return yield* Effect.die(
									new Error("billing machine update lost its row lock"),
								);
							}
							machine = {
								...updated,
								revision: machine.revision + 1,
							};
						}

						return {
							duplicate: false,
							machineCreated,
							machine,
						} satisfies ApplyBillingEventOutcome;
					}).pipe(sql.withTransaction),
				),
		});
	}),
);
