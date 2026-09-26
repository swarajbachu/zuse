import {
	resolveSandboxProviderRuntimeFromModules,
	type SandboxProviderEnvironment,
	type SandboxProviderModule,
	type SandboxProviderRuntime,
} from "./sandbox-provider-module.ts";
import { BoxSandboxProviderModule } from "./sandbox-provider-modules/box.ts";
import { BoxdSandboxProviderModule } from "./sandbox-provider-modules/boxd.ts";
import { E2bSandboxProviderModule } from "./sandbox-provider-modules/e2b.ts";

export {
	SandboxOfferConfiguration,
	SandboxProviderConfigurationError,
	type SandboxProviderModule,
} from "./sandbox-provider-module.ts";
export { BoxSandboxProviderModule } from "./sandbox-provider-modules/box.ts";
export { BoxdSandboxProviderModule } from "./sandbox-provider-modules/boxd.ts";
export { E2bSandboxProviderModule } from "./sandbox-provider-modules/e2b.ts";

export const sandboxProviderModules: ReadonlyArray<SandboxProviderModule> = [
	BoxSandboxProviderModule,
	E2bSandboxProviderModule,
	BoxdSandboxProviderModule,
];

export const resolveSandboxProviderRuntime = <
	Environment extends SandboxProviderEnvironment,
>(
	env: Environment,
	modules: ReadonlyArray<SandboxProviderModule> = sandboxProviderModules,
): SandboxProviderRuntime =>
	resolveSandboxProviderRuntimeFromModules(env, modules);
