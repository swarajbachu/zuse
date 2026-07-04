import { MemoizeRpcs } from "@zuse/wire";
import { Effect, Layer, Stream } from "effect";

import { PtyService } from "./services/pty-service.ts";

const Open = MemoizeRpcs.toLayerHandler(
  "pty.open",
  ({ cwd, cols, rows, command }) =>
    Effect.flatMap(PtyService, (svc) => svc.open(cwd, cols, rows, command)),
);

const Write = MemoizeRpcs.toLayerHandler("pty.write", ({ ptyId, data }) =>
  Effect.flatMap(PtyService, (svc) => svc.write(ptyId, data)),
);

const Resize = MemoizeRpcs.toLayerHandler(
  "pty.resize",
  ({ ptyId, cols, rows }) =>
    Effect.flatMap(PtyService, (svc) => svc.resize(ptyId, cols, rows)),
);

const Close = MemoizeRpcs.toLayerHandler("pty.close", ({ ptyId }) =>
  Effect.flatMap(PtyService, (svc) => svc.close(ptyId)),
);

const Output = MemoizeRpcs.toLayerHandler("pty.output", ({ ptyId }) =>
  Stream.unwrap(Effect.map(PtyService, (svc) => svc.subscribe(ptyId))),
);

export const PtyHandlersLayer = Layer.mergeAll(
  Open,
  Write,
  Resize,
  Close,
  Output,
);
