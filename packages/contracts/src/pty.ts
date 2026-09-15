import { Effect, Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

import { PtyId, PtyOwnerId } from "./ids.ts";

export const LEGACY_PTY_PROCESS_EPOCH = "legacy";

// POSIX winsize fields are unsigned 16-bit integers. Keeping the wire value in
// that exact domain prevents node-pty from truncating a dimension while the
// catalog continues to advertise the caller's fractional/out-of-range value.
const PtyDimension = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThan(0),
	Schema.isLessThan(65_536),
);

// Output positions are monotonic counters and must remain exactly representable
// across JSON and JavaScript clients.
const PtySequence = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0),
);

const LegacyCompatibleProcessEpoch = Schema.String.pipe(
	Schema.withDecodingDefaultKey(Effect.succeed(LEGACY_PTY_PROCESS_EPOCH)),
	Schema.withConstructorDefault(Effect.succeed(LEGACY_PTY_PROCESS_EPOCH)),
);

/**
 * Output emitted by a live PTY. The stream completes after the `exit` event;
 * renderers should treat that as a terminal-closed signal.
 */
export const PtyDataEvent = Schema.TaggedStruct("data", {
	processEpoch: LegacyCompatibleProcessEpoch,
	sequence: PtySequence,
	bytes: Schema.String,
});

export const PtyExitEvent = Schema.TaggedStruct("exit", {
	processEpoch: LegacyCompatibleProcessEpoch,
	sequence: PtySequence,
	exitCode: Schema.NullOr(Schema.Number),
	signal: Schema.NullOr(Schema.Number),
});

export const PtyCursorEvent = Schema.TaggedStruct("cursor", {
	processEpoch: LegacyCompatibleProcessEpoch,
	sequence: PtySequence,
});

export const PtyGapEvent = Schema.TaggedStruct("gap", {
	processEpoch: LegacyCompatibleProcessEpoch,
	requestedAfter: PtySequence,
	earliestAvailable: PtySequence,
	latestAvailable: PtySequence,
});

/** Explicitly marks replacement of the process behind a stable PtyId. */
export const PtyEpochEvent = Schema.TaggedStruct("epoch", {
	processEpoch: Schema.String,
	sequence: Schema.Literal(0),
});

export const PtyEvent = Schema.Union([
	PtyDataEvent,
	PtyExitEvent,
	PtyCursorEvent,
	PtyGapEvent,
	PtyEpochEvent,
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
		ownerId: PtyOwnerId,
		limit: Schema.Number,
	},
) {}

export class PtyOwnerMismatchError extends Schema.TaggedErrorClass<PtyOwnerMismatchError>()(
	"PtyOwnerMismatchError",
	{ ptyId: PtyId },
) {}

export const PtyScope = Schema.Literals(["session", "environment"]);
export type PtyScope = typeof PtyScope.Type;

export const PtyOpenToken = Schema.Trim.check(
	Schema.isNonEmpty(),
	Schema.isMaxLength(128),
).pipe(Schema.brand("PtyOpenToken"));
export type PtyOpenToken = typeof PtyOpenToken.Type;

export class PtyOpenConflictError extends Schema.TaggedErrorClass<PtyOpenConflictError>()(
	"PtyOpenConflictError",
	{
		ownerId: PtyOwnerId,
		openToken: PtyOpenToken,
		ptyId: PtyId,
		reason: Schema.Literal("launch-mismatch"),
	},
) {}

const NullablePtyOpenTokenWithDefault = Schema.NullOr(PtyOpenToken).pipe(
	Schema.withDecodingDefaultKey(Effect.succeed(null)),
	Schema.withConstructorDefault(Effect.succeed(null)),
);

/**
 * Catalog ownership for a logical terminal. `openToken` is scoped to `ownerId`
 * and makes repeated opens idempotent: callers must reuse the original cwd,
 * command, and scope; the first label remains authoritative while dimensions
 * reconcile to the latest request. Omitting it preserves legacy spawn-per-call
 * behavior.
 */
export class PtyOwnership extends Schema.Class<PtyOwnership>("PtyOwnership")({
	ownerId: PtyOwnerId,
	label: Schema.optional(Schema.String),
	scope: Schema.optional(PtyScope),
	openToken: Schema.optional(PtyOpenToken),
}) {}

export const PtyStatus = Schema.Literals(["running", "exited"]);
export type PtyStatus = typeof PtyStatus.Type;

export class PtySummary extends Schema.Class<PtySummary>("PtySummary")({
	ptyId: PtyId,
	cwd: Schema.String,
	label: Schema.NullOr(Schema.String),
	scope: PtyScope,
	status: PtyStatus,
	cols: PtyDimension,
	rows: PtyDimension,
	processEpoch: LegacyCompatibleProcessEpoch,
	latestOutputSequence: PtySequence,
	openToken: NullablePtyOpenTokenWithDefault,
}) {}

export class PtyCatalog extends Schema.Class<PtyCatalog>("PtyCatalog")({
	terminals: Schema.Array(PtySummary),
	liveLimit: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
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
		cols: PtyDimension,
		rows: PtyDimension,
		command: Schema.optional(PtyCommand),
		ownership: Schema.optional(PtyOwnership),
	}),
	success: Schema.Struct({
		ptyId: PtyId,
		processEpoch: LegacyCompatibleProcessEpoch,
	}),
	error: Schema.Union([
		PtySpawnError,
		PtyOwnerLimitError,
		PtyOpenConflictError,
	]),
});

export const PtyListRpc = Rpc.make("pty.list", {
	payload: Schema.Struct({
		ownerId: PtyOwnerId,
		/** New clients opt into policy metadata; omission preserves old clients. */
		includePolicy: Schema.optional(Schema.Boolean),
	}),
	success: Schema.Union([PtyCatalog, Schema.Array(PtySummary)]),
	error: Schema.Never,
});

export const PtyWriteRpc = Rpc.make("pty.write", {
	payload: Schema.Struct({
		ptyId: PtyId,
		data: Schema.String,
		ownerId: Schema.optional(PtyOwnerId),
	}),
	success: Schema.Void,
	error: Schema.Union([PtyNotFoundError, PtyOwnerMismatchError]),
});

export const PtyResizeRpc = Rpc.make("pty.resize", {
	payload: Schema.Struct({
		ptyId: PtyId,
		cols: PtyDimension,
		rows: PtyDimension,
		ownerId: Schema.optional(PtyOwnerId),
	}),
	success: Schema.Void,
	error: Schema.Union([PtyNotFoundError, PtyOwnerMismatchError]),
});

export const PtyCloseRpc = Rpc.make("pty.close", {
	payload: Schema.Struct({
		ptyId: PtyId,
		ownerId: Schema.optional(PtyOwnerId),
	}),
	success: Schema.Void,
	error: Schema.Union([PtyNotFoundError, PtyOwnerMismatchError]),
});

export const PtyCloseOwnedRpc = Rpc.make("pty.closeOwned", {
	payload: Schema.Struct({ ownerId: PtyOwnerId }),
	success: Schema.Struct({ closed: Schema.Number }),
	error: Schema.Never,
});

export const PtyRenameRpc = Rpc.make("pty.rename", {
	payload: Schema.Struct({
		ptyId: PtyId,
		label: Schema.NullOr(Schema.String),
		ownerId: Schema.optional(PtyOwnerId),
	}),
	success: PtySummary,
	error: Schema.Union([PtyNotFoundError, PtyOwnerMismatchError]),
});

export const PtyRestartRpc = Rpc.make("pty.restart", {
	payload: Schema.Struct({
		ptyId: PtyId,
		ownerId: Schema.optional(PtyOwnerId),
		/**
		 * Makes restart a compare-and-set desired-state command. If the process is
		 * already on another epoch, a replay returns that epoch without spawning.
		 */
		expectedProcessEpoch: Schema.optional(Schema.String),
	}),
	success: Schema.Struct({ ptyId: PtyId, processEpoch: Schema.String }),
	error: Schema.Union([
		PtyNotFoundError,
		PtyOwnerMismatchError,
		PtySpawnError,
		PtyOwnerLimitError,
	]),
});

export const PtyOutputRpc = Rpc.make("pty.output", {
	payload: Schema.Struct({
		ptyId: PtyId,
		afterSequence: Schema.optional(PtySequence),
		// Optional so pre-epoch clients can continue subscribing during rollout.
		processEpoch: Schema.optional(Schema.String),
		ownerId: Schema.optional(PtyOwnerId),
	}),
	success: PtyEvent,
	error: Schema.Union([PtyNotFoundError, PtyOwnerMismatchError]),
	stream: true,
});
