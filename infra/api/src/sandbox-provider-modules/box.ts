import {
	BOX_PROVIDER_ID,
	type BoxMachineType,
	makeBoxSandboxProvider,
} from "@zuse/sandbox-providers/box";
import { Redacted, Schema } from "effect";
import { readBoatEnvironment } from "../boat-environment.ts";
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

const isActivated = (env: SandboxProviderEnvironment): boolean =>
	decodeProviderEnvironment(
		ActivationEnvironment,
		readBoatEnvironment(env),
		"Boat",
	).BOAT_ADAPTER_ENABLED === "true";

const decodeEnvironment = (env: SandboxProviderEnvironment) =>
	decodeProviderEnvironment(BoxEnvironment, readBoatEnvironment(env), "Boat");

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
