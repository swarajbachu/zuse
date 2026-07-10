import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

import { PtyId } from "./ids.ts";

/**
 * Output emitted by a live PTY. The stream completes after the `exit` event;
 * renderers should treat that as a terminal-closed signal.
 */
export const PtyDataEvent = Schema.TaggedStruct("data", {
  bytes: Schema.String,
});

export const PtyExitEvent = Schema.TaggedStruct("exit", {
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.Number),
});

export const PtyEvent = Schema.Union([PtyDataEvent, PtyExitEvent]);

export class PtyNotFoundError extends Schema.TaggedErrorClass<PtyNotFoundError>()(
  "PtyNotFoundError",
  { ptyId: PtyId },
) {}

export class PtySpawnError extends Schema.TaggedErrorClass<PtySpawnError>()(
  "PtySpawnError",
  { reason: Schema.String },
) {}

/**
 * Optional override for what process the PTY hosts. Omitted → host the user's
 * default login shell (Phase 1 behavior). Present → spawn `cmd` with `args` as
 * the PTY's foreground process, used by spawn-CLI agent launches so closing
 * the pane terminates the agent rather than just one shell among many.
 */
export const PtyCommand = Schema.Struct({
  cmd: Schema.String,
  args: Schema.Array(Schema.String),
  env: Schema.optional(
    Schema.Record(Schema.String, Schema.String ),
  ),
});
export type PtyCommand = typeof PtyCommand.Type;

export const PtyOpenRpc = Rpc.make("pty.open", {
  payload: Schema.Struct({
    cwd: Schema.String,
    cols: Schema.Number,
    rows: Schema.Number,
    command: Schema.optional(PtyCommand),
  }),
  success: Schema.Struct({ ptyId: PtyId }),
  error: PtySpawnError,
});

export const PtyWriteRpc = Rpc.make("pty.write", {
  payload: Schema.Struct({ ptyId: PtyId, data: Schema.String }),
  success: Schema.Void,
  error: PtyNotFoundError,
});

export const PtyResizeRpc = Rpc.make("pty.resize", {
  payload: Schema.Struct({
    ptyId: PtyId,
    cols: Schema.Number,
    rows: Schema.Number,
  }),
  success: Schema.Void,
  error: PtyNotFoundError,
});

export const PtyCloseRpc = Rpc.make("pty.close", {
  payload: Schema.Struct({ ptyId: PtyId }),
  success: Schema.Void,
  error: PtyNotFoundError,
});

export const PtyOutputRpc = Rpc.make("pty.output", {
  payload: Schema.Struct({ ptyId: PtyId }),
  success: PtyEvent,
  error: PtyNotFoundError,
  stream: true,
});
