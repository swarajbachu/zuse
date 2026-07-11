import { createRequire } from "node:module";

export interface SqliteHandle {
	prepare(sql: string): { all(...params: unknown[]): unknown[] };
	close(): void;
}

/**
 * Open a SQLite database read-only using the runtime's built-in driver.
 * Throws if the file cannot be opened.
 */
export const openReadonlyDatabase = (path: string): SqliteHandle => {
	const require = createRequire(import.meta.url);
	if (process.versions.bun !== undefined) {
		const mod = require("bun:sqlite") as {
			Database: new (
				filename: string,
				options?: { readonly?: boolean },
			) => SqliteHandle;
		};
		return new mod.Database(path, { readonly: true });
	}
	const { DatabaseSync } =
		require("node:sqlite") as typeof import("node:sqlite");
	return new DatabaseSync(path, { readOnly: true });
};
