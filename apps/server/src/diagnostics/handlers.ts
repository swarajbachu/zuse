import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { DiagnosticsService } from "./services/diagnostics-service.ts";

const ExportBundle = MemoizeRpcs.toLayerHandler(
	"diagnostics.export",
	(payload) =>
		Effect.flatMap(DiagnosticsService, (svc) => svc.exportBundle(payload)),
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

export const DiagnosticsHandlersLayer = Layer.mergeAll(
	ExportBundle,
	Overview,
	Events,
	Processes,
	SignalProcess,
	Ingest,
);
