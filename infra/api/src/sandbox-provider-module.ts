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
	/** `CLOUD_AUTH_PROVIDER_ID`, validated against the registered providers. */
	readonly cloudAuthProviderId?: string;
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
const CloudAuthProviderEnvironment = Schema.Struct({
	CLOUD_AUTH_PROVIDER_ID: Schema.optionalKey(Schema.String),
});

const isRegistered = (
	registrations: ReadonlyArray<SandboxProviderRegistration>,
	providerId: string,
): boolean =>
	registrations.some(
		({ adapter, aliases = [] }) =>
			adapter.providerId === providerId || aliases.includes(providerId),
	);

// The login authority must run on a registered provider. Checked at boot like
// the default provider: a typo or a disabled adapter would otherwise surface
// only as a 503 on every Cloud authentication request.
const resolveCloudAuthProviderId = (
	env: SandboxProviderEnvironment,
	registrations: ReadonlyArray<SandboxProviderRegistration>,
): string | undefined => {
	let requested: string | undefined;
	try {
		requested = Schema.decodeUnknownSync(CloudAuthProviderEnvironment)(
			env,
		).CLOUD_AUTH_PROVIDER_ID?.trim();
	} catch {
		throw new SandboxProviderConfigurationError({
			message: "Invalid CLOUD_AUTH_PROVIDER_ID",
		});
	}
	if (requested === undefined || requested === "") return undefined;
	if (!isRegistered(registrations, requested)) {
		throw new SandboxProviderConfigurationError({
			message: `CLOUD_AUTH_PROVIDER_ID is not a configured provider: ${requested}`,
		});
	}
	return requested;
};

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
	if (!isRegistered(registrations, requested)) {
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
		...(registrations.length === 0
			? {}
			: {
					cloudAuthProviderId: resolveCloudAuthProviderId(env, registrations),
				}),
	};
};
