import { randomUUID } from "node:crypto";
import {
  AttachmentService,
  type AttachmentServiceShape,
} from "@zuse/agents/kernel/attachment-service";
import { AttachmentTooLargeError, ContextWriteError } from "@zuse/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { AppPaths } from "../../app-paths.ts";
import {
  ensureContextFilesDir,
  resolveSessionCwd,
} from "../../context/context-files.ts";
import { extForUpload } from "../image-mime.ts";

/**
 * Per-attachment cap, validated client-side and re-validated here. Matches
 * the spec — see `specs/0.03-MVP/features/composer.md` "Attachments".
 */
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const sessionSegment = (sessionId: string): string =>
  sessionId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(0, 80);

/**
 * Legacy flat blob directory under userData. New uploads land in the
 * workspace's `.context/files/`, but this is still used (a) as a fallback
 * when a session's cwd cannot be resolved and (b) to resolve pre-migration
 * rows whose `abs_path` is NULL.
 */
const legacyAttachmentsDir = (userData: string, pathSvc: Path.Path): string =>
  pathSvc.join(userData, "attachments");

const blobFilename = (id: string, ext: string): string => `${id}.${ext}`;

const sanitizeExt = (ext: string): string =>
  ext.replace(/[^a-zA-Z0-9]+/g, "").slice(0, 12) || "txt";

export const AttachmentServiceLive = Layer.effect(
  AttachmentService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const { userData } = yield* AppPaths;

    const legacyDir = legacyAttachmentsDir(userData, pathSvc);

    const upload: AttachmentServiceShape["upload"] = (
      sessionId,
      bytes,
      mimeType,
      originalName,
      rootPath,
    ) =>
      Effect.gen(function* () {
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
          return yield* Effect.fail(
            new AttachmentTooLargeError({
              sessionId,
              sizeBytes: bytes.byteLength,
              limit: MAX_ATTACHMENT_BYTES,
            }),
          );
        }

        // Bytes land in the workspace's gitignored `.context/files/` so they
        // sit inside the agent's cwd rather than hidden app data. When the
        // cwd can't be resolved (e.g. an orphaned session id) we fall back to
        // the legacy userData directory so the upload never hard-fails.
        const cwd = yield* resolveSessionCwd(sql, sessionId, rootPath);
        let dir: string;
        if (cwd === null) {
          dir = legacyDir;
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie);
        } else {
          dir = yield* ensureContextFilesDir(fs, pathSvc, cwd);
        }

        const id = `${sessionSegment(sessionId)}-${randomUUID()}`;
        const ext = extForUpload(mimeType, originalName);
        const absPath = pathSvc.join(dir, blobFilename(id, ext));

        yield* fs.writeFile(absPath, bytes).pipe(Effect.orDie);

        const now = new Date().toISOString();
        yield* sql`
          INSERT INTO attachments (
            id, session_id, mime_type, size_bytes, original_name, created_at,
            abs_path
          )
          VALUES (
            ${id}, ${sessionId as string}, ${mimeType}, ${bytes.byteLength},
            ${originalName}, ${now}, ${absPath}
          )
        `.pipe(Effect.orDie);

        return {
          id,
          sizeBytes: bytes.byteLength,
          mimeType,
          ext,
        };
      });

    const saveText: AttachmentServiceShape["saveText"] = (
      sessionId,
      text,
      ext,
      rootPath,
    ) =>
      Effect.gen(function* () {
        const cwd = yield* resolveSessionCwd(sql, sessionId, rootPath);
        if (cwd === null) {
          return yield* Effect.fail(
            new ContextWriteError({
              sessionId,
              reason: "Could not resolve a workspace root for this session.",
            }),
          );
        }
        const dir = yield* ensureContextFilesDir(fs, pathSvc, cwd);
        const name = `paste-${randomUUID()}.${sanitizeExt(ext)}`;
        const absPath = pathSvc.join(dir, name);
        yield* fs.writeFileString(absPath, text).pipe(Effect.orDie);
        const relPath = pathSvc.relative(cwd, absPath);
        return { relPath, absPath };
      });

    interface AttachmentMetaRow {
      readonly mime_type: string;
      readonly original_name: string;
      readonly abs_path: string | null;
    }

    const resolveAttachmentPath = (id: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<AttachmentMetaRow>`
          SELECT mime_type, original_name, abs_path
          FROM attachments WHERE id = ${id}
        `.pipe(
          Effect.orElseSucceed(() => [] as ReadonlyArray<AttachmentMetaRow>),
        );
        const row = rows[0];
        if (row === undefined) return null;
        // Pre-migration rows have no `abs_path`; reconstruct the legacy
        // flat-dir path from the id + extension.
        const absPath =
          row.abs_path ??
          pathSvc.join(
            legacyDir,
            blobFilename(id, extForUpload(row.mime_type, row.original_name)),
          );
        return { absPath, mimeType: row.mime_type };
      });

    const read: AttachmentServiceShape["read"] = (id) =>
      Effect.gen(function* () {
        const resolved = yield* resolveAttachmentPath(id);
        if (resolved === null) return null;
        const bytes = yield* fs
          .readFile(resolved.absPath)
          .pipe(Effect.orElseSucceed(() => null));
        if (bytes === null) return null;
        return { bytes, mimeType: resolved.mimeType };
      });

    const readPath: AttachmentServiceShape["readPath"] = (id) =>
      Effect.gen(function* () {
        const resolved = yield* resolveAttachmentPath(id);
        if (resolved === null) return null;
        const exists = yield* fs
          .exists(resolved.absPath)
          .pipe(Effect.orElseSucceed(() => false));
        if (!exists) return null;
        return { path: resolved.absPath, mimeType: resolved.mimeType };
      });

    return {
      upload,
      saveText,
      read,
      readPath,
    } satisfies AttachmentServiceShape;
  }),
);
