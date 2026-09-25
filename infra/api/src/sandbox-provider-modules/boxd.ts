import {
	BOXD_PROVIDER_ID,
	type BoxdMachineSize,
	makeBoxdSandboxProvider,
} from "@zuse/sandbox-providers/boxd";
import { Redacted, Schema } from "effect";
import {
	SandboxProviderConfigurationError,
	type SandboxProviderEnvironment,
	type SandboxProviderModule,
} from "../sandbox-provider-module.ts";

const ConfiguredString = Schema.Trim.check(
	Schema.isNonEmpty(),
	Schema.makeFilter(
		(value) =>
			!value.startsWith("REPLACE_WITH") ||
			"Placeholder values are not configured",
	),
);
const HttpsUrl = Schema.URLFromString.check(
	Schema.makeFilter((url) => url.protocol === "https:" || "URL must use HTTPS"),
);
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

const configurationError = (): SandboxProviderConfigurationError =>
	new SandboxProviderConfigurationError({
		message: "Invalid boxd sandbox provider configuration",
	});

const isActivated = (env: SandboxProviderEnvironment): boolean => {
	try {
		return (
			Schema.decodeUnknownSync(ActivationEnvironment)(env)
				.BOXD_ADAPTER_ENABLED === "true"
		);
	} catch {
		throw configurationError();
	}
};

const decodeEnvironment = (env: SandboxProviderEnvironment) => {
	try {
		return Schema.decodeUnknownSync(BoxdEnvironment)(env);
	} catch {
		throw configurationError();
	}
};

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
