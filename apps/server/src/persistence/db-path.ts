import { Effect, Option } from "effect";
import { copyFile, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type * as NodeSqlite from "node:sqlite";

export const ZUSE_SQLITE_FILENAME = "zuse.sqlite";
const LEGACY_MEMOIZE_SQLITE_FILENAME = "memoize.sqlite";
const MIGRATION_STATE_FILENAME = "zuse-migration-state.json";
const LEGACY_USER_DATA_DIR_NAMES = [
  "memoize Alpha",
  "memoize",
  "memoize Alpha (Dev)",
  "memoize (Dev)",
] as const;
const EMPTY_SQLITE_MAX_BYTES = 64 * 1024;
const require = createRequire(import.meta.url);

export const sqliteDbPath = (userData: string): string =>
  join(userData, ZUSE_SQLITE_FILENAME);

export const legacySqliteDbPath = (userData: string): string =>
  join(userData, LEGACY_MEMOIZE_SQLITE_FILENAME);

const migrationStatePath = (userData: string): string =>
  join(userData, MIGRATION_STATE_FILENAME);

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(() => stat(path)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const fileSize = (path: string): Effect.Effect<number> =>
  Effect.tryPromise(() => stat(path)).pipe(
    Effect.map((s) => s.size),
    Effect.orElseSucceed(() => 0),
  );

/**
 * Count `projects` rows via a read-only `node:sqlite` probe. `null` means
 * "could not read the file as sqlite" — callers fall back to a size
 * heuristic. The require is lazy because this module is also loaded under
 * Bun (tests), which has no `node:sqlite`; there the probe fails cleanly to
 * the heuristic, matching how the old better-sqlite3 probe behaved when its
 * native binding could not load. (The old `/usr/bin/sqlite3` CLI fallback
 * existed only for native-ABI failures, which a builtin cannot have.)
 */
const projectCount = (path: string): Effect.Effect<number | null> =>
  Effect.try(() => {
    const { DatabaseSync } = require("node:sqlite") as typeof NodeSqlite;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const hasProjects = db
        .prepare(
          "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'projects'",
        )
        .get();
      if (typeof hasProjects?.count !== "number" || !hasProjects.count) {
        return 0;
      }

      const projects = db
        .prepare("SELECT count(*) AS count FROM projects")
        .get();
      return typeof projects?.count === "number" ? projects.count : 0;
    } finally {
      db.close();
    }
  }).pipe(Effect.orElseSucceed(() => null));

const looksEmpty = (path: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const projects = yield* projectCount(path);
    if (projects !== null) return projects === 0;
    return (yield* fileSize(path)) <= EMPTY_SQLITE_MAX_BYTES;
  });

const legacySiblingDbCandidates = (
  userData: string,
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const appSupportDir = dirname(userData);
    const currentDirName = basename(userData);
    const candidates: string[] = [];
    for (const name of LEGACY_USER_DATA_DIR_NAMES) {
      if (name === currentDirName) continue;
      const candidate = join(
        appSupportDir,
        name,
        LEGACY_MEMOIZE_SQLITE_FILENAME,
      );
      if (yield* exists(candidate)) candidates.push(candidate);
    }
    return candidates;
  });

const newestNonEmptyLegacyDb = (
  userData: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const candidates = yield* legacySiblingDbCandidates(userData);
    const withStats = yield* Effect.forEach(candidates, (path) =>
      Effect.gen(function* () {
        return {
          path,
          projects: yield* projectCount(path),
          size: yield* fileSize(path),
          mtimeMs: yield* Effect.tryPromise(() => stat(path)).pipe(
            Effect.map((s) => s.mtimeMs),
            Effect.orElseSucceed(() => 0),
          ),
        };
      }),
    );
    const nonEmpty = withStats
      .filter((candidate) =>
        candidate.projects !== null
          ? candidate.projects > 0
          : candidate.size > EMPTY_SQLITE_MAX_BYTES,
      )
      .sort((a, b) => {
        const projectDiff = (b.projects ?? 0) - (a.projects ?? 0);
        if (projectDiff !== 0) return projectDiff;
        const sizeDiff = b.size - a.size;
        if (sizeDiff !== 0) return sizeDiff;
        return b.mtimeMs - a.mtimeMs;
      });
    return Option.fromNullable(nonEmpty[0]?.path);
  });

const copyLegacyDb = (
  userData: string,
  legacy: string,
  current: string,
  kind: string,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => copyFile(legacy, current),
      catch: (cause) =>
        new Error(`Failed to copy legacy sqlite from ${legacy}`, { cause }),
    });
    yield* Effect.tryPromise({
      try: () =>
        writeFile(
          migrationStatePath(userData),
          `${JSON.stringify(
            {
              kind,
              from: legacy,
              to: current,
              migratedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
        ),
      catch: (cause) =>
        new Error("Failed to record sqlite migration state", { cause }),
    });
  });

export const ensureSqliteRenameCompatibility = (
  userData: string,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const current = sqliteDbPath(userData);
    if (yield* exists(current)) {
      if (!(yield* looksEmpty(current))) return;

      const legacySibling = yield* newestNonEmptyLegacyDb(userData);
      if (Option.isNone(legacySibling)) return;

      const backup = `${current}.empty-before-zuse-migration-${Date.now()}`;
      yield* Effect.tryPromise({
        try: () => rename(current, backup),
        catch: (cause) =>
          new Error(`Failed to back up empty sqlite to ${backup}`, { cause }),
      });
      yield* copyLegacyDb(
        userData,
        legacySibling.value,
        current,
        "memoize-app-support-to-zuse-sqlite-copy",
      );
      return;
    }

    const legacy = legacySqliteDbPath(userData);
    if (yield* exists(legacy)) {
      yield* copyLegacyDb(
        userData,
        legacy,
        current,
        "memoize-to-zuse-sqlite-copy",
      );
      return;
    }

    const legacySibling = yield* newestNonEmptyLegacyDb(userData);
    if (Option.isNone(legacySibling)) return;

    yield* copyLegacyDb(
      userData,
      legacySibling.value,
      current,
      "memoize-app-support-to-zuse-sqlite-copy",
    );
  });
