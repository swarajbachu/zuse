import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { closeIndexDb, openIndexDb } from "../../src/db/sqlite.ts";
import { indexRepo } from "../../src/indexer.ts";
import {
	listFileSymbols,
	lookupSymbol,
} from "../../src/retrieval/symbol-lookup.ts";
import { runMigrations } from "../../src/schema/migrations.ts";

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(eff as Effect.Effect<A, E, never>);

describe("symbol lookup — Tier 1", () => {
	it("finds an exported function by exact name across branches", async () => {
		const root = mkdtempSync(join(tmpdir(), "mz-sym-"));
		try {
			writeFileSync(
				join(root, "math.ts"),
				"export function add(a: number, b: number) { return a + b; }\n" +
					"export function sub(a: number, b: number) { return a - b; }\n",
			);

			const db = await run(openIndexDb(":memory:"));
			await run(runMigrations(db));
			await run(indexRepo(db, root, "main"));

			const hits = await run(lookupSymbol(db, "add", "main", undefined, 5));
			const addHit = hits.find((h) => h.name === "add");
			expect(addHit).toBeDefined();
			expect(addHit?.exported).toBe(true);
			expect(addHit?.file).toBe("math.ts");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("listFileSymbols enumerates module surface", async () => {
		const root = mkdtempSync(join(tmpdir(), "mz-list-"));
		try {
			mkdirSync(join(root, "lib"), { recursive: true });
			writeFileSync(
				join(root, "lib/api.ts"),
				"export class Api {\n  fetch() {}\n  send() {}\n}\nexport function helper() {}\n",
			);

			const db = await run(openIndexDb(":memory:"));
			await run(runMigrations(db));
			await run(indexRepo(db, root, "main"));

			const summary = await run(listFileSymbols(db, "lib/api.ts", "main"));
			const names = summary.map((s) => s.name);
			expect(names).toContain("Api");
			expect(names).toContain("helper");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
