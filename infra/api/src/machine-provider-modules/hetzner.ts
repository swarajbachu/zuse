import {
	HETZNER_LEGACY_PROVIDER_ID,
	HETZNER_PROVIDER_ID,
	makeHetznerMachineProvider,
} from "@zuse/machine-providers/hetzner";
import { Redacted, Schema } from "effect";
import {
	MachineProviderConfigurationError,
	type MachineProviderEnvironment,
	type MachineProviderModule,
	renderMachineCloudInit,
} from "../machine-provider-module.ts";

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
const PositiveIntegerFromString = Schema.NumberFromString.check(
	Schema.isInt(),
	Schema.isGreaterThan(0),
);
const HetznerActivationEnvironment = Schema.Struct({
	HETZNER_ADAPTER_ENABLED: Schema.optionalKey(
		Schema.Literals(["true", "false"]),
	),
});
const HetznerEnvironment = Schema.Struct({
	HETZNER_API_TOKEN: ConfiguredString,
	HETZNER_API_BASE_URL: Schema.optionalKey(HttpsUrl),
	HETZNER_FIREWALL_ID: PositiveIntegerFromString,
	HETZNER_IMAGE: ConfiguredString,
	HETZNER_LOCATION: ConfiguredString,
	HETZNER_SERVER_TYPE_PERSISTENT_STANDARD_V1: ConfiguredString,
	MACHINE_RUNTIME_MANIFEST_URL: HttpsUrl,
	MACHINE_RUNTIME_SIGNING_PUBLIC_JWK: ConfiguredString,
});

const configurationError = (): MachineProviderConfigurationError =>
	new MachineProviderConfigurationError({
		message: "Invalid Hetzner machine provider configuration",
	});

const isActivated = (env: MachineProviderEnvironment): boolean => {
	try {
		const activation = Schema.decodeUnknownSync(HetznerActivationEnvironment)(
			env,
		);
		return activation.HETZNER_ADAPTER_ENABLED === "true";
	} catch {
		throw configurationError();
	}
};

const decodeEnvironment = (env: MachineProviderEnvironment) => {
	try {
		const decoded = Schema.decodeUnknownSync(HetznerEnvironment)(env);
		Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(
			decoded.MACHINE_RUNTIME_SIGNING_PUBLIC_JWK,
		);
		return decoded;
	} catch {
		throw configurationError();
	}
};

export const HetznerMachineProviderModule: MachineProviderModule = {
	providerId: HETZNER_PROVIDER_ID,
	productionReady: true,
	configure: ({ env, bootstrap, selected }) => {
		if (!selected && !isActivated(env)) {
			return undefined;
		}

		const config = decodeEnvironment(env);

		return {
			adapter: makeHetznerMachineProvider({
				accessToken: Redacted.make(config.HETZNER_API_TOKEN),
				apiBaseUrl: config.HETZNER_API_BASE_URL?.href,
				offerProfiles: {
					"persistent-standard-v1": {
						serverType: config.HETZNER_SERVER_TYPE_PERSISTENT_STANDARD_V1,
						image: config.HETZNER_IMAGE,
						location: config.HETZNER_LOCATION,
						firewallId: config.HETZNER_FIREWALL_ID,
					},
				},
				renderUserData: ({ machineId, providerLabel, enrollmentToken }) =>
					renderMachineCloudInit(bootstrap.cloudInitTemplate, {
						machineId,
						providerLabel,
						enrollmentToken,
						apiUrl: bootstrap.apiIssuer,
						apiIssuer: bootstrap.apiIssuer,
						runtimeManifestUrl: config.MACHINE_RUNTIME_MANIFEST_URL.href,
						runtimeSigningPublicJwk: config.MACHINE_RUNTIME_SIGNING_PUBLIC_JWK,
						runtimeInstallerSource: bootstrap.runtimeInstallerSource,
					}),
			}),
			aliases: [HETZNER_LEGACY_PROVIDER_ID],
		};
	},
};
