import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { Effect } from "effect";

import { IndexDbError } from "../errors.ts";

/**
 * Minimal SQLite handle. We keep the surface tiny because the package is
 * dual-runtime: it runs on the built-in SQLite APIs in Node/Electron and Bun.
 * The two APIs diverge in places (transactions and return types), so
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
	run(...params: unknown[]): {
		changes: number;
		lastInsertRowid: number | bigint;
	};
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

declare const Bun: unknown;
const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

const nodeParams = (params: readonly unknown[]): SQLInputValue[] =>
	params.map((param) =>
		typeof param === "boolean" ? (param ? 1 : 0) : param,
	) as SQLInputValue[];

const openBun = async (filename: string): Promise<IndexDb> => {
	// `bun:sqlite` has no @types — narrow the dynamic-import surface to
	// exactly what we use. Node never reaches this branch.
	const mod = (await import("bun:sqlite" as string)) as {
		Database: new (
			filename: string,
			opts?: { create?: boolean },
		) => {
			exec(sql: string): void;
			prepare(sql: string): {
				run(...params: unknown[]): {
					changes: number;
					lastInsertRowid: number | bigint;
				};
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
	const { DatabaseSync } = await import("node:sqlite");
	const db = new DatabaseSync(filename);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA temp_store = MEMORY");
	return {
		get open() {
			return db.isOpen;
		},
		exec: (sql) => db.exec(sql),
		prepare: (sql) => {
			const statement = db.prepare(sql);
			return {
				run: (...params) => statement.run(...nodeParams(params)),
				get: (...params) => statement.get(...nodeParams(params)),
				all: (...params) => statement.all(...nodeParams(params)),
			} as IndexStmt;
		},
		transaction: (fn) => () => {
			db.exec("BEGIN IMMEDIATE");
			try {
				const result = fn();
				db.exec("COMMIT");
				return result;
			} catch (cause) {
				db.exec("ROLLBACK");
				throw cause;
			}
		},
		close: () => {
			if (db.isOpen) db.close();
		},
	};
};

/**
 * Open the per-workspace index DB. The directory is created if missing
 * (Electron may run with no `.zuse` folder on first boot). `:memory:`
 * is honored for unit tests and benches.
 */
export const openIndexDb = (
	filename: string,
): Effect.Effect<IndexDb, IndexDbError> =>
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
