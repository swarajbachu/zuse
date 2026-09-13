import {
	bundledResolvedModelCatalog,
	findModelDescriptor,
	resolveModelSlug,
} from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { ModelCatalogService } from "../../src/model-catalog/services/model-catalog-service.ts";

/**
 * In-memory ModelCatalogService backed by the bundled snapshot. Tests that
 * exercise session/orchestration flows use this so no network or provider
 * process is ever touched.
 */
export const StubModelCatalogLive = Layer.succeed(ModelCatalogService, {
	current: () => Effect.succeed(bundledResolvedModelCatalog()),
	refresh: () => Effect.succeed(bundledResolvedModelCatalog()),
	changes: () => Stream.make(bundledResolvedModelCatalog()),
	findModel: (providerId, modelId) =>
		Effect.succeed(
			findModelDescriptor(bundledResolvedModelCatalog(), providerId, modelId),
		),
	resolveSlug: (providerId, slug) =>
		Effect.succeed(
			resolveModelSlug(bundledResolvedModelCatalog(), providerId, slug),
		),
	invalidateLive: () => Effect.void,
});
