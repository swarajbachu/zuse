import type { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import type { ConfigError } from "effect";
import { Effect, Layer } from "effect";
import { createRequire } from "node:module";

import { AppPaths } from "../app-paths.ts";
import { ensureSqliteRenameCompatibility, sqliteDbPath } from "./db-path.ts";

const require = createRequire(import.meta.url);

/**
 * Live SQLite client for the chat-MVP persistence layer. Resolves the DB
 * file path against `AppPaths.userData` (provided by the host shim — Electron
 * today, WS server tomorrow). Honors `ZUSE_SQLITE_MEMORY=1` (or the legacy
 * `MEMOIZE_SQLITE_MEMORY=1`) for tests
 * and isolated benches; otherwise the file lives at
 * `<userData>/zuse.sqlite` so a user can `sqlite3` into it.
 *
 * Driver selection (R7 fallback, spec D2): prefer Node's built-in
 * `node:sqlite` — no native addon, so the same layer boots under a headless
 * system Node and any Electron ≥35. The shipping desktop Electron (33,
 * Node 20.18) predates `node:sqlite`, so it falls back to the better-sqlite3
 * driver, whose prebuilt binding electron-rebuild targets. Both drivers are
 * loaded lazily — a top-level import of either would crash the runtime that
 * lacks it. Delete the fallback branch when desktop Electron reaches ≥35.
 */
export const SqliteLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const paths = yield* AppPaths;
    const inMemory =
      process.env.ZUSE_SQLITE_MEMORY === "1" ||
      process.env.MEMOIZE_SQLITE_MEMORY === "1";
    if (!inMemory) {
      yield* ensureSqliteRenameCompatibility(paths.userData).pipe(Effect.orDie);
    }
    const filename = inMemory ? ":memory:" : sqliteDbPath(paths.userData);

    const nodeSqliteAvailable = yield* Effect.try(() => {
      require("node:sqlite");
      return true;
    }).pipe(Effect.orElseSucceed(() => false));

    if (nodeSqliteAvailable) {
      const modern = yield* Effect.tryPromise(
        () => import("./node-sqlite-client.ts"),
      ).pipe(Effect.orDie);
      return modern.layer({ filename }) as Layer.Layer<
        SqlClient.SqlClient,
        SqlError | ConfigError.ConfigError
      >;
    }

    const legacy = yield* Effect.tryPromise(
      () => import("@effect/sql-sqlite-node"),
    ).pipe(Effect.orDie);
    return legacy.SqliteClient.layer({ filename });
  }),
);
