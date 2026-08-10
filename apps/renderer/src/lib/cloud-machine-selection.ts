import type { MachineOfferKind, MachineRecord } from "@zuse/contracts";

export const selectActiveCloudMachine = (
	machines: ReadonlyArray<MachineRecord>,
	kind: MachineOfferKind,
): MachineRecord | null =>
	machines.find(
		(machine) => machine.offer.kind === kind && machine.state !== "destroyed",
	) ?? null;
