import { Context, type Effect } from "effect";

import type {
  AttachmentBadMimeError,
  AttachmentTooLargeError,
  ContextWriteError,
  SessionId,
  SessionNotFoundError,
} from "@zuse/wire";

export type UploadFailure =
  | AttachmentTooLargeError
  | AttachmentBadMimeError
  | SessionNotFoundError;

export interface AttachmentServiceShape {
  readonly upload: (
    sessionId: SessionId,
    bytes: Uint8Array,
    mimeType: string,
    originalName: string,
    rootPath?: string,
  ) => Effect.Effect<
    {
      readonly id: string;
      readonly sizeBytes: number;
      readonly mimeType: string;
      readonly ext: string;
    },
    UploadFailure
  >;
  /**
   * Persist raw text as a file under the workspace's `.context/files/`
   * directory and return its workspace-relative + absolute paths. Backs the
   * `context.saveText` RPC (big-paste-to-file).
   */
  readonly saveText: (
    sessionId: SessionId,
    text: string,
    ext: string,
    rootPath?: string,
  ) => Effect.Effect<
    { readonly relPath: string; readonly absPath: string },
    ContextWriteError
  >;
  readonly read: (
    id: string,
  ) => Effect.Effect<
    { readonly bytes: Uint8Array; readonly mimeType: string } | null
  >;
  /**
   * Resolve an attachment to its on-disk absolute path. The codex SDK's
   * `local_image` input shape requires a path, not bytes — exposing the
   * file directly avoids an extra read/write round-trip on every turn.
   * Returns `null` when the row or file is gone (same shape as `read`).
   */
  readonly readPath: (
    id: string,
  ) => Effect.Effect<
    { readonly path: string; readonly mimeType: string } | null
  >;
}

export class AttachmentService extends Context.Service<
  AttachmentService,
  AttachmentServiceShape
>()("memoize/AttachmentService") {}
