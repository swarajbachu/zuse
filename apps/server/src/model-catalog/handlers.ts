import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { ModelCatalogService } from "./services/model-catalog-service.ts";

/** Forced refreshes spawn provider processes; cap how long a caller waits. */
const FORCED_REFRESH_TIMEOUT = "20 seconds";

const ModelCatalog = MemoizeRpcs.toLayerHandler("model.catalog", (payload) =>
	Effect.gen(function* () {
		const catalog = yield* ModelCatalogService;
		if (payload.refresh !== true) return yield* catalog.current();
		return yield* catalog.refresh({ remote: true, live: "all" }).pipe(
			Effect.timeoutOption(FORCED_REFRESH_TIMEOUT),
			Effect.flatMap((result) =>
				result._tag === "Some"
					? Effect.succeed(result.value)
					: catalog.current(),
			),
		);
	}),
);

const ModelCatalogStream = MemoizeRpcs.toLayerHandler(
	"model.catalog.stream",
	() => Stream.unwrap(Effect.map(ModelCatalogService, (svc) => svc.changes())),
);

export const ModelCatalogHandlersLayer = Layer.mergeAll(
	ModelCatalog,
	ModelCatalogStream,
);
