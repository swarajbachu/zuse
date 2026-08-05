import { Context } from "effect";

export type MachineRuntimeRoleValue = "control-plane" | "cloud-environment";

export class MachineRuntimeRole extends Context.Service<
	MachineRuntimeRole,
	MachineRuntimeRoleValue
>()("zuse/MachineRuntimeRole") {}
