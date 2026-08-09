import { MemoizeRpcs, PreviewOpError } from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { PreviewService, type PreviewServiceError } from "./preview-service.ts";

const withPreview = <A>(
	run: (
		service: PreviewService["Service"],
	) => Effect.Effect<A, PreviewServiceError>,
) =>
	Effect.gen(function* () {
		const service = yield* PreviewService;
		return yield* run(service);
	}).pipe(
		Effect.mapError(
			(error) =>
				new PreviewOpError({
					code: error.code,
					approvalUrl: error.approvalUrl,
				}),
		),
	);

const ListServers = MemoizeRpcs.toLayerHandler("preview.servers.list", () =>
	withPreview((service) =>
		service.listServers().pipe(Effect.map((servers) => ({ servers }))),
	),
);

const Forward = MemoizeRpcs.toLayerHandler("preview.forward", ({ port }) =>
	withPreview((service) => service.forward(port)),
);

export const PreviewHandlersLayer = Layer.mergeAll(ListServers, Forward);
