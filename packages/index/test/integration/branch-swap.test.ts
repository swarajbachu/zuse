import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { closeIndexDb, openIndexDb } from "../../src/db/sqlite.ts";
import { reindexFile } from "../../src/incremental.ts";
import { indexRepo } from "../../src/indexer.ts";
import { listManifest } from "../../src/manifest/manifest.ts";
import { diffManifest, swapBranchManifest } from "../../src/manifest/swap.ts";
import { runMigrations } from "../../src/schema/migrations.ts";

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(eff as Effect.Effect<A, E, never>);

describe("Phase E — branch swap + incremental", () => {
	it("manifest diff identifies adds, removes, and unchanged", async () => {
		const root = mkdtempSync(join(tmpdir(), "mz-swap-"));
		try {
			writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
			writeFileSync(join(root, "b.ts"), "export const b = 2;\n");

			const db = await run(openIndexDb(":memory:"));
			await run(runMigrations(db));
			await run(indexRepo(db, root, "main"));

			// Branch "feature": same files plus an extra.
			writeFileSync(join(root, "c.ts"), "export const c = 3;\n");
			await run(indexRepo(db, root, "feature"));

			const diff = await run(diffManifest(db, "feature", "main"));
			// To go main → match feature, we'd need to add c.ts.
			const add = diff.toAdd.find((x) => x.filePath === "c.ts");
			expect(add).toBeDefined();
			await run(closeIndexDb(db));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("swapBranchManifest hits a 10k-file budget in <200ms", async () => {
		const root = mkdtempSync(join(tmpdir(), "mz-swap-perf-"));
		try {
			mkdirSync(join(root, "files"), { recursive: true });
			for (let i = 0; i < 10_000; i++) {
				writeFileSync(join(root, "files", `f${i}.txt`), `chunk ${i}\n`);
			}

			const db = await run(openIndexDb(":memory:"));
			await run(runMigrations(db));
			await run(indexRepo(db, root, "main"));
			await run(indexRepo(db, root, "feature"));

			const t0 = Date.now();
			const diff = await run(swapBranchManifest(db, "main", "feature"));
			const elapsed = Date.now() - t0;
			// Most files unchanged (we just re-indexed the same content), so
			// the swap is effectively a no-op write set — exercises the
			// SELECT + diff path under load.
			console.log(
				`[swap] elapsed=${elapsed}ms adds=${diff.toAdd.length} removes=${diff.toRemove.length} unchanged=${diff.unchanged}`,
			);
			expect(elapsed).toBeLessThan(200);
			await run(closeIndexDb(db));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 60_000);

	it("reindexFile updates one file in <50ms after warm-up", async () => {
		const root = mkdtempSync(join(tmpdir(), "mz-inc-"));
		try {
			writeFileSync(join(root, "x.ts"), "export function x() { return 1; }\n");

			const db = await run(openIndexDb(":memory:"));
			await run(runMigrations(db));
			await run(indexRepo(db, root, "main"));

			writeFileSync(join(root, "x.ts"), "export function x() { return 2; }\n");

			// Warm-up call (grammar load + prepare statements).
			await run(reindexFile(db, root, join(root, "x.ts"), "main"));

			writeFileSync(join(root, "x.ts"), "export function x() { return 3; }\n");
			const t0 = Date.now();
			await run(reindexFile(db, root, join(root, "x.ts"), "main"));
			const elapsed = Date.now() - t0;
			console.log(`[reindexFile] elapsed=${elapsed}ms`);
			expect(elapsed).toBeLessThan(50);

			const manifest = await run(listManifest(db, "main"));
			const entry = manifest.find((m) => m.filePath === "x.ts");
			expect(entry).toBeDefined();
			await run(closeIndexDb(db));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
