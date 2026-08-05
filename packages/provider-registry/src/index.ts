import { Effect, Schema } from "effect";

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export interface IdentifiedProvider {
	readonly providerId: string;
}

export class ProviderSelectionError extends Schema.TaggedErrorClass<ProviderSelectionError>()(
	"ProviderSelectionError",
	{ providerId: Schema.String },
) {}

export class ProviderRegistryConfigError extends Schema.TaggedErrorClass<ProviderRegistryConfigError>()(
	"ProviderRegistryConfigError",
	{
		code: Schema.Literals([
			"invalid-provider-id",
			"duplicate-provider-id",
			"default-provider-not-registered",
		]),
		providerId: Schema.String,
	},
) {}

export interface ProviderRegistry<Adapter extends IdentifiedProvider> {
	readonly defaultProviderId: string;
	readonly providerIds: ReadonlyArray<string>;
	readonly get: (
		providerId: string,
	) => Effect.Effect<Adapter, ProviderSelectionError>;
	readonly getDefault: Effect.Effect<Adapter, ProviderSelectionError>;
}

export const makeProviderRegistry = Effect.fn("makeProviderRegistry")(
	function* <Adapter extends IdentifiedProvider>(input: {
		readonly adapters: ReadonlyArray<Adapter>;
		readonly defaultProviderId: string;
	}) {
		const adapters = new Map<string, Adapter>();
		for (const adapter of input.adapters) {
			if (!PROVIDER_ID_PATTERN.test(adapter.providerId)) {
				return yield* new ProviderRegistryConfigError({
					code: "invalid-provider-id",
					providerId: adapter.providerId,
				});
			}
			if (adapters.has(adapter.providerId)) {
				return yield* new ProviderRegistryConfigError({
					code: "duplicate-provider-id",
					providerId: adapter.providerId,
				});
			}
			adapters.set(adapter.providerId, adapter);
		}
		if (!adapters.has(input.defaultProviderId)) {
			return yield* new ProviderRegistryConfigError({
				code: "default-provider-not-registered",
				providerId: input.defaultProviderId,
			});
		}
		const get = (providerId: string) => {
			const adapter = adapters.get(providerId);
			return adapter === undefined
				? new ProviderSelectionError({ providerId })
				: Effect.succeed(adapter);
		};
		return {
			defaultProviderId: input.defaultProviderId,
			providerIds: [...adapters.keys()],
			get,
			getDefault: get(input.defaultProviderId),
		} satisfies ProviderRegistry<Adapter>;
	},
);
