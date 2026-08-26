import * as Path from "node:path";
import {
	Folder,
	FolderId,
	WorkspaceInvalidPathError,
	WorkspaceNotFoundError,
} from "@zuse/contracts";
import { Effect, FileSystem, Layer, PubSub, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";

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
		const changes = yield* PubSub.unbounded<ReadonlyArray<Folder>>();
		const projectMutationLock = yield* Semaphore.make(1);

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

		const findExistingByFilesystemIdentity = (
			canonical: string,
			resolved: string,
		) =>
			Effect.gen(function* () {
				const exactRows = yield* sql<ProjectRow>`
          SELECT id, path, name, created_at
          FROM projects
          WHERE path = ${canonical}
             OR path = ${resolved}
          LIMIT 1
        `.pipe(Effect.orDie);
				const [exact] = exactRows;
				if (exact !== undefined) return exact;

				const rows = yield* sql<ProjectRow>`
          SELECT id, path, name, created_at
          FROM projects
          ORDER BY created_at ASC
        `.pipe(Effect.orDie);
				for (const row of rows) {
					const existingCanonical = yield* fs
						.realPath(row.path)
						.pipe(Effect.catch(() => Effect.succeed(null)));
					if (existingCanonical === canonical) return row;
				}
				return null;
			});

		const add: WorkspaceService["Service"]["add"] = (rawPath) =>
			Effect.gen(function* () {
				const resolved = Path.resolve(rawPath);
				const canonical = yield* fs
					.realPath(resolved)
					.pipe(Effect.catch(() => Effect.succeed(resolved)));

				const stat = yield* fs.stat(canonical).pipe(
					Effect.mapError(
						() =>
							new WorkspaceInvalidPathError({
								path: canonical,
								reason: "path does not exist",
							}),
					),
				);
				if (stat.type !== "Directory") {
					return yield* Effect.fail(
						new WorkspaceInvalidPathError({
							path: canonical,
							reason: "path is not a directory",
						}),
					);
				}

				return yield* projectMutationLock.withPermits(1)(
					Effect.gen(function* () {
						const existing = yield* findExistingByFilesystemIdentity(
							canonical,
							resolved,
						);
						if (existing !== null) return rowToFolder(existing);

						yield* Effect.tryPromise({
							try: () => prepareProjectRegistration(canonical),
							catch: (cause) =>
								new WorkspaceInvalidPathError({
									path: canonical,
									reason: `could not prepare project metadata: ${String(cause)}`,
								}),
						});

						const id = FolderId.make(crypto.randomUUID());
						const name = Path.basename(canonical) || canonical;
						const now = new Date();
						const nowIso = now.toISOString();

						yield* sql`
          INSERT INTO projects (id, path, name, created_at, updated_at)
          VALUES (${id}, ${canonical}, ${name}, ${nowIso}, ${nowIso})
							ON CONFLICT(path) DO NOTHING
        `.pipe(Effect.orDie);

						const registeredRows = yield* sql<ProjectRow>`
							SELECT id, path, name, created_at
							FROM projects
							WHERE path = ${canonical}
							LIMIT 1
						`.pipe(Effect.orDie);
						const [registered] = registeredRows;
						if (registered === undefined) {
							return yield* Effect.die(
								new Error(`project registration did not persist ${canonical}`),
							);
						}
						const folder = rowToFolder(registered);
						yield* PubSub.publish(changes, yield* list());
						return folder;
					}),
				);
			});

		const remove: WorkspaceService["Service"]["remove"] = (folderId) =>
			projectMutationLock.withPermits(1)(
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
				}),
			);

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
