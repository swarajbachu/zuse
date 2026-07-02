import { Effect, Layer } from "effect";

import { AppPaths } from "../app-paths.ts";
import { ensureSqliteRenameCompatibility, sqliteDbPath } from "./db-path.ts";
import * as NodeSqliteClient from "./node-sqlite-client.ts";

/**
 * Live SQLite client for the chat-MVP persistence layer. Resolves the DB
 * file path against `AppPaths.userData` (provided by the host shim — Electron
 * today, WS server tomorrow). Honors `ZUSE_SQLITE_MEMORY=1` (or the legacy
 * `MEMOIZE_SQLITE_MEMORY=1`) for tests
 * and isolated benches; otherwise the file lives at
 * `<userData>/zuse.sqlite` so a user can `sqlite3` into it.
 *
 * Backed by Node's built-in `node:sqlite` (see `node-sqlite-client.ts`), so
 * the exact same layer boots under Electron's bundled Node and a headless
 * system Node — no native-addon ABI split.
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
    return NodeSqliteClient.layer({ filename });
  }),
);
