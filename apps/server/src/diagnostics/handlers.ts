import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer } from "effect";

import { DiagnosticsService } from "./services/diagnostics-service.ts";

const ExportBundle = MemoizeRpcs.toLayerHandler("diagnostics.export", (payload) =>
  Effect.flatMap(DiagnosticsService, (svc) => svc.exportBundle(payload)),
);

export const DiagnosticsHandlersLayer = Layer.mergeAll(ExportBundle);
