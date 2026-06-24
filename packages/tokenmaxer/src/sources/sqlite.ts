import { createRequire } from "node:module";

export interface SqliteHandle {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

/**
 * Open a SQLite database read-only, using `bun:sqlite` under Bun and
 * `better-sqlite3` under Node. Throws if the file cannot be opened.
 */
export const openReadonlyDatabase = (path: string): SqliteHandle => {
  const require = createRequire(import.meta.url);
  if (process.versions.bun !== undefined) {
    const mod = require("bun:sqlite") as {
      Database: new (filename: string, options?: { readonly?: boolean }) => SqliteHandle;
    };
    return new mod.Database(path, { readonly: true });
  }
  const mod = require("better-sqlite3") as {
    default?: new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteHandle;
  } & (new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteHandle);
  const Database = mod.default ?? mod;
  return new Database(path, { readonly: true, fileMustExist: true });
};
