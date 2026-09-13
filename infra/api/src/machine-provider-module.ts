import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import {
	type MachineProviderRegistration,
	MachineProviders,
} from "@zuse/machine-providers";
import { makeMachineProvidersFake } from "@zuse/machine-providers/testing";
import { Layer, Schema } from "effect";

export interface MachineProviderEnvironment {
	readonly MACHINE_PROVIDER?: string;
}

export interface MachineProviderBootstrap {
	readonly cloudInitTemplate: string;
	readonly apiIssuer: string;
	readonly runtimeInstallerSource: string;
}

export interface MachineProviderRuntime {
	readonly layer: Layer.Layer<MachineProviders>;
	readonly productionReady: boolean;
	readonly providerId: string;
}

export interface MachineProviderModule {
	readonly providerId: string;
	readonly productionReady: boolean;
	readonly configure: (input: {
		readonly env: MachineProviderEnvironment;
		readonly bootstrap: MachineProviderBootstrap;
		readonly selected: boolean;
	}) => MachineProviderRegistration | undefined;
}

export class MachineProviderConfigurationError extends Schema.TaggedErrorClass<MachineProviderConfigurationError>()(
	"MachineProviderConfigurationError",
	{ message: Schema.String },
) {}

const yamlBlockContinuation = (value: string, indentation: number): string =>
	value.trimEnd().replaceAll("\n", `\n${" ".repeat(indentation)}`);

export const renderMachineCloudInit = (
	template: string,
	input: {
		readonly machineId: string;
		readonly providerLabel: string;
		readonly enrollmentToken: string;
		readonly apiUrl: string;
		readonly apiIssuer: string;
		readonly runtimeManifestUrl: string;
		readonly runtimeSigningPublicJwk: string;
		readonly runtimeInstallerSource: string;
	},
): string => {
	const replacements: Readonly<Record<string, string>> = {
		__MACHINE_ID__: input.machineId,
		__MACHINE_LABEL__: input.providerLabel,
		__API_URL__: input.apiUrl,
		__API_ISSUER__: input.apiIssuer,
		__ENROLLMENT_TOKEN__: input.enrollmentToken,
		__RUNTIME_MANIFEST_URL__: input.runtimeManifestUrl,
		__WIRE_PROTOCOL_VERSION__: String(WIRE_PROTOCOL_VERSION),
		__RUNTIME_SIGNING_PUBLIC_JWK__: input.runtimeSigningPublicJwk,
		__RUNTIME_INSTALLER_SOURCE__: yamlBlockContinuation(
			input.runtimeInstallerSource,
			6,
		),
	};
	let rendered = template;
	for (const [placeholder, value] of Object.entries(replacements)) {
		rendered = rendered.replaceAll(placeholder, value);
	}
	if (/__[A-Z0-9_]+__/.test(rendered)) {
		throw new MachineProviderConfigurationError({
			message: "Cloud-init template contains unresolved placeholders",
		});
	}
	return rendered;
};

export const resolveMachineProviderRuntimeFromModules = <
	Environment extends MachineProviderEnvironment,
>(
	env: Environment,
	bootstrap: MachineProviderBootstrap,
	modules: ReadonlyArray<MachineProviderModule>,
): MachineProviderRuntime => {
	const providerId = env.MACHINE_PROVIDER ?? "fake";
	const selectedModule =
		providerId === "fake"
			? undefined
			: modules.find((module) => module.providerId === providerId);
	if (providerId !== "fake" && selectedModule === undefined) {
		throw new MachineProviderConfigurationError({
			message: `Unknown machine provider: ${providerId}`,
		});
	}

	const registrations = modules.flatMap((module) => {
		const registration = module.configure({
			env,
			bootstrap,
			selected: module.providerId === providerId,
		});
		return registration === undefined ? [] : [registration];
	});
	if (providerId === "fake") {
		return {
			layer: makeMachineProvidersFake(registrations),
			productionReady: false,
			providerId,
		};
	}

	const selectedRegistration = registrations.find(
		({ adapter }) => adapter.providerId === providerId,
	);
	if (selectedRegistration === undefined) {
		throw new MachineProviderConfigurationError({
			message: `Machine provider is not configured: ${providerId}`,
		});
	}
	if (selectedModule === undefined) {
		throw new MachineProviderConfigurationError({
			message: `Unknown machine provider: ${providerId}`,
		});
	}

	return {
		layer: MachineProviders.layer({
			registrations,
			defaultProviderId: selectedRegistration.adapter.providerId,
		}).pipe(Layer.orDie),
		productionReady: selectedModule.productionReady,
		providerId,
	};
};
