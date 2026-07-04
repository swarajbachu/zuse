import { FileSystem } from "@effect/platform";
import { SqlClient } from "@effect/sql";
import { Effect, Schema } from "effect";
import * as Path from "node:path";

import { Folder, FolderId } from "@zuse/wire";

import { AppPaths } from "../app-paths.ts";

const WorkspaceFile = Schema.parseJson(
  Schema.Struct({
    folders: Schema.Array(Folder),
    selectedFolderId: Schema.optionalWith(Schema.NullOr(FolderId), {
      default: () => null,
    }),
  }),
);

const SELECTED_KEY = "selectedProjectId";

/**
 * One-time migration from the Phase 1 `workspaces.json` file into the SQLite
 * `projects` + `app_state` tables. Runs at boot once the schema migrations
 * have applied. Idempotent: if the projects table already has rows we skip.
 * On success the JSON file is renamed to `workspaces.json.bak` so a second
 * boot doesn't try to re-import (and so the user can recover it manually if
 * something went wrong).
 *
 * Failure is non-fatal: a corrupt or missing JSON just leaves an empty
 * projects table — same outcome as a fresh install.
 */
export const importWorkspacesJson = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* AppPaths;

  const filePath = Path.join(paths.userData, "workspaces.json");
  const exists = yield* fs
    .exists(filePath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) return;

  const existingProjects = yield* sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM projects
  `.pipe(Effect.orDie);
  if ((existingProjects[0]?.count ?? 0) > 0) return;

  const decoded = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(Schema.decode(WorkspaceFile)),
    Effect.catchAllCause((cause) =>
      Effect.logWarning(
        "[zuse] workspaces.json present but unreadable; skipping import",
      ).pipe(Effect.zipRight(Effect.logDebug(cause)), Effect.as(null)),
    ),
  );
  if (decoded === null) return;

  for (const folder of decoded.folders) {
    const createdAt = folder.addedAt.toISOString();
    yield* sql`
      INSERT INTO projects (id, path, name, created_at, updated_at)
      VALUES (${folder.id}, ${folder.path}, ${folder.name}, ${createdAt}, ${createdAt})
    `.pipe(Effect.orDie);
  }

  if (decoded.selectedFolderId !== null) {
    yield* sql`
      INSERT INTO app_state (key, value) VALUES (${SELECTED_KEY}, ${decoded.selectedFolderId})
    `.pipe(Effect.orDie);
  }

  yield* fs
    .rename(filePath, `${filePath}.bak`)
    .pipe(Effect.catchAll(() => Effect.void));

  yield* Effect.logInfo(
    `[zuse] imported ${decoded.folders.length} project(s) from workspaces.json`,
  );
});
