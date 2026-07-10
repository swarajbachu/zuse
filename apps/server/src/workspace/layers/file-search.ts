import * as path from "node:path";

import { FileSystem, Path } from "effect";
import { Effect, Layer } from "effect";
import fuzzysort from "fuzzysort";

import { FsFolderNotFoundError } from "@zuse/wire";

import { WorktreeService } from "../../worktree/services/worktree-service.ts";
import {
  FileSearchService,
  type FileSearchHit,
  type FileSearchServiceShape,
} from "../services/file-search.ts";
import { WorkspaceService } from "../services/workspace-service.ts";

/**
 * Directories we skip outright. Same shape as FsService — keep these in
 * sync if either grows. Matched on basename.
 */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  // Memoize's per-project artifacts (code-index sqlite, etc.) live under
  // <root>/.zuse/. Pickers shouldn't surface them.
  ".zuse",
  "dist",
  "build",
  ".turbo",
  ".next",
  ".vite",
  ".cache",
  ".DS_Store",
]);

/** Cap how deep we descend so a runaway monorepo can't hang the picker. */
const MAX_DEPTH = 12;

/**
 * Cap the *visited* node count too, independent of `limit`. The popover
 * filters client-side after the server returns; we still want the search
 * to terminate quickly even when the user hasn't typed yet.
 */
const MAX_VISITED = 5_000;

const DEFAULT_LIMIT = 20;

const toForwardSlash = (p: string): string =>
  path.sep === "/" ? p : p.split(path.sep).join("/");

export const FileSearchServiceLive = Layer.effect(
  FileSearchService,
  Effect.gen(function* () {
    const workspace = yield* WorkspaceService;
    const worktrees = yield* WorktreeService;
    const fs = yield* FileSystem.FileSystem;
    const pathSvc = yield* Path.Path;

    const search: FileSearchServiceShape["search"] = (
      folderId,
      query,
      limit,
      worktreeId,
    ) =>
      Effect.gen(function* () {
        const folder = yield* workspace.findById(folderId);
        if (folder === null) {
          return yield* Effect.fail(new FsFolderNotFoundError({ folderId }));
        }
        const cap = limit && limit > 0 ? limit : DEFAULT_LIMIT;

        // Reroot at the worktree's path when one is supplied and it belongs
        // to this project. Mismatched worktree → fail closed by returning
        // an empty result set so a stale worktreeId from a freshly-switched
        // session never surfaces files from the wrong project.
        let root = folder.path;
        if (worktreeId) {
          const wt = yield* worktrees.get(worktreeId);
          if (wt === null || wt.projectId !== folderId) {
            return [] as ReadonlyArray<FileSearchHit>;
          }
          root = wt.path;
        }
        const rootAbs = pathSvc.resolve(root);

        // Collect every candidate (subject to depth/visit caps), then rank
        // with fuzzysort. The substring matcher we used previously couldn't
        // span path segments — typing `chatcomp` wouldn't match
        // `apps/renderer/src/components/chat-composer.tsx`. fuzzysort's
        // boundary-aware ranking handles that and keeps the result count
        // small enough that scoring everything is cheap.
        const candidates: FileSearchHit[] = [];
        let visited = 0;

        const walk = (
          absDir: string,
          relDir: string,
          depth: number,
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (visited >= MAX_VISITED) return;
            if (depth > MAX_DEPTH) return;

            const names = yield* fs
              .readDirectory(absDir)
              .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));

            const sorted = [...names].sort((a, b) =>
              a.localeCompare(b, undefined, { sensitivity: "base" }),
            );

            for (const name of sorted) {
              if (visited >= MAX_VISITED) return;
              if (SKIP_DIRS.has(name)) continue;

              visited++;
              const childAbs = pathSvc.join(absDir, name);
              const childRel = relDir === "" ? name : `${relDir}/${name}`;

              const stat = yield* fs.stat(childAbs).pipe(Effect.option);
              if (stat._tag === "None") continue;
              const kind =
                stat.value.type === "Directory" ? "directory" : "file";

              candidates.push({
                relPath: toForwardSlash(childRel),
                absPath: childAbs,
                kind,
              });

              if (kind === "directory") {
                yield* walk(childAbs, childRel, depth + 1);
              }
            }
          });

        yield* walk(rootAbs, "", 0);

        // Empty query: just return the first `cap` candidates as a "what's
        // here" view. Fuzzysort's `all: true` would do this but we also want
        // a stable filesystem order which the walker already provides.
        if (!query) return candidates.slice(0, cap);

        const ranked = fuzzysort.go(query, candidates, {
          key: "relPath",
          limit: cap,
          threshold: 0.3,
        });
        return ranked.map((r) => r.obj);
      });

    return { search } satisfies FileSearchServiceShape;
  }),
);
