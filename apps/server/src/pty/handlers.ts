import { MemoizeRpcs } from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { PtyService } from "./services/pty-service.ts";

const Open = MemoizeRpcs.toLayerHandler(
  "pty.open",
	({ cwd, cols, rows, command, mobileOwnership }) =>
		Effect.flatMap(PtyService, (svc) =>
			svc.open(cwd, cols, rows, command, mobileOwnership),
		),
);

const List = MemoizeRpcs.toLayerHandler("pty.list", ({ ownerId }) =>
	Effect.flatMap(PtyService, (svc) => svc.list(ownerId)),
);

const Write = MemoizeRpcs.toLayerHandler(
	"pty.write",
	({ ptyId, data, ownerId }) =>
		Effect.flatMap(PtyService, (svc) => svc.write(ptyId, data, ownerId)),
);

const Resize = MemoizeRpcs.toLayerHandler(
  "pty.resize",
	({ ptyId, cols, rows, ownerId }) =>
		Effect.flatMap(PtyService, (svc) => svc.resize(ptyId, cols, rows, ownerId)),
);

const Close = MemoizeRpcs.toLayerHandler("pty.close", ({ ptyId, ownerId }) =>
	Effect.flatMap(PtyService, (svc) => svc.close(ptyId, ownerId)),
);

const Output = MemoizeRpcs.toLayerHandler(
  "pty.output",
	({ ptyId, afterSequence, ownerId }) =>
    Stream.unwrap(
			Effect.map(PtyService, (svc) =>
				svc.subscribe(ptyId, afterSequence, ownerId),
			),
    ),
);

export const PtyHandlersLayer = Layer.mergeAll(
  Open,
	List,
  Write,
  Resize,
  Close,
  Output,
);
