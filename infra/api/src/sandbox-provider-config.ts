import {
	resolveSandboxProviderRuntimeFromModules,
	type SandboxProviderEnvironment,
	type SandboxProviderModule,
	type SandboxProviderRuntime,
} from "./sandbox-provider-module.ts";
import { E2bSandboxProviderModule } from "./sandbox-provider-modules/e2b.ts";

export {
	SandboxOfferConfiguration,
	SandboxProviderConfigurationError,
	type SandboxProviderModule,
} from "./sandbox-provider-module.ts";
export { E2bSandboxProviderModule } from "./sandbox-provider-modules/e2b.ts";

export const sandboxProviderModules: ReadonlyArray<SandboxProviderModule> = [
	E2bSandboxProviderModule,
];

export const resolveSandboxProviderRuntime = <
	Environment extends SandboxProviderEnvironment,
>(
	env: Environment,
	modules: ReadonlyArray<SandboxProviderModule> = sandboxProviderModules,
): SandboxProviderRuntime =>
	resolveSandboxProviderRuntimeFromModules(env, modules);
