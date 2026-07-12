import { resolve } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { countAll } from "../../src/blob/store.ts";
import { closeIndexDb, openIndexDb } from "../../src/db/sqlite.ts";
import { indexRepo } from "../../src/indexer.ts";
import { runMigrations } from "../../src/schema/migrations.ts";

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> =>
	Effect.runPromise(eff as Effect.Effect<A, E, never>);

describe("Phase A acceptance — index the memoize repo", () => {
	it("produces >5,000 chunks and >2,000 symbols", async () => {
		const repoRoot = resolve(__dirname, "../../../..");
		const db = await run(openIndexDb(":memory:"));
		await run(runMigrations(db));

		const t0 = Date.now();
		const result = await run(indexRepo(db, repoRoot, "main"));
		const elapsed = Date.now() - t0;
		const stats = await run(countAll(db));

		console.log(
			`[index-self] processed=${result.processed} chunks=${stats.chunks} symbols=${stats.symbols} blobs=${stats.blobs} elapsed=${elapsed}ms newBlobs=${result.newBlobs} deduped=${result.dedupedBlobs}`,
		);

		expect(stats.chunks).toBeGreaterThan(5_000);
		expect(stats.symbols).toBeGreaterThan(2_000);

		await run(closeIndexDb(db));
	}, 120_000);
});
