import {
	BOX_PROVIDER_ID,
	type BoxMachineType,
	makeBoxSandboxProvider,
} from "@zuse/sandbox-providers/box";
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
	BOX_ADAPTER_ENABLED: Schema.optionalKey(Schema.Literals(["true", "false"])),
});
const BoxEnvironment = Schema.Struct({
	BOX_API_KEY: ConfiguredString,
	BOX_API_BASE_URL: Schema.optionalKey(HttpsUrl),
	BOX_TEMPLATE_SNAPSHOT: ConfiguredString,
	BOX_TEMPLATE_VERSION: ConfiguredString,
	BOX_MACHINE_TYPE: Schema.optionalKey(
		Schema.Literals(["small", "default", "large"]),
	),
	BOX_HOSTED_PORT_DOMAIN: Schema.optionalKey(ConfiguredString),
});

const configurationError = (): SandboxProviderConfigurationError =>
	new SandboxProviderConfigurationError({
		message: "Invalid Box sandbox provider configuration",
	});

const isActivated = (env: SandboxProviderEnvironment): boolean => {
	try {
		return (
			Schema.decodeUnknownSync(ActivationEnvironment)(env)
				.BOX_ADAPTER_ENABLED === "true"
		);
	} catch {
		throw configurationError();
	}
};

const decodeEnvironment = (env: SandboxProviderEnvironment) => {
	try {
		return Schema.decodeUnknownSync(BoxEnvironment)(env);
	} catch {
		throw configurationError();
	}
};

export const BoxSandboxProviderModule: SandboxProviderModule = {
	providerId: BOX_PROVIDER_ID,
	// Keep production checkout gated until staging proves the published base
	// snapshot, in-guest quarantine verification, hosted-port WebSockets, and
	// billing webhook round trips.
	productionReady: false,
	configure: ({ env }) => {
		if (!isActivated(env)) return undefined;
		const config = decodeEnvironment(env);
		return {
			adapter: makeBoxSandboxProvider({
				apiKey: Redacted.make(config.BOX_API_KEY),
				templateSnapshot: config.BOX_TEMPLATE_SNAPSHOT,
				templateVersion: config.BOX_TEMPLATE_VERSION,
				machineType: config.BOX_MACHINE_TYPE as BoxMachineType | undefined,
				apiBaseUrl: config.BOX_API_BASE_URL?.href,
				hostedPortDomain: config.BOX_HOSTED_PORT_DOMAIN,
			}),
		};
	},
};
