import {
	type SandboxProviderRegistration,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Context, Layer, Schema } from "effect";

export type SandboxProviderEnvironment = object;

export interface SandboxOfferConfig {
	readonly port: number;
	readonly createTimeoutSeconds: number;
	readonly keepAliveTimeoutSeconds: number;
	readonly runtimeManifestUrl?: string;
	readonly runtimeSigningPublicJwk?: string;
}

export class SandboxOfferConfiguration extends Context.Service<
	SandboxOfferConfiguration,
	SandboxOfferConfig
>()("@zuse/api/SandboxOfferConfiguration") {}

export interface SandboxProviderRuntime {
	readonly layer: Layer.Layer<SandboxProviders>;
	readonly offer: SandboxOfferConfig;
	readonly configuredProviders: ReadonlyArray<{
		readonly providerId: string;
		readonly productionReady: boolean;
		readonly advertised: boolean;
	}>;
}

export interface SandboxProviderModule {
	readonly providerId: string;
	readonly productionReady: boolean;
	readonly configure: (input: {
		readonly env: SandboxProviderEnvironment;
	}) => SandboxProviderRegistration | undefined;
}

export class SandboxProviderConfigurationError extends Schema.TaggedErrorClass<SandboxProviderConfigurationError>()(
	"SandboxProviderConfigurationError",
	{ message: Schema.String },
) {}

const offerConfiguration = (): SandboxOfferConfig => ({
	port: 47_837,
	createTimeoutSeconds: 60 * 60,
	keepAliveTimeoutSeconds: 10 * 60,
});

const DefaultProviderEnvironment = Schema.Struct({
	SANDBOX_DEFAULT_PROVIDER_ID: Schema.optionalKey(Schema.String),
});

const resolveDefaultProviderId = (
	env: SandboxProviderEnvironment,
	registrations: ReadonlyArray<SandboxProviderRegistration>,
): string => {
	let requested: string | undefined;
	try {
		requested = Schema.decodeUnknownSync(DefaultProviderEnvironment)(
			env,
		).SANDBOX_DEFAULT_PROVIDER_ID?.trim();
	} catch {
		throw new SandboxProviderConfigurationError({
			message: "Invalid SANDBOX_DEFAULT_PROVIDER_ID",
		});
	}
	const firstRegistration =
		registrations.find((registration) => registration.advertised !== false) ??
		registrations[0];
	if (firstRegistration === undefined) {
		throw new SandboxProviderConfigurationError({
			message: "No sandbox provider is configured",
		});
	}
	if (requested === undefined || requested === "") {
		return firstRegistration.adapter.providerId;
	}
	const matches = registrations.some(
		({ adapter, aliases = [] }) =>
			adapter.providerId === requested || aliases.includes(requested),
	);
	if (!matches) {
		throw new SandboxProviderConfigurationError({
			message: `SANDBOX_DEFAULT_PROVIDER_ID is not a configured provider: ${requested}`,
		});
	}
	return requested;
};

export const resolveSandboxProviderRuntimeFromModules = <
	Environment extends SandboxProviderEnvironment,
>(
	env: Environment,
	modules: ReadonlyArray<SandboxProviderModule>,
): SandboxProviderRuntime => {
	const registrations = modules.flatMap((module) => {
		const registration = module.configure({ env });
		return registration === undefined ? [] : [registration];
	});
	const offer = offerConfiguration();
	const configuredProviders = registrations.map(({ adapter, advertised }) => ({
		advertised: advertised !== false,
		providerId: adapter.providerId,
		productionReady:
			modules.find((module) => module.providerId === adapter.providerId)
				?.productionReady ?? false,
	}));
	// With no configured provider the fake registry stands in so the api can
	// still boot; the fake is never advertised and never selectable via
	// placement. Any registration switches to the real registry.
	const layer =
		registrations.length === 0
			? makeSandboxProvidersFake([])
			: SandboxProviders.layer({
					registrations,
					defaultProviderId: resolveDefaultProviderId(env, registrations),
				}).pipe(Layer.orDie);
	return {
		layer,
		offer,
		configuredProviders,
	};
};
