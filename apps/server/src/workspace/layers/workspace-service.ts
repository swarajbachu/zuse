import * as Path from "node:path";
import {
	Folder,
	FolderId,
	PERSONAL_WORKSPACE_KEY,
	WorkspaceDuplicatePathError,
	WorkspaceInvalidPathError,
	WorkspaceKey,
	WorkspaceNotFoundError,
} from "@zuse/contracts";
import { Effect, FileSystem, Layer, PubSub, Schema, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";

import { prepareProjectRegistration } from "../project-registration.ts";
import { WorkspaceService } from "../services/workspace-service.ts";

interface ProjectRow {
	readonly id: string;
	readonly path: string;
	readonly name: string;
	readonly created_at: string;
	readonly workspace_key: string;
}

const isWorkspaceKey = Schema.is(WorkspaceKey);

const rowToFolder = (row: ProjectRow): Folder =>
	Folder.make({
		id: FolderId.make(row.id),
		path: row.path,
		name: row.name,
		addedAt: new Date(row.created_at),
		// A malformed stored key must never widen visibility; treat it as Personal.
		workspaceKey: isWorkspaceKey(row.workspace_key)
			? row.workspace_key
			: PERSONAL_WORKSPACE_KEY,
	});

const SELECTED_KEY = "selectedProjectId";

export const WorkspaceServiceLive = Layer.effect(
	WorkspaceService,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const fs = yield* FileSystem.FileSystem;
		const changes = yield* PubSub.unbounded<ReadonlyArray<Folder>>();

		const list: WorkspaceService["Service"]["list"] = () =>
			Effect.gen(function* () {
				const rows = yield* sql<ProjectRow>`
          SELECT id, path, name, created_at, workspace_key
          FROM projects
          ORDER BY created_at ASC
        `.pipe(Effect.orDie);
				return rows.map(rowToFolder);
			});

		const findById: WorkspaceService["Service"]["findById"] = (folderId) =>
			Effect.gen(function* () {
				const rows = yield* sql<ProjectRow>`
          SELECT id, path, name, created_at, workspace_key
          FROM projects
          WHERE id = ${folderId}
          LIMIT 1
        `.pipe(Effect.orDie);
				return rows.length > 0 ? rowToFolder(rows[0]!) : null;
			});

		const add: WorkspaceService["Service"]["add"] = (rawPath, options) =>
			Effect.gen(function* () {
				const resolved = Path.resolve(rawPath);
				const workspaceKey = options?.workspaceKey ?? PERSONAL_WORKSPACE_KEY;

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

				const dupes = yield* sql<ProjectRow>`
          SELECT id, path, name, created_at, workspace_key
          FROM projects WHERE path = ${resolved} LIMIT 1
        `.pipe(Effect.orDie);
				const existing = dupes[0];
				if (existing !== undefined) {
					const folder = rowToFolder(existing);
					if (
						options?.moveFrom !== undefined &&
						options.moveFrom !== workspaceKey
					) {
						// Compare-and-swap: a concurrent move or re-add leaves the row alone.
						const moved = yield* sql<{ id: string }>`
              UPDATE projects
              SET workspace_key = ${workspaceKey}, updated_at = ${new Date().toISOString()}
              WHERE id = ${existing.id} AND workspace_key = ${options.moveFrom}
              RETURNING id
            `.pipe(Effect.orDie);
						if (moved.length > 0) {
							yield* PubSub.publish(changes, yield* list());
							return Folder.make({ ...folder, workspaceKey });
						}
					}
					return yield* Effect.fail(
						new WorkspaceDuplicatePathError({
							path: resolved,
							...(folder.workspaceKey === workspaceKey
								? {}
								: { folderId: folder.id, workspaceKey: folder.workspaceKey }),
						}),
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
          INSERT INTO projects (id, path, name, created_at, updated_at, workspace_key)
          VALUES (${id}, ${resolved}, ${name}, ${nowIso}, ${nowIso}, ${workspaceKey})
        `.pipe(Effect.orDie);

				const folder = Folder.make({
					id,
					path: resolved,
					name,
					addedAt: now,
					workspaceKey,
				});
				yield* PubSub.publish(changes, yield* list());
				return folder;
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
				yield* PubSub.publish(changes, yield* list());
			});

		const streamChanges: WorkspaceService["Service"]["streamChanges"] = () =>
			Stream.unwrap(
				Effect.gen(function* () {
					const subscription = yield* PubSub.subscribe(changes);
					const snapshot = yield* list();
					return Stream.concat(
						Stream.succeed(snapshot),
						Stream.fromSubscription(subscription),
					);
				}),
			);

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

		const setSelected: WorkspaceService["Service"]["setSelected"] = (
			folderId,
		) =>
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
			streamChanges,
			remove,
			getSelected,
			setSelected,
			findById,
		} as const;
	}),
);
