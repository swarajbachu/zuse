import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

import { FolderId, WorktreeId } from "./ids.ts";

/**
 * One entry in a directory listing — either a file or a subdirectory. The
 * `path` is forward-slash, project-root-relative; the right-pane file tree
 * uses it as both the React key and the payload for the next `fs.tree` call
 * when the user expands a directory.
 */
export class FsEntry extends Schema.Class<FsEntry>("FsEntry")({
  name: Schema.String,
  path: Schema.String,
  kind: Schema.Literals(["file", "directory"]),
}) {}

export class FsFolderNotFoundError extends Schema.TaggedErrorClass<FsFolderNotFoundError>()(
  "FsFolderNotFoundError",
  { folderId: FolderId },
) {}

export class FsPathOutsideError extends Schema.TaggedErrorClass<FsPathOutsideError>()(
  "FsPathOutsideError",
  { folderId: FolderId, path: Schema.String },
) {}

export class FsReadError extends Schema.TaggedErrorClass<FsReadError>()(
  "FsReadError",
  { folderId: FolderId, path: Schema.String, reason: Schema.String },
) {}

export class FsAlreadyExistsError extends Schema.TaggedErrorClass<FsAlreadyExistsError>()(
  "FsAlreadyExistsError",
  { folderId: FolderId, path: Schema.String },
) {}

export class FsTooLargeError extends Schema.TaggedErrorClass<FsTooLargeError>()(
  "FsTooLargeError",
  { folderId: FolderId, path: Schema.String, size: Schema.Number, limit: Schema.Number },
) {}

export class FsConflictError extends Schema.TaggedErrorClass<FsConflictError>()(
  "FsConflictError",
  {
    folderId: FolderId,
    path: Schema.String,
    expectedMtime: Schema.String,
    actualMtime: Schema.String,
  },
) {}

// External-file errors mirror the in-folder ones but key off an absolute
// `path` instead of a `folderId` — the `fs.*ExternalFile` RPCs operate
// outside any project folder, so there's no folder id to carry.
export class FsExternalReadError extends Schema.TaggedErrorClass<FsExternalReadError>()(
  "FsExternalReadError",
  { path: Schema.String, reason: Schema.String },
) {}

export class FsExternalTooLargeError extends Schema.TaggedErrorClass<FsExternalTooLargeError>()(
  "FsExternalTooLargeError",
  { path: Schema.String, size: Schema.Number, limit: Schema.Number },
) {}

export class FsExternalConflictError extends Schema.TaggedErrorClass<FsExternalConflictError>()(
  "FsExternalConflictError",
  {
    path: Schema.String,
    expectedMtime: Schema.String,
    actualMtime: Schema.String,
  },
) {}

const FsErrors = Schema.Union([
  FsFolderNotFoundError,
  FsPathOutsideError,
  FsReadError,
]);

const FsReadExternalFileErrors = Schema.Union([
  FsExternalReadError,
  FsExternalTooLargeError,
]);

const FsWriteExternalFileErrors = Schema.Union([
  FsExternalReadError,
  FsExternalTooLargeError,
  FsExternalConflictError,
]);

const FsReadFileErrors = Schema.Union([
  FsFolderNotFoundError,
  FsPathOutsideError,
  FsReadError,
  FsTooLargeError,
]);

const FsWriteFileErrors = Schema.Union([
  FsFolderNotFoundError,
  FsPathOutsideError,
  FsReadError,
  FsConflictError,
  FsTooLargeError,
]);

const FsCreateErrors = Schema.Union([
  FsFolderNotFoundError,
  FsPathOutsideError,
  FsReadError,
  FsAlreadyExistsError,
]);

/**
 * List one directory level. `path` is project-root-relative (use "" or omit
 * for the root). The right-pane tree calls this lazily as the user expands
 * directories — no recursive walk on the server. Skips `.git` and
 * `node_modules`; everything else is returned, sorted dirs-first then by name.
 */
export const FsTreeRpc = Rpc.make("fs.tree", {
  payload: Schema.Struct({
    folderId: FolderId,
    path: Schema.optional(Schema.String),
    /**
     * When set, list inside the worktree's path instead of the project's
     * main checkout. The worktree must belong to `folderId`; otherwise the
     * server falls back to the main checkout silently.
     */
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Array(FsEntry),
  error: FsErrors,
});

/**
 * Live stream of filesystem changes under the current project/worktree root.
 * Emits debounced batches of forward-slash, project-relative paths so the
 * renderer can refresh only the open tree branches affected by disk changes.
 */
export const FsWatchTreeRpc = Rpc.make("fs.watchTree", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({
    paths: Schema.Array(Schema.String),
  }),
  error: FsErrors,
  stream: true,
});

/**
 * The shape returned by `fs.readFile`. Text files come back with their
 * UTF-8 contents and the modification time used as an optimistic-concurrency
 * token by `fs.writeFile`. Files that fail UTF-8 decoding return their bytes as
 * `kind: "binary"` so supported formats can be previewed without another read.
 */
export const FsFileContent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    content: Schema.String,
    mtime: Schema.String,
    size: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("binary"),
    bytes: Schema.Uint8ArrayFromBase64,
    size: Schema.Number,
  }),
]);

/**
 * Read a single file's contents. Path is project-root-relative. Files
 * larger than the server-side cap (5 MB) reject with `FsTooLargeError`;
 * non-UTF-8 files come back as `kind: "binary"`. The renderer file editor
 * stores the returned `mtime` and passes it back on `fs.writeFile` so the
 * server can reject writes when the file changed on disk underneath us.
 */
export const FsReadFileRpc = Rpc.make("fs.readFile", {
  payload: Schema.Struct({
    folderId: FolderId,
    path: Schema.String,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: FsFileContent,
  error: FsReadFileErrors,
});

/**
 * Write a single file. `expectedMtime` is the mtime the renderer received
 * from the most recent `fs.readFile` (or the most recent successful write).
 * If the file's mtime on disk no longer matches, the server rejects with
 * `FsConflictError` and the renderer surfaces a "file changed on disk"
 * toast. Same 5 MB cap applies to incoming content.
 */
export const FsWriteFileRpc = Rpc.make("fs.writeFile", {
  payload: Schema.Struct({
    folderId: FolderId,
    path: Schema.String,
    content: Schema.String,
    expectedMtime: Schema.String,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({
    mtime: Schema.String,
  }),
  error: FsWriteFileErrors,
});

/**
 * Create an empty file inside the project/worktree root. Fails if the target
 * already exists; parent directories must already exist.
 */
export const FsCreateFileRpc = Rpc.make("fs.createFile", {
  payload: Schema.Struct({
    folderId: FolderId,
    path: Schema.String,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({}),
  error: FsCreateErrors,
});

/**
 * Create a single directory inside the project/worktree root. Fails if the
 * target already exists; parent directories must already exist.
 */
export const FsCreateDirectoryRpc = Rpc.make("fs.createDirectory", {
  payload: Schema.Struct({
    folderId: FolderId,
    path: Schema.String,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({}),
  error: FsCreateErrors,
});

/**
 * Remove a file or directory tree inside the project/worktree root. This is
 * intentionally scoped to the same project-relative path validation as every
 * other local fs RPC.
 */
export const FsRemoveRpc = Rpc.make("fs.remove", {
  payload: Schema.Struct({
    folderId: FolderId,
    path: Schema.String,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({}),
  error: FsErrors,
});

/**
 * List every file path under the project/worktree root in one shot, for the
 * path-first `@pierre/trees` file tree (which wants the full path universe up
 * front and virtualizes the visible window itself). Paths are forward-slash,
 * project-root-relative, dirs-first-then-name sorted. Skips `.git`,
 * `node_modules`, and other noise dirs. Capped at `MAX_TREE_PATHS`; once the
 * cap is hit, `truncated` is `true` and the list stops early.
 */
export const FsListPathsRpc = Rpc.make("fs.listPaths", {
  payload: Schema.Struct({
    folderId: FolderId,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({
    paths: Schema.Array(Schema.String),
    truncated: Schema.Boolean,
  }),
  error: FsErrors,
});

/**
 * Rename/move a file or directory inside the project/worktree root. Powers the
 * file tree's inline rename and drag-and-drop. Both paths are project-relative
 * and validated for containment; fails if the destination already exists.
 */
export const FsMoveRpc = Rpc.make("fs.move", {
  payload: Schema.Struct({
    folderId: FolderId,
    fromPath: Schema.String,
    toPath: Schema.String,
    worktreeId: Schema.optional(Schema.NullOr(WorktreeId)),
  }),
  success: Schema.Struct({}),
  error: FsCreateErrors,
});

/**
 * Read a file by absolute path, outside any project folder — backs opening
 * agent-written plan/markdown files that live elsewhere on disk. Same UTF-8
 * decode, 5 MB cap, and `mtime` concurrency token as `fs.readFile`.
 * Deliberately not sandboxed to a folder: a local desktop app reading a file
 * the user explicitly opened.
 */
export const FsReadExternalFileRpc = Rpc.make("fs.readExternalFile", {
  payload: Schema.Struct({
    path: Schema.String,
  }),
  success: FsFileContent,
  error: FsReadExternalFileErrors,
});

/**
 * Write a file by absolute path. Same optimistic-concurrency (`expectedMtime`)
 * and 5 MB cap as `fs.writeFile`. Pairs with `fs.readExternalFile` for editing
 * files outside the workspace.
 */
export const FsWriteExternalFileRpc = Rpc.make("fs.writeExternalFile", {
  payload: Schema.Struct({
    path: Schema.String,
    content: Schema.String,
    expectedMtime: Schema.String,
  }),
  success: Schema.Struct({
    mtime: Schema.String,
  }),
  error: FsWriteExternalFileErrors,
});
