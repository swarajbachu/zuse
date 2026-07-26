import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { PtyId } from "./ids.ts";

/**
 * Output emitted by a live PTY. The stream completes after the `exit` event;
 * renderers should treat that as a terminal-closed signal.
 */
export const PtyDataEvent = Schema.TaggedStruct("data", {
	sequence: Schema.Number,
	bytes: Schema.String,
});

export const PtyExitEvent = Schema.TaggedStruct("exit", {
	sequence: Schema.Number,
	exitCode: Schema.NullOr(Schema.Number),
	signal: Schema.NullOr(Schema.Number),
});

export const PtyCursorEvent = Schema.TaggedStruct("cursor", {
	sequence: Schema.Number,
});

export const PtyGapEvent = Schema.TaggedStruct("gap", {
	requestedAfter: Schema.Number,
	earliestAvailable: Schema.Number,
	latestAvailable: Schema.Number,
});

export const PtyEvent = Schema.Union([
	PtyDataEvent,
	PtyExitEvent,
	PtyCursorEvent,
	PtyGapEvent,
]);

export class PtyNotFoundError extends Schema.TaggedErrorClass<PtyNotFoundError>()(
	"PtyNotFoundError",
	{ ptyId: PtyId },
) {}

export class PtySpawnError extends Schema.TaggedErrorClass<PtySpawnError>()(
	"PtySpawnError",
	{ reason: Schema.String },
) {}

export class PtyOwnerLimitError extends Schema.TaggedErrorClass<PtyOwnerLimitError>()(
	"PtyOwnerLimitError",
	{
		ownerId: Schema.String,
		limit: Schema.Number,
	},
) {}

export class PtyOwnerMismatchError extends Schema.TaggedErrorClass<PtyOwnerMismatchError>()(
	"PtyOwnerMismatchError",
	{ ptyId: PtyId },
) {}

export const PtyScope = Schema.Literals(["session", "environment"]);
export type PtyScope = typeof PtyScope.Type;

export class PtyMobileOwnership extends Schema.Class<PtyMobileOwnership>(
	"PtyMobileOwnership",
)({
	ownerId: Schema.String,
	label: Schema.optional(Schema.String),
	scope: Schema.optional(PtyScope),
}) {}

export const PtyStatus = Schema.Literals(["running", "exited"]);
export type PtyStatus = typeof PtyStatus.Type;

export class PtySummary extends Schema.Class<PtySummary>("PtySummary")({
	ptyId: PtyId,
	cwd: Schema.String,
	label: Schema.NullOr(Schema.String),
	scope: PtyScope,
	status: PtyStatus,
	cols: Schema.Number,
	rows: Schema.Number,
	latestOutputSequence: Schema.Number,
}) {}

/**
 * Optional override for what process the PTY hosts. Omitted → host the user's
 * default login shell (Phase 1 behavior). Present → spawn `cmd` with `args` as
 * the PTY's foreground process, used by spawn-CLI agent launches so closing
 * the pane terminates the agent rather than just one shell among many.
 */
export const PtyCommand = Schema.Struct({
	cmd: Schema.String,
	args: Schema.Array(Schema.String),
	env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type PtyCommand = typeof PtyCommand.Type;

export const PtyOpenRpc = Rpc.make("pty.open", {
	payload: Schema.Struct({
		cwd: Schema.String,
		cols: Schema.Number,
		rows: Schema.Number,
		command: Schema.optional(PtyCommand),
		mobileOwnership: Schema.optional(PtyMobileOwnership),
	}),
	success: Schema.Struct({ ptyId: PtyId }),
	error: Schema.Union([PtySpawnError, PtyOwnerLimitError]),
});

export const PtyListRpc = Rpc.make("pty.list", {
	payload: Schema.Struct({ ownerId: Schema.String }),
	success: Schema.Array(PtySummary),
	error: Schema.Never,
});

export const PtyWriteRpc = Rpc.make("pty.write", {
	payload: Schema.Struct({
		ptyId: PtyId,
		data: Schema.String,
		ownerId: Schema.optional(Schema.String),
	}),
	success: Schema.Void,
	error: Schema.Union([PtyNotFoundError, PtyOwnerMismatchError]),
});

export const PtyResizeRpc = Rpc.make("pty.resize", {
	payload: Schema.Struct({
		ptyId: PtyId,
		cols: Schema.Number,
		rows: Schema.Number,
		ownerId: Schema.optional(Schema.String),
	}),
	success: Schema.Void,
	error: Schema.Union([PtyNotFoundError, PtyOwnerMismatchError]),
});

export const PtyCloseRpc = Rpc.make("pty.close", {
	payload: Schema.Struct({
		ptyId: PtyId,
		ownerId: Schema.optional(Schema.String),
	}),
	success: Schema.Void,
	error: Schema.Union([PtyNotFoundError, PtyOwnerMismatchError]),
});

export const PtyOutputRpc = Rpc.make("pty.output", {
	payload: Schema.Struct({
		ptyId: PtyId,
		afterSequence: Schema.optional(Schema.Number),
		ownerId: Schema.optional(Schema.String),
	}),
	success: PtyEvent,
	error: Schema.Union([PtyNotFoundError, PtyOwnerMismatchError]),
	stream: true,
});
