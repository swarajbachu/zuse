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
	Effect.flatMap(DiagnosticsService, (svc) => svc.overview(payload)),
);
const Events = MemoizeRpcs.toLayerHandler("diagnostics.events", (payload) =>
	Effect.flatMap(DiagnosticsService, (svc) => svc.events(payload)),
);
const Processes = MemoizeRpcs.toLayerHandler("diagnostics.processes", () =>
	Effect.flatMap(DiagnosticsService, (svc) => svc.processes),
);
const SignalProcess = MemoizeRpcs.toLayerHandler(
	"diagnostics.signalProcess",
	(payload) =>
		Effect.flatMap(DiagnosticsService, (svc) => svc.signalProcess(payload)),
);
const Ingest = MemoizeRpcs.toLayerHandler("diagnostics.ingest", (payload) =>
	Effect.flatMap(DiagnosticsService, (svc) => svc.ingest(payload.events)),
);
const Capture = MemoizeRpcs.toLayerHandler("diagnostics.capture", (payload) =>
	Effect.flatMap(DiagnosticsService, (svc) => svc.capture(payload)),
);

export const DiagnosticsHandlersLayer = Layer.mergeAll(
	ExportBundle,
	Overview,
	Events,
	Processes,
	SignalProcess,
	Ingest,
	Capture,
);
