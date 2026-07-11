import { mkdir } from "node:fs/promises";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { AppPaths } from "../app-paths.ts";
import { ensureSqliteRenameCompatibility, sqliteDbPath } from "./db-path.ts";

/**
 * Live SQLite client for the chat-MVP persistence layer. Resolves the DB
 * file path against `AppPaths.userData` (provided by the host shim — Electron
 * today, WS server tomorrow). Honors `ZUSE_SQLITE_MEMORY=1` (or the legacy
 * `MEMOIZE_SQLITE_MEMORY=1`) for tests
 * and isolated benches; otherwise the file lives at
 * `<userData>/zuse.sqlite` so a user can `sqlite3` into it.
 *
 * Bun uses its built-in driver for development and tests. Node and Electron
 * use `node:sqlite`, keeping production persistence free of native addons.
 */
export const SqliteLive = Layer.unwrap(
	Effect.gen(function* () {
		const paths = yield* AppPaths;
		const inMemory =
			process.env.ZUSE_SQLITE_MEMORY === "1" ||
			process.env.MEMOIZE_SQLITE_MEMORY === "1";
		if (!inMemory) {
			yield* Effect.tryPromise(() =>
				mkdir(paths.userData, { recursive: true }),
			).pipe(Effect.orDie);
		}
		if (!inMemory) {
			yield* ensureSqliteRenameCompatibility(paths.userData).pipe(Effect.orDie);
		}
		const filename = inMemory ? ":memory:" : sqliteDbPath(paths.userData);

		if (process.versions.bun !== undefined) {
			const bunSqlite = yield* Effect.tryPromise(
				() => import("@effect/sql-sqlite-bun"),
			).pipe(Effect.orDie);
			return bunSqlite.SqliteClient.layer({ filename });
		}

		const nodeSqlite = yield* Effect.tryPromise(
			() => import("@zuse/sqlite"),
		).pipe(Effect.orDie);
		return nodeSqlite.layer({ filename }) as Layer.Layer<
			SqlClient.SqlClient,
			SqlError
		>;
	}),
);
