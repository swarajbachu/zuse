import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { AnalyticsService } from "./services/analytics-service.ts";

const GetContext = MemoizeRpcs.toLayerHandler("analytics.getContext", () =>
	Effect.flatMap(AnalyticsService, (service) => service.getContext()),
);

const ContextChanges = MemoizeRpcs.toLayerHandler(
	"analytics.contextChanges",
	() =>
		Stream.unwrap(
			Effect.map(AnalyticsService, (service) => service.contextChanges()),
		),
);

export const AnalyticsHandlersLayer = Layer.mergeAll(
	GetContext,
	ContextChanges,
);
