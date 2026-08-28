import { Effect } from "effect";
import { AccountIdentity } from "./account-identity.ts";
import type { MachinePersistenceRecord } from "./machine-store.ts";
import { MachineStore } from "./machine-store.ts";

export const deleteAccountIdentityWhenInfrastructureIsClean = Effect.fn(
	"deleteAccountIdentityWhenInfrastructureIsClean",
)(function* (machine: MachinePersistenceRecord) {
	const machines = yield* (yield* MachineStore).listMachines(machine.accountId);
	const anotherMachineIsCleaning = machines.some(
		(other) =>
			other.machineId !== machine.machineId && other.state !== "destroyed",
	);
	if (anotherMachineIsCleaning) return "deferred" as const;
	const entitlements = yield* (yield* MachineStore).listEntitlements(
		machine.accountId,
	);
	if (
		entitlements.some(
			(entitlement) =>
				entitlement.kind === "cloud-workspace" &&
				(entitlement.status === "active" || entitlement.status === "grace"),
		)
	)
		return "deferred" as const;
	const deleted = yield* (yield* AccountIdentity)
		.deleteUser(machine.accountId)
		.pipe(Effect.result);
	return deleted._tag === "Success"
		? ("deleted" as const)
		: ("failed" as const);
});
