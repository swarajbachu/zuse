import {
	E2B_PROVIDER_ID,
	makeE2bSandboxProvider,
} from "@zuse/sandbox-providers/e2b";
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
	E2B_ADAPTER_ENABLED: Schema.optionalKey(Schema.Literals(["true", "false"])),
});
const E2bEnvironment = Schema.Struct({
	E2B_API_KEY: ConfiguredString,
	E2B_API_BASE_URL: Schema.optionalKey(HttpsUrl),
	E2B_SANDBOX_DOMAIN: Schema.optionalKey(ConfiguredString),
	E2B_TEMPLATE_ID: ConfiguredString,
	E2B_TEMPLATE_VERSION: ConfiguredString,
});

const configurationError = (): SandboxProviderConfigurationError =>
	new SandboxProviderConfigurationError({
		message: "Invalid E2B sandbox provider configuration",
	});

const isActivated = (env: SandboxProviderEnvironment): boolean => {
	try {
		return (
			Schema.decodeUnknownSync(ActivationEnvironment)(env)
				.E2B_ADAPTER_ENABLED === "true"
		);
	} catch {
		throw configurationError();
	}
};

const decodeEnvironment = (env: SandboxProviderEnvironment) => {
	try {
		return Schema.decodeUnknownSync(E2bEnvironment)(env);
	} catch {
		throw configurationError();
	}
};

export const E2bSandboxProviderModule: SandboxProviderModule = {
	providerId: E2B_PROVIDER_ID,
	// Keep production checkout gated until staging proves template boot,
	// enrollment, public proxy WebSockets, and keep-alive behavior.
	productionReady: false,
	configure: ({ env }) => {
		if (!isActivated(env)) return undefined;
		const config = decodeEnvironment(env);
		return {
			adapter: makeE2bSandboxProvider({
				apiKey: Redacted.make(config.E2B_API_KEY),
				templateId: config.E2B_TEMPLATE_ID,
				templateVersion: config.E2B_TEMPLATE_VERSION,
				apiBaseUrl: config.E2B_API_BASE_URL?.href,
				sandboxDomain: config.E2B_SANDBOX_DOMAIN,
			}),
		};
	},
};
