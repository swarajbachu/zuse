import { Effect, Layer, Schedule } from "effect";

import { ModelCatalogService } from "../services/model-catalog-service.ts";

/** Give startup a head start before touching the network or spawning CLIs. */
const INITIAL_DELAY = "20 seconds";
const INTERVAL = "6 hours";

/**
 * Background refresh of the model catalog. Never forces: each pass asks the
 * caches for anything stale (curated document past its TTL, live inventory
 * past its TTL or with a changed CLI/credential fingerprint) and lets them
 * refresh in the background. Failures are logged and never surface.
 */
export const ModelCatalogPollerLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const catalog = yield* ModelCatalogService;
		const pass = catalog.refresh({ remote: true, live: "all" }).pipe(
			Effect.asVoid,
			Effect.catchCause((cause) =>
				Effect.logWarning(`[model-catalog] refresh failed: ${String(cause)}`),
			),
		);
		yield* Effect.forkScoped(
			Effect.sleep(INITIAL_DELAY).pipe(
				Effect.andThen(
					Effect.repeat(
						pass,
						Schedule.spaced(INTERVAL).pipe(Schedule.jittered),
					),
				),
			),
		);
	}),
);
