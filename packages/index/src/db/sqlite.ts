import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Effect } from "effect";

import { IndexDbError } from "../errors.ts";

/**
 * Minimal SQLite handle. We keep the surface tiny because the package is
 * dual-runtime: it runs in Node (Electron desktop, mcp-server CLI) on top
 * of `better-sqlite3`, and in Bun (`bun test`) on top of the built-in
 * `bun:sqlite`. The two APIs diverge in places (pragmas, return types) so
 * the rest of the engine talks to this shim, not the underlying drivers.
 */
export interface IndexDb {
  readonly open: boolean;
  exec(sql: string): void;
  prepare(sql: string): IndexStmt;
  transaction<A>(fn: () => A): () => A;
  close(): void;
}

export interface IndexStmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

declare const Bun: unknown;
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

const openBun = async (filename: string): Promise<IndexDb> => {
  // `bun:sqlite` has no @types — narrow the dynamic-import surface to
  // exactly what we use. Node never reaches this branch.
  const mod = (await import("bun:sqlite" as string)) as {
    Database: new (filename: string, opts?: { create?: boolean }) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
      };
      transaction<A>(fn: () => A): () => A;
      close(): void;
    };
  };
  const db = new mod.Database(filename, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA temp_store = MEMORY");
  let openFlag = true;
  return {
    get open() {
      return openFlag;
    },
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => {
      if (openFlag) {
        db.close();
        openFlag = false;
      }
    },
  };
};

const openNode = async (filename: string): Promise<IndexDb> => {
  const mod = (await import("better-sqlite3")) as {
    default: new (filename: string) => {
      open: boolean;
      exec(sql: string): void;
      prepare(sql: string): {
        run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
      };
      transaction<A>(fn: () => A): () => A;
      close(): void;
      pragma(s: string): unknown;
    };
  };
  const db = new mod.default(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  return {
    get open() {
      return db.open;
    },
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    transaction: (fn) => db.transaction(fn),
    close: () => {
      if (db.open) db.close();
    },
  };
};

/**
 * Open the per-workspace index DB. The directory is created if missing
 * (Electron may run with no `.zuse` folder on first boot). `:memory:`
 * is honored for unit tests and benches.
 */
export const openIndexDb = (filename: string): Effect.Effect<IndexDb, IndexDbError> =>
  Effect.tryPromise({
    try: async () => {
      if (filename !== ":memory:") {
        mkdirSync(dirname(filename), { recursive: true });
      }
      return isBun ? await openBun(filename) : await openNode(filename);
    },
    catch: (cause) =>
      new IndexDbError({
        reason: `failed to open index db at ${filename}`,
        cause,
      }),
  });

export const closeIndexDb = (db: IndexDb): Effect.Effect<void> =>
  Effect.sync(() => {
    if (db.open) db.close();
  });
