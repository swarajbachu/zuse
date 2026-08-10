import type {
	SandboxProviderRegistration,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Context, type Layer, Schema } from "effect";

export type SandboxProviderEnvironment = object;

export interface SandboxOfferConfig {
	readonly port: number;
	readonly createTimeoutSeconds: number;
	readonly keepAliveTimeoutSeconds: number;
}

export class SandboxOfferConfiguration extends Context.Service<
	SandboxOfferConfiguration,
	SandboxOfferConfig
>()("@zuse/relay/SandboxOfferConfiguration") {}

export interface SandboxProviderRuntime {
	readonly layer: Layer.Layer<SandboxProviders>;
	readonly offer: SandboxOfferConfig;
	readonly configuredProviders: ReadonlyArray<{
		readonly providerId: string;
		readonly productionReady: boolean;
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
	keepAliveTimeoutSeconds: 60 * 60,
});

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
	const configuredProviders = registrations.map(({ adapter }) => ({
		providerId: adapter.providerId,
		productionReady:
			modules.find((module) => module.providerId === adapter.providerId)
				?.productionReady ?? false,
	}));
	return {
		layer: makeSandboxProvidersFake(registrations),
		offer,
		configuredProviders,
	};
};
