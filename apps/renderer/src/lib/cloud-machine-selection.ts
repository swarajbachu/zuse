import type { MachineRecord } from "@zuse/contracts";

export const selectActiveCloudMachine = (
	machines: ReadonlyArray<MachineRecord>,
): MachineRecord | null =>
	machines.find((machine) => machine.state !== "destroyed") ?? null;
