import type { MachineOffer } from "@zuse/contracts";
import {
	makeProviderRegistry,
	type ProviderRegistry,
	type ProviderRegistryConfigError,
} from "@zuse/provider-registry";
import { Context, Effect, Layer, Schema } from "effect";

export class MachineProviderError extends Schema.TaggedErrorClass<MachineProviderError>()(
	"MachineProviderError",
	{
		code: Schema.Literals(["transient", "not-found", "rejected"]),
	},
) {}

export interface ProviderMachine {
	readonly providerServerId: string;
	readonly providerLabel: string;
	readonly powerState: "running" | "off";
}

export interface MachineProviderAdapter {
	readonly providerId: string;
	readonly create: (input: {
		readonly machineId: string;
		readonly providerLabel: string;
		readonly offer: MachineOffer;
		readonly enrollmentToken: string;
	}) => Effect.Effect<ProviderMachine, MachineProviderError>;
	readonly recoverByLabel: (
		providerLabel: string,
	) => Effect.Effect<ProviderMachine | null, MachineProviderError>;
	readonly inspect: (
		providerServerId: string,
	) => Effect.Effect<ProviderMachine | null, MachineProviderError>;
	readonly powerOff: (
		providerServerId: string,
	) => Effect.Effect<void, MachineProviderError>;
	readonly powerOn: (
		providerServerId: string,
	) => Effect.Effect<void, MachineProviderError>;
	readonly snapshot: (
		providerServerId: string,
		label: string,
	) => Effect.Effect<string, MachineProviderError>;
	readonly delete: (
		providerServerId: string,
	) => Effect.Effect<void, MachineProviderError>;
	readonly deleteSnapshot: (
		snapshotId: string,
	) => Effect.Effect<void, MachineProviderError>;
}

export interface MachineProviderRegistration {
	readonly adapter: MachineProviderAdapter;
	readonly aliases?: ReadonlyArray<string>;
}

export interface MachineProvidersApi
	extends ProviderRegistry<MachineProviderAdapter> {}

const adaptersFor = (
	registrations: ReadonlyArray<MachineProviderRegistration>,
): ReadonlyArray<MachineProviderAdapter> =>
	registrations.flatMap(({ adapter, aliases = [] }) => [
		adapter,
		...aliases.map((providerId) => ({ ...adapter, providerId })),
	]);

export const makeMachineProviders = Effect.fn("makeMachineProviders")(
	(input: {
		readonly registrations: ReadonlyArray<MachineProviderRegistration>;
		readonly defaultProviderId: string;
	}): Effect.Effect<MachineProvidersApi, ProviderRegistryConfigError> =>
		makeProviderRegistry({
			adapters: adaptersFor(input.registrations),
			defaultProviderId: input.defaultProviderId,
		}),
);

export class MachineProviders extends Context.Service<
	MachineProviders,
	MachineProvidersApi
>()("@zuse/machine-providers/MachineProviders") {
	static readonly layer = (input: {
		readonly registrations: ReadonlyArray<MachineProviderRegistration>;
		readonly defaultProviderId: string;
	}): Layer.Layer<MachineProviders, ProviderRegistryConfigError> =>
		Layer.effect(
			MachineProviders,
			makeMachineProviders(input).pipe(Effect.map(MachineProviders.of)),
		);
}
