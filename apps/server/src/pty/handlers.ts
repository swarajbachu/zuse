import {
	MemoizeRpcs,
	type PtyCatalog,
	type PtyOwnership,
	PtySpawnError,
	type PtySummary,
} from "@zuse/contracts";
import { Effect, Layer, Stream } from "effect";

import { PtyService } from "./services/pty-service.ts";

export const ptyListResponse = (
	catalog: PtyCatalog,
	includePolicy: boolean | undefined,
): PtyCatalog | ReadonlyArray<PtySummary> =>
	includePolicy === true ? catalog : catalog.terminals;

export const resolvePtyOpenOwnership = (
	ownership: PtyOwnership | undefined,
	mobileOwnership: PtyOwnership | undefined,
): Effect.Effect<PtyOwnership | undefined, PtySpawnError> => {
	if (
		ownership !== undefined &&
		mobileOwnership !== undefined &&
		(ownership.ownerId !== mobileOwnership.ownerId ||
			ownership.label !== mobileOwnership.label ||
			ownership.scope !== mobileOwnership.scope ||
			ownership.openToken !== mobileOwnership.openToken)
	) {
		return Effect.fail(
			new PtySpawnError({ reason: "Conflicting terminal ownership fields" }),
		);
	}
	return Effect.succeed(ownership ?? mobileOwnership);
};

const Open = MemoizeRpcs.toLayerHandler(
	"pty.open",
	({ cwd, cols, rows, command, ownership, mobileOwnership }) =>
		Effect.flatMap(
			resolvePtyOpenOwnership(ownership, mobileOwnership),
			(resolved) =>
				Effect.flatMap(PtyService, (svc) =>
					svc.open(cwd, cols, rows, command, resolved),
				),
		),
);

const List = MemoizeRpcs.toLayerHandler(
	"pty.list",
	({ ownerId, includePolicy }) =>
		Effect.flatMap(PtyService, (svc) =>
			Effect.map(svc.list(ownerId), (catalog) =>
				ptyListResponse(catalog, includePolicy),
			),
		),
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

const CloseOwned = MemoizeRpcs.toLayerHandler("pty.closeOwned", ({ ownerId }) =>
	Effect.flatMap(PtyService, (svc) =>
		Effect.map(svc.closeOwned(ownerId), (closed) => ({ closed })),
	),
);

const Rename = MemoizeRpcs.toLayerHandler(
	"pty.rename",
	({ ptyId, label, ownerId }) =>
		Effect.flatMap(PtyService, (svc) => svc.rename(ptyId, label, ownerId)),
);

const Restart = MemoizeRpcs.toLayerHandler(
	"pty.restart",
	({ ptyId, ownerId, expectedProcessEpoch }) =>
		Effect.flatMap(PtyService, (svc) =>
			svc.restart(ptyId, ownerId, expectedProcessEpoch),
		),
);

const Output = MemoizeRpcs.toLayerHandler(
	"pty.output",
	({ ptyId, afterSequence, processEpoch, ownerId }) =>
		Stream.unwrap(
			Effect.map(PtyService, (svc) =>
				svc.subscribe(ptyId, afterSequence, processEpoch, ownerId),
			),
		),
);

export const PtyHandlersLayer = Layer.mergeAll(
	Open,
	List,
	Write,
	Resize,
	Close,
	CloseOwned,
	Rename,
	Restart,
	Output,
);
