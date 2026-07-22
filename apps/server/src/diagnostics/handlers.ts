import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";
import { AnalyticsService } from "../analytics/services/analytics-service.ts";
import { DiagnosticsService } from "./services/diagnostics-service.ts";

const ExportBundle = MemoizeRpcs.toLayerHandler(
	"diagnostics.export",
	(payload) =>
		Effect.gen(function* () {
			const service = yield* DiagnosticsService;
			const analytics = yield* AnalyticsService;
			return yield* service.exportBundle(payload).pipe(
				Effect.tap(() =>
					analytics.capture("diagnostics exported", { outcome: "completed" }),
				),
				Effect.tapError(() =>
					analytics.capture("diagnostics exported", { outcome: "failed" }),
				),
			);
		}),
);

export const DiagnosticsHandlersLayer = Layer.mergeAll(ExportBundle);
