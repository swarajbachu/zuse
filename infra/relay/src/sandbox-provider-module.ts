import {
	type SandboxProviderRegistration,
	SandboxProviders,
} from "@zuse/sandbox-providers";
import { makeSandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Context, Layer, Schema } from "effect";

export interface SandboxProviderEnvironment {
	readonly SANDBOX_DEFAULT_PROVIDER?: string;
}

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
	readonly productionReady: boolean;
	readonly providerId: string;
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
		readonly selected: boolean;
	}) => SandboxProviderRegistration | undefined;
}

export class SandboxProviderConfigurationError extends Schema.TaggedErrorClass<SandboxProviderConfigurationError>()(
	"SandboxProviderConfigurationError",
	{ message: Schema.String },
) {}

const offerConfiguration = (): SandboxOfferConfig => ({
	port: 47_837,
	createTimeoutSeconds: 24 * 60 * 60,
	keepAliveTimeoutSeconds: 24 * 60 * 60,
});

export const resolveSandboxProviderRuntimeFromModules = <
	Environment extends SandboxProviderEnvironment,
>(
	env: Environment,
	modules: ReadonlyArray<SandboxProviderModule>,
): SandboxProviderRuntime => {
	const providerId = env.SANDBOX_DEFAULT_PROVIDER ?? "fake";
	const selectedModule =
		providerId === "fake"
			? undefined
			: modules.find((module) => module.providerId === providerId);
	if (providerId !== "fake" && selectedModule === undefined) {
		throw new SandboxProviderConfigurationError({
			message: `Unknown sandbox provider: ${providerId}`,
		});
	}

	const registrations = modules.flatMap((module) => {
		const registration = module.configure({
			env,
			selected: module.providerId === providerId,
		});
		return registration === undefined ? [] : [registration];
	});
	const offer = offerConfiguration();
	const configuredProviders = registrations.map(({ adapter }) => ({
		providerId: adapter.providerId,
		productionReady:
			modules.find((module) => module.providerId === adapter.providerId)
				?.productionReady ?? false,
	}));
	if (providerId === "fake") {
		return {
			layer: makeSandboxProvidersFake(registrations),
			offer,
			productionReady: false,
			providerId,
			configuredProviders,
		};
	}

	const selectedRegistration = registrations.find(
		({ adapter }) => adapter.providerId === providerId,
	);
	if (selectedRegistration === undefined || selectedModule === undefined) {
		throw new SandboxProviderConfigurationError({
			message: `Sandbox provider is not configured: ${providerId}`,
		});
	}

	return {
		layer: SandboxProviders.layer({
			registrations,
			defaultProviderId: selectedRegistration.adapter.providerId,
		}).pipe(Layer.orDie),
		offer,
		productionReady: selectedModule.productionReady,
		providerId,
		configuredProviders,
	};
};
