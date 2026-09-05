import type {
	ModelOption,
	ProviderId,
	ResolvedModelCatalog,
	ResolvedModelOption,
} from "@zuse/contracts";
import { Context, type Effect, type Stream } from "effect";

export interface ModelCatalogRefreshOptions {
	/** Re-fetch the curated document from zuse.sh (respects ETag). */
	readonly remote?: boolean;
	/** Re-run live provider listings: every provider, or a subset. */
	readonly live?: "all" | ReadonlyArray<ProviderId>;
}

/**
 * Resolved model catalog: curated document (bundled / disk cache / remote,
 * whichever carries the highest revision) merged with live provider
 * inventories. `current()` is always instant — it reads memory that was
 * seeded from disk or the bundled snapshot at construction — and every
 * network or process-spawning refresh happens off the request path.
 */
export interface ModelCatalogServiceShape {
	readonly current: () => Effect.Effect<ResolvedModelCatalog>;
	readonly refresh: (
		options?: ModelCatalogRefreshOptions,
	) => Effect.Effect<ResolvedModelCatalog>;
	readonly changes: () => Stream.Stream<ResolvedModelCatalog>;
	/** Resolved descriptor for a canonical model id (undefined for custom slugs). */
	readonly findModel: (
		providerId: ProviderId,
		modelId: string,
	) => Effect.Effect<ResolvedModelOption | undefined>;
	/** Canonical slug after alias resolution. */
	readonly resolveSlug: (
		providerId: ProviderId,
		slug: string,
	) => Effect.Effect<string>;
	/** Drop the cached live listing so the next refresh re-probes the provider. */
	readonly invalidateLive: (providerId: ProviderId) => Effect.Effect<void>;
}

export class ModelCatalogService extends Context.Service<
	ModelCatalogService,
	ModelCatalogServiceShape
>()("memoize/ModelCatalogService") {}

/** The plain `ModelOption` slice drivers receive via `StartSessionInput`. */
export const toDriverModelDescriptor = (
	model: ResolvedModelOption | undefined,
): ModelOption | undefined => {
	if (model === undefined) return undefined;
	const {
		origin: _origin,
		available: _available,
		liveMeta: _live,
		...rest
	} = model;
	return rest;
};
