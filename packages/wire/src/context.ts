import { Rpc } from "@effect/rpc";
import { Schema } from "effect";

import { SessionId } from "./session.ts";

/**
 * Raised when the server cannot figure out where to write a context file —
 * e.g. the session row is gone and no fallback workspace root was supplied.
 */
export class ContextWriteError extends Schema.TaggedError<ContextWriteError>()(
  "ContextWriteError",
  {
    sessionId: SessionId,
    reason: Schema.String,
  },
) {}

/**
 * Persist a chunk of text as a file under the workspace's gitignored
 * `.context/files/` directory and hand back its paths. The renderer uses
 * this when a large paste would otherwise flood the composer: instead of
 * inlining the text it drops a `@.context/files/paste-<uuid>.md` file chip,
 * which flows through the normal `FileRef` pipeline so the agent reads the
 * file from its own cwd.
 *
 * `rootPath` is an optional fallback workspace root the renderer already
 * knows (`useActiveWorkspaceRoot`). The server prefers to resolve the cwd
 * from `sessionId`, but for a brand-new chat whose session row does not
 * exist yet the fallback keeps paste-to-file working.
 */
export const ContextSaveTextRpc = Rpc.make("context.saveText", {
  payload: Schema.Struct({
    sessionId: SessionId,
    text: Schema.String,
    ext: Schema.String,
    rootPath: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    relPath: Schema.String,
    absPath: Schema.String,
  }),
  error: ContextWriteError,
});
