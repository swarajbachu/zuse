import {
	BOXD_PROVIDER_ID,
	type BoxdMachineSize,
	makeBoxdSandboxProvider,
} from "@zuse/sandbox-providers/boxd";
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
	BOXD_ADAPTER_ENABLED: Schema.optionalKey(Schema.Literals(["true", "false"])),
});
const BoxdEnvironment = Schema.Struct({
	BOXD_API_KEY: ConfiguredString,
	BOXD_ORG: Schema.optionalKey(ConfiguredString),
	BOXD_BASE_URL: Schema.optionalKey(HttpsUrl),
	BOXD_TEMPLATE_SNAPSHOT: ConfiguredString,
	BOXD_TEMPLATE_VERSION: ConfiguredString,
	BOXD_MACHINE_SIZE: Schema.optionalKey(
		Schema.Literals(["small", "default", "large"]),
	),
});

const isActivated = (env: SandboxProviderEnvironment): boolean =>
	decodeProviderEnvironment(ActivationEnvironment, env, "boxd")
		.BOXD_ADAPTER_ENABLED === "true";

const decodeEnvironment = (env: SandboxProviderEnvironment) =>
	decodeProviderEnvironment(BoxdEnvironment, env, "boxd");

export const BoxdSandboxProviderModule: SandboxProviderModule = {
	providerId: BOXD_PROVIDER_ID,
	productionReady: true,
	configure: ({ env }) => {
		if (!isActivated(env)) return undefined;
		const config = decodeEnvironment(env);
		return {
			advertised: true,
			adapter: makeBoxdSandboxProvider({
				apiKey: Redacted.make(config.BOXD_API_KEY),
				org: config.BOXD_ORG,
				templateSnapshot: config.BOXD_TEMPLATE_SNAPSHOT,
				templateVersion: config.BOXD_TEMPLATE_VERSION,
				machineSize: config.BOXD_MACHINE_SIZE as BoxdMachineSize | undefined,
				baseUrl: config.BOXD_BASE_URL?.href,
			}),
		};
	},
};
