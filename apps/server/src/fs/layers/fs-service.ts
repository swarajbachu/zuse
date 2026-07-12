import { watch } from "node:fs";
import * as path from "node:path";

import { FileSystem, Path } from "effect";
import { Effect, Layer, Option, Queue, Stream } from "effect";

import {
  FsAlreadyExistsError,
  FsConflictError,
  FsEntry,
  FsExternalConflictError,
  FsExternalReadError,
  FsExternalTooLargeError,
  FsFolderNotFoundError,
  FsPathOutsideError,
  FsReadError,
  FsTooLargeError,
  type FolderId,
  type WorktreeId,
} from "@zuse/contracts";

import { WorkspaceService } from "../../workspace/services/workspace-service.ts";
import { WorktreeService } from "@zuse/git/worktree-service";
import { FsService } from "../services/fs-service.ts";

// Skip directories that are large, irrelevant, or just noise in a code-tree
// view. Match by basename. Hidden dotfiles other than `.git` still show up —
// users often want to see `.env`, `.github/`, `.vscode/`, etc.
const SKIP_DIRS = new Set([".git", "node_modules", ".zuse", ".DS_Store"]);
const WATCH_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".zuse",
  ".DS_Store",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".cache",
  "coverage",
  "out",
]);
const WATCH_DEBOUNCE_MS = 120;

// Cap how much we'll ship across the RPC for a single file. Anything larger
// surfaces as `FsTooLargeError` so the editor can render a placeholder
// instead of trying to load gigabytes into a CodeMirror buffer.
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const toForwardSlash = (p: string): string =>
  path.sep === "/" ? p : p.split(path.sep).join("/");

const parentPathOf = (p: string): string => {
  const normalized = p.replace(/\/+$/g, "");
  const idx = normalized.lastIndexOf("/");
  return idx === -1 ? "" : normalized.slice(0, idx);
};

const isSkippedWatchPath = (relPath: string): boolean => {
  const first = toForwardSlash(relPath).split("/")[0] ?? "";
  return WATCH_SKIP_DIRS.has(first);
};

const mtimeToString = (mtime: Option.Option<Date>): string =>
  Option.match(mtime, {
    onNone: () => "",
    onSome: (d) => d.toISOString(),
  });

export const FsServiceLive = Layer.effect(
  FsService,
  Effect.gen(function* () {
    const workspace = yield* WorkspaceService;
    const worktrees = yield* WorktreeService;
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;

    // Resolve a project-root-relative request path to an absolute path,
    // failing with the appropriate wire error if the folder is unknown or
    // the path escapes the project root. When `worktreeId` is set and the
    // worktree belongs to `folderId`, root-swaps to the worktree's path so
    // every fs surface (tree / read / write) follows the active session.
    // Shared by tree / readFile / writeFile so path-validation lives in
    // exactly one place.
    const resolveInsideFolder = (
      folderId: FolderId,
      relPath: string,
      worktreeId?: WorktreeId | null,
    ) =>
      Effect.gen(function* () {
        const folder = yield* workspace.findById(folderId);
        if (folder === null) {
          return yield* Effect.fail(new FsFolderNotFoundError({ folderId }));
        }
        let rootPath = folder.path;
        if (worktreeId) {
          const wt = yield* worktrees.get(worktreeId);
          if (wt !== null && wt.projectId === folderId) rootPath = wt.path;
        }
        const rootAbs = pathSvc.resolve(rootPath);
        const requestedAbs = pathSvc.resolve(rootAbs, relPath);
        const rel = pathSvc.relative(rootAbs, requestedAbs);
        if (rel.startsWith("..") || pathSvc.isAbsolute(rel)) {
          return yield* Effect.fail(
            new FsPathOutsideError({ folderId, path: relPath }),
          );
        }
        return { rootAbs, requestedAbs } as const;
      });

    const tree: FsService["Service"]["tree"] = (folderId, relPath, worktreeId) =>
      Effect.gen(function* () {
        const { requestedAbs } = yield* resolveInsideFolder(
          folderId,
          relPath,
          worktreeId,
        );

        const names = yield* fs.readDirectory(requestedAbs).pipe(
          Effect.mapError(
            (cause) =>
              new FsReadError({
                folderId,
                path: relPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );

        // Stat every entry in parallel — sequential stats blow up for any
        // folder with more than a few dozen files. A failed stat (broken
        // symlink, racey delete) just drops that entry so one bad child
        // doesn't blank the whole listing.
        const stats = yield* Effect.forEach(
          names,
          (name) =>
            Effect.gen(function* () {
              const entryAbs = pathSvc.join(requestedAbs, name);
              const stat = yield* fs.stat(entryAbs).pipe(Effect.option);
              if (stat._tag === "None") return null;
              const kind =
                stat.value.type === "Directory" ? "directory" : "file";
              if (kind === "directory" && SKIP_DIRS.has(name)) return null;
              const childRel = relPath === "" ? name : `${relPath}/${name}`;
              return FsEntry.make({
                name,
                path: toForwardSlash(childRel),
                kind,
              });
            }),
          { concurrency: "unbounded" },
        );

        const entries = stats.filter((e): e is FsEntry => e !== null);
        // Dirs first, then files; case-insensitive within each group.
        entries.sort((a, b) => {
          if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
          return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });
        return entries;
      });

    const watchTree: FsService["Service"]["watchTree"] = (folderId, worktreeId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const { rootAbs } = yield* resolveInsideFolder(
            folderId,
            "",
            worktreeId,
          );
          const queue = yield* Queue.unbounded<{ paths: ReadonlyArray<string> }>();

          let timer: ReturnType<typeof setTimeout> | null = null;
          const pending = new Set<string>();
          let handle: ReturnType<typeof watch> | null = null;

          const flush = () => {
            timer = null;
            if (pending.size === 0) return;
            const paths = Array.from(pending);
            pending.clear();
            void Effect.runPromise(Queue.offer(queue, { paths }));
          };

          const schedule = () => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
          };

          try {
            handle = watch(rootAbs, { recursive: true }, (_event, filename) => {
              if (filename === null) return;
              const rel = toForwardSlash(filename.toString());
              if (rel === "" || isSkippedWatchPath(rel)) return;
              pending.add(rel);
              pending.add(parentPathOf(rel));
              schedule();
            });
            handle.on("error", (err) => {
              // eslint-disable-next-line no-console
              console.warn("[fs.watchTree] fs.watch error:", err.message);
            });
          } catch (err) {
            // Some paths cannot be watched. Keep the stream open but empty so
            // the UI still works with manual/local refreshes.
            // eslint-disable-next-line no-console
            console.warn(
              `[fs.watchTree] could not watch ${rootAbs}: ${(err as Error).message}`,
            );
          }

          yield* Effect.addFinalizer(() =>
            Effect.andThen(
              Effect.sync(() => {
                if (timer !== null) {
                  clearTimeout(timer);
                  timer = null;
                }
                handle?.close();
              }),
              Queue.shutdown(queue),
            ),
          );

          return Stream.fromQueue(queue);
        }),
      );

    const readFile: FsService["Service"]["readFile"] = (
      folderId,
      relPath,
      worktreeId,
    ) =>
      Effect.gen(function* () {
        const { requestedAbs } = yield* resolveInsideFolder(
          folderId,
          relPath,
          worktreeId,
        );

        const stat = yield* fs.stat(requestedAbs).pipe(
          Effect.mapError(
            (cause) =>
              new FsReadError({
                folderId,
                path: relPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        const size = Number(stat.size);
        if (size > MAX_FILE_BYTES) {
          return yield* Effect.fail(
            new FsTooLargeError({
              folderId,
              path: relPath,
              size,
              limit: MAX_FILE_BYTES,
            }),
          );
        }

        const bytes = yield* fs.readFile(requestedAbs).pipe(
          Effect.mapError(
            (cause) =>
              new FsReadError({
                folderId,
                path: relPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );

        // Decode strict-UTF-8. A failure means the file is binary — return
        // it as such so the editor can render a placeholder instead of
        // garbage. We don't attempt other encodings.
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const content = decoder.decode(bytes);
          return {
            kind: "text" as const,
            content,
            mtime: mtimeToString(stat.mtime),
            size,
          };
        } catch {
          return { kind: "binary" as const, size };
        }
      });

    const writeFile: FsService["Service"]["writeFile"] = (
      folderId,
      relPath,
      content,
      expectedMtime,
      worktreeId,
    ) =>
      Effect.gen(function* () {
        const { requestedAbs } = yield* resolveInsideFolder(
          folderId,
          relPath,
          worktreeId,
        );

        const byteLen = new TextEncoder().encode(content).byteLength;
        if (byteLen > MAX_FILE_BYTES) {
          return yield* Effect.fail(
            new FsTooLargeError({
              folderId,
              path: relPath,
              size: byteLen,
              limit: MAX_FILE_BYTES,
            }),
          );
        }

        // Optimistic concurrency: the renderer holds the mtime from its
        // most recent read. If disk has moved since, refuse the write so
        // the user can decide whether to discard their edits and reload.
        const beforeStat = yield* fs.stat(requestedAbs).pipe(
          Effect.mapError(
            (cause) =>
              new FsReadError({
                folderId,
                path: relPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        const actualMtime = mtimeToString(beforeStat.mtime);
        if (actualMtime !== expectedMtime) {
          return yield* Effect.fail(
            new FsConflictError({
              folderId,
              path: relPath,
              expectedMtime,
              actualMtime,
            }),
          );
        }

        yield* fs.writeFileString(requestedAbs, content).pipe(
          Effect.mapError(
            (cause) =>
              new FsReadError({
                folderId,
                path: relPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );

        const afterStat = yield* fs.stat(requestedAbs).pipe(
          Effect.mapError(
            (cause) =>
              new FsReadError({
                folderId,
                path: relPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        return { mtime: mtimeToString(afterStat.mtime) };
      });

    const createFile: FsService["Service"]["createFile"] = (
      folderId,
      relPath,
      worktreeId,
    ) =>
      Effect.gen(function* () {
        const { requestedAbs } = yield* resolveInsideFolder(
          folderId,
          relPath,
          worktreeId,
        );
        const existing = yield* fs.stat(requestedAbs).pipe(Effect.option);
        if (existing._tag === "Some") {
          return yield* Effect.fail(
            new FsAlreadyExistsError({ folderId, path: relPath }),
          );
        }
        yield* fs.writeFileString(requestedAbs, "").pipe(
          Effect.mapError(
            (cause) =>
              new FsReadError({
                folderId,
                path: relPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        return {};
      });

    const createDirectory: FsService["Service"]["createDirectory"] = (
      folderId,
      relPath,
      worktreeId,
    ) =>
      Effect.gen(function* () {
        const { requestedAbs } = yield* resolveInsideFolder(
          folderId,
          relPath,
          worktreeId,
        );
        const existing = yield* fs.stat(requestedAbs).pipe(Effect.option);
        if (existing._tag === "Some") {
          return yield* Effect.fail(
            new FsAlreadyExistsError({ folderId, path: relPath }),
          );
        }
        yield* fs.makeDirectory(requestedAbs).pipe(
          Effect.mapError(
            (cause) =>
              new FsReadError({
                folderId,
                path: relPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        return {};
      });

    const remove: FsService["Service"]["remove"] = (
      folderId,
      relPath,
      worktreeId,
    ) =>
      Effect.gen(function* () {
        const { requestedAbs } = yield* resolveInsideFolder(
          folderId,
          relPath,
          worktreeId,
        );
        yield* fs.remove(requestedAbs, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new FsReadError({
                folderId,
                path: relPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        return {};
      });

    // External (outside-folder) read/write. Same decode / size-cap / mtime
    // concurrency as readFile/writeFile, but the path is absolute and there's
    // no folder containment check — deliberately so, to open files the agent
    // wrote elsewhere on disk. Errors key off `path` instead of `folderId`.
    const readExternal: FsService["Service"]["readExternal"] = (absPath) =>
      Effect.gen(function* () {
        const target = pathSvc.resolve(absPath);
        const stat = yield* fs.stat(target).pipe(
          Effect.mapError(
            (cause) =>
              new FsExternalReadError({
                path: absPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        const size = Number(stat.size);
        if (size > MAX_FILE_BYTES) {
          return yield* Effect.fail(
            new FsExternalTooLargeError({
              path: absPath,
              size,
              limit: MAX_FILE_BYTES,
            }),
          );
        }
        const bytes = yield* fs.readFile(target).pipe(
          Effect.mapError(
            (cause) =>
              new FsExternalReadError({
                path: absPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          const content = decoder.decode(bytes);
          return {
            kind: "text" as const,
            content,
            mtime: mtimeToString(stat.mtime),
            size,
          };
        } catch {
          return { kind: "binary" as const, size };
        }
      });

    const writeExternal: FsService["Service"]["writeExternal"] = (
      absPath,
      content,
      expectedMtime,
    ) =>
      Effect.gen(function* () {
        const target = pathSvc.resolve(absPath);
        const byteLen = new TextEncoder().encode(content).byteLength;
        if (byteLen > MAX_FILE_BYTES) {
          return yield* Effect.fail(
            new FsExternalTooLargeError({
              path: absPath,
              size: byteLen,
              limit: MAX_FILE_BYTES,
            }),
          );
        }
        const beforeStat = yield* fs.stat(target).pipe(
          Effect.mapError(
            (cause) =>
              new FsExternalReadError({
                path: absPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        const actualMtime = mtimeToString(beforeStat.mtime);
        if (actualMtime !== expectedMtime) {
          return yield* Effect.fail(
            new FsExternalConflictError({
              path: absPath,
              expectedMtime,
              actualMtime,
            }),
          );
        }
        yield* fs.writeFileString(target, content).pipe(
          Effect.mapError(
            (cause) =>
              new FsExternalReadError({
                path: absPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        const afterStat = yield* fs.stat(target).pipe(
          Effect.mapError(
            (cause) =>
              new FsExternalReadError({
                path: absPath,
                reason: cause.message ?? String(cause),
              }),
          ),
        );
        return { mtime: mtimeToString(afterStat.mtime) };
      });

    return {
      tree,
      watchTree,
      readFile,
      writeFile,
      createFile,
      createDirectory,
      remove,
      readExternal,
      writeExternal,
    } as const;
  }),
);
