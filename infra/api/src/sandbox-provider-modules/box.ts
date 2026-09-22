import {
	BOX_PROVIDER_ID,
	type BoxMachineType,
	makeBoxSandboxProvider,
} from "@zuse/sandbox-providers/box";
import { Redacted, Schema } from "effect";
import { readBoatEnvironment } from "../boat-environment.ts";
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
	BOAT_ADAPTER_ENABLED: Schema.optionalKey(Schema.Literals(["true", "false"])),
});
const BoxEnvironment = Schema.Struct({
	BOAT_API_KEY: ConfiguredString,
	BOAT_API_BASE_URL: Schema.optionalKey(HttpsUrl),
	BOAT_TEMPLATE_SNAPSHOT: ConfiguredString,
	BOAT_TEMPLATE_VERSION: ConfiguredString,
	BOAT_MACHINE_TYPE: Schema.optionalKey(
		Schema.Literals(["small", "default", "large"]),
	),
	BOAT_HOSTED_PORT_DOMAIN: Schema.optionalKey(ConfiguredString),
});

const configurationError = (): SandboxProviderConfigurationError =>
	new SandboxProviderConfigurationError({
		message: "Invalid Boat sandbox provider configuration",
	});

const isActivated = (env: SandboxProviderEnvironment): boolean => {
	try {
		return (
			Schema.decodeUnknownSync(ActivationEnvironment)(readBoatEnvironment(env))
				.BOAT_ADAPTER_ENABLED === "true"
		);
	} catch {
		throw configurationError();
	}
};

const decodeEnvironment = (env: SandboxProviderEnvironment) => {
	try {
		return Schema.decodeUnknownSync(BoxEnvironment)(readBoatEnvironment(env));
	} catch {
		throw configurationError();
	}
};

export const BoxSandboxProviderModule: SandboxProviderModule = {
	providerId: BOX_PROVIDER_ID,
	productionReady: true,
	configure: ({ env }) => {
		if (!isActivated(env)) return undefined;
		const config = decodeEnvironment(env);
		return {
			adapter: makeBoxSandboxProvider({
				apiKey: Redacted.make(config.BOAT_API_KEY),
				templateSnapshot: config.BOAT_TEMPLATE_SNAPSHOT,
				templateVersion: config.BOAT_TEMPLATE_VERSION,
				machineType: config.BOAT_MACHINE_TYPE as BoxMachineType | undefined,
				apiBaseUrl: config.BOAT_API_BASE_URL?.href,
				hostedPortDomain: config.BOAT_HOSTED_PORT_DOMAIN,
			}),
		};
	},
};
