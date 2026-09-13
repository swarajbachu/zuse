import type { MachinePersistenceRecord } from "./machine-store.ts";

export const requestMachineDestruction = (
	machine: MachinePersistenceRecord,
	nowMs: number,
	accountDeletionRequestedAtMs = machine.accountDeletionRequestedAtMs,
): MachinePersistenceRecord => ({
	...machine,
	state: "destroying",
	desiredState: "destroyed",
	statusCode: "destruction-queued",
	accountDeletionRequestedAtMs,
	nextActionAtMs: nowMs,
	updatedAtMs: nowMs,
});
