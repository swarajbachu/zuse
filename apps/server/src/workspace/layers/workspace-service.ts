import { FileSystem } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { Effect, Layer } from "effect";
import * as Path from "node:path";

import {
  Folder,
  FolderId,
  WorkspaceDuplicatePathError,
  WorkspaceInvalidPathError,
  WorkspaceNotFoundError,
} from "@zuse/contracts";

import { prepareProjectRegistration } from "../project-registration.ts";
import { WorkspaceService } from "../services/workspace-service.ts";

interface ProjectRow {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly created_at: string;
}

const rowToFolder = (row: ProjectRow): Folder =>
  Folder.make({
    id: FolderId.make(row.id),
    path: row.path,
    name: row.name,
    addedAt: new Date(row.created_at),
  });

const SELECTED_KEY = "selectedProjectId";

export const WorkspaceServiceLive = Layer.effect(
  WorkspaceService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const fs = yield* FileSystem.FileSystem;

    const list: WorkspaceService["Service"]["list"] = () =>
      Effect.gen(function* () {
        const rows = yield* sql<ProjectRow>`
          SELECT id, path, name, created_at
          FROM projects
          ORDER BY created_at ASC
        `.pipe(Effect.orDie);
        return rows.map(rowToFolder);
      });

    const findById: WorkspaceService["Service"]["findById"] = (folderId) =>
      Effect.gen(function* () {
        const rows = yield* sql<ProjectRow>`
          SELECT id, path, name, created_at
          FROM projects
          WHERE id = ${folderId}
          LIMIT 1
        `.pipe(Effect.orDie);
        return rows.length > 0 ? rowToFolder(rows[0]!) : null;
      });

    const add: WorkspaceService["Service"]["add"] = (rawPath) =>
      Effect.gen(function* () {
        const resolved = Path.resolve(rawPath);

        const stat = yield* fs.stat(resolved).pipe(
          Effect.mapError(
            () =>
              new WorkspaceInvalidPathError({
                path: resolved,
                reason: "path does not exist",
              }),
          ),
        );
        if (stat.type !== "Directory") {
          return yield* Effect.fail(
            new WorkspaceInvalidPathError({
              path: resolved,
              reason: "path is not a directory",
            }),
          );
        }

        const dupes = yield* sql<{ id: string }>`
          SELECT id FROM projects WHERE path = ${resolved} LIMIT 1
        `.pipe(Effect.orDie);
        if (dupes.length > 0) {
          return yield* Effect.fail(
            new WorkspaceDuplicatePathError({ path: resolved }),
          );
        }

        yield* Effect.tryPromise({
          try: () => prepareProjectRegistration(resolved),
          catch: (cause) =>
            new WorkspaceInvalidPathError({
              path: resolved,
              reason: `could not prepare project metadata: ${String(cause)}`,
            }),
        });

        const id = FolderId.make(crypto.randomUUID());
        const name = Path.basename(resolved) || resolved;
        const now = new Date();
        const nowIso = now.toISOString();

        yield* sql`
          INSERT INTO projects (id, path, name, created_at, updated_at)
          VALUES (${id}, ${resolved}, ${name}, ${nowIso}, ${nowIso})
        `.pipe(Effect.orDie);

        return Folder.make({ id, path: resolved, name, addedAt: now });
      });

    const remove: WorkspaceService["Service"]["remove"] = (folderId) =>
      Effect.gen(function* () {
        const existing = yield* sql<{ id: string }>`
          SELECT id FROM projects WHERE id = ${folderId} LIMIT 1
        `.pipe(Effect.orDie);
        if (existing.length === 0) {
          return yield* Effect.fail(new WorkspaceNotFoundError({ folderId }));
        }
        yield* sql`DELETE FROM projects WHERE id = ${folderId}`.pipe(
          Effect.orDie,
        );
        // ON DELETE CASCADE on projects → sessions → messages handles the rest.
        // If this was the selected project, clear the pointer so the persisted
        // value never points to a missing id.
        yield* sql`
          DELETE FROM app_state
          WHERE key = ${SELECTED_KEY} AND value = ${folderId}
        `.pipe(Effect.orDie);
      });

    const getSelected: WorkspaceService["Service"]["getSelected"] = () =>
      Effect.gen(function* () {
        const rows = yield* sql<{ value: string }>`
          SELECT value FROM app_state WHERE key = ${SELECTED_KEY} LIMIT 1
        `.pipe(Effect.orDie);
        if (rows.length === 0) return null;
        const id = FolderId.make(rows[0]!.value);
        // Defensive: drop the selection if the project is gone.
        const known = yield* sql<{ id: string }>`
          SELECT id FROM projects WHERE id = ${id} LIMIT 1
        `.pipe(Effect.orDie);
        return known.length > 0 ? id : null;
      });

    const setSelected: WorkspaceService["Service"]["setSelected"] = (folderId) =>
      Effect.gen(function* () {
        if (folderId === null) {
          yield* sql`DELETE FROM app_state WHERE key = ${SELECTED_KEY}`.pipe(
            Effect.orDie,
          );
          return;
        }
        const known = yield* sql<{ id: string }>`
          SELECT id FROM projects WHERE id = ${folderId} LIMIT 1
        `.pipe(Effect.orDie);
        if (known.length === 0) {
          yield* sql`DELETE FROM app_state WHERE key = ${SELECTED_KEY}`.pipe(
            Effect.orDie,
          );
          return;
        }
        yield* sql`
          INSERT INTO app_state (key, value) VALUES (${SELECTED_KEY}, ${folderId})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `.pipe(Effect.orDie);
      });

    return {
      add,
      list,
      remove,
      getSelected,
      setSelected,
      findById,
    } as const;
  }),
);
