import {
	E2B_PROVIDER_ID,
	makeE2bSandboxProvider,
} from "@zuse/sandbox-providers/e2b";
import { Redacted, Schema } from "effect";
import type {
	SandboxProviderEnvironment,
	SandboxProviderModule,
} from "../sandbox-provider-module.ts";
import {
	ConfiguredString,
	decodeProviderEnvironment,
	HttpsUrl,
} from "./environment.ts";

const ActivationEnvironment = Schema.Struct({
	E2B_ADAPTER_ENABLED: Schema.optionalKey(Schema.Literals(["true", "false"])),
});
const PositiveIntegerFromString = Schema.NumberFromString.check(
	Schema.isInt(),
	Schema.isGreaterThan(0),
);
const E2bEnvironment = Schema.Struct({
	E2B_API_KEY: ConfiguredString,
	E2B_API_BASE_URL: Schema.optionalKey(HttpsUrl),
	E2B_SANDBOX_DOMAIN: Schema.optionalKey(ConfiguredString),
	E2B_TEMPLATE_ID: ConfiguredString,
	E2B_TEMPLATE_VERSION: ConfiguredString,
	E2B_VCPU_COUNT: Schema.optionalKey(PositiveIntegerFromString),
	E2B_MEMORY_MIB: Schema.optionalKey(PositiveIntegerFromString),
});

const isActivated = (env: SandboxProviderEnvironment): boolean =>
	decodeProviderEnvironment(ActivationEnvironment, env, "E2B")
		.E2B_ADAPTER_ENABLED === "true";

const decodeEnvironment = (env: SandboxProviderEnvironment) =>
	decodeProviderEnvironment(E2bEnvironment, env, "E2B");

export const E2bSandboxProviderModule: SandboxProviderModule = {
	providerId: E2B_PROVIDER_ID,
	productionReady: true,
	configure: ({ env }) => {
		if (!isActivated(env)) return undefined;
		const config = decodeEnvironment(env);
		return {
			advertised: true,
			adapter: makeE2bSandboxProvider({
				apiKey: Redacted.make(config.E2B_API_KEY),
				templateId: config.E2B_TEMPLATE_ID,
				templateVersion: config.E2B_TEMPLATE_VERSION,
				apiBaseUrl: config.E2B_API_BASE_URL?.href,
				sandboxDomain: config.E2B_SANDBOX_DOMAIN,
				resources: {
					vcpuCount: config.E2B_VCPU_COUNT ?? 2,
					memoryMib: config.E2B_MEMORY_MIB ?? 1_024,
				},
			}),
		};
	},
};
