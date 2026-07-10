import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

import { SessionId, SessionNotFoundError } from "./session.ts";

export class AttachmentTooLargeError extends Schema.TaggedErrorClass<AttachmentTooLargeError>()(
  "AttachmentTooLargeError",
  {
    sessionId: SessionId,
    sizeBytes: Schema.Number,
    limit: Schema.Number,
  },
) {}

export class AttachmentBadMimeError extends Schema.TaggedErrorClass<AttachmentBadMimeError>()(
  "AttachmentBadMimeError",
  {
    sessionId: SessionId,
    mimeType: Schema.String,
  },
) {}

/**
 * Upload an image attachment for a session. Bytes land in the workspace's
 * gitignored `.context/files/` directory; the returned id is what the
 * renderer stores on `ComposerInput.attachments` and renders via
 * `zuse://attachments/<id>`.
 *
 * `rootPath` is an optional fallback workspace root the renderer already
 * knows. The server prefers to resolve the cwd from `sessionId`, but for a
 * brand-new chat whose session row does not exist yet the fallback keeps
 * drop/paste working; when neither resolves, the upload falls back to the
 * legacy userData attachments directory.
 */
export const AttachmentUploadRpc = Rpc.make("attachments.upload", {
  payload: Schema.Struct({
    sessionId: SessionId,
    bytes: Schema.Uint8ArrayFromBase64,
    mimeType: Schema.String,
    originalName: Schema.String,
    rootPath: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    id: Schema.String,
    sizeBytes: Schema.Number,
    mimeType: Schema.String,
    ext: Schema.String,
  }),
  error: Schema.Union([
    AttachmentTooLargeError,
    AttachmentBadMimeError,
    SessionNotFoundError,
  ]),
});
