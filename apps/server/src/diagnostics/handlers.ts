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

const Overview = MemoizeRpcs.toLayerHandler("diagnostics.overview", (payload) =>
	Effect.flatMap(DiagnosticsService, (service) => service.overview(payload)),
);

const Events = MemoizeRpcs.toLayerHandler("diagnostics.events", (payload) =>
	Effect.flatMap(DiagnosticsService, (service) => service.events(payload)),
);

const Processes = MemoizeRpcs.toLayerHandler("diagnostics.processes", () =>
	Effect.flatMap(DiagnosticsService, (service) => service.processes),
);

const SignalProcess = MemoizeRpcs.toLayerHandler(
	"diagnostics.signalProcess",
	(payload) =>
		Effect.flatMap(DiagnosticsService, (service) =>
			service.signalProcess(payload),
		),
);

const Ingest = MemoizeRpcs.toLayerHandler("diagnostics.ingest", (payload) =>
	Effect.flatMap(DiagnosticsService, (service) =>
		service.ingest(payload.events),
	),
);

export const DiagnosticsHandlersLayer = Layer.mergeAll(
	ExportBundle,
	Overview,
	Events,
	Processes,
	SignalProcess,
	Ingest,
);
