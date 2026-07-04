import { MemoizeRpcs } from "@zuse/wire";
import { Effect, Layer } from "effect";

import { ExternalThreadService } from "./services/external-thread-service.ts";

const List = MemoizeRpcs.toLayerHandler("externalThreads.list", ({ limit }) =>
  Effect.flatMap(ExternalThreadService, (svc) => svc.list(limit ?? 12)),
);

const Continue = MemoizeRpcs.toLayerHandler(
  "externalThreads.continue",
  (input) =>
    Effect.flatMap(ExternalThreadService, (svc) => svc.continueThread(input)),
);

export const ExternalThreadHandlersLayer = Layer.mergeAll(List, Continue);
