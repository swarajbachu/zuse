import {
	type MachineProviderBootstrap,
	type MachineProviderEnvironment,
	type MachineProviderModule,
	type MachineProviderRuntime,
	resolveMachineProviderRuntimeFromModules,
} from "./machine-provider-module.ts";
import { HetznerMachineProviderModule } from "./machine-provider-modules/hetzner.ts";

export {
	MachineProviderConfigurationError,
	type MachineProviderModule,
	renderMachineCloudInit,
} from "./machine-provider-module.ts";
export { HetznerMachineProviderModule } from "./machine-provider-modules/hetzner.ts";

export const machineProviderModules: ReadonlyArray<MachineProviderModule> = [
	HetznerMachineProviderModule,
];

export const resolveMachineProviderRuntime = <
	Environment extends MachineProviderEnvironment,
>(
	env: Environment,
	bootstrap: MachineProviderBootstrap,
	modules: ReadonlyArray<MachineProviderModule> = machineProviderModules,
): MachineProviderRuntime =>
	resolveMachineProviderRuntimeFromModules(env, bootstrap, modules);
