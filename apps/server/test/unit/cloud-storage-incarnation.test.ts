import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";

import { cloudStorageIncarnationId } from "../../src/api/cloud-storage-incarnation.ts";

describe("cloud storage incarnation", () => {
	it("survives concurrent readers and a runtime restart on the same SQLite file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-incarnation-"));
		const filename = join(directory, "runtime.sqlite");
		const openRuntime = () =>
			ManagedRuntime.make(sqliteLayer({ filename, disableWAL: true }));
		try {
			const firstRuntime = openRuntime();
			const firstIds = await firstRuntime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`CREATE TABLE app_state (
						key TEXT PRIMARY KEY,
						value TEXT NOT NULL
					)`;
					return yield* Effect.all(
						Array.from({ length: 8 }, () => cloudStorageIncarnationId),
						{ concurrency: "unbounded" },
					);
				}),
			);
			await firstRuntime.dispose();

			const secondRuntime = openRuntime();
			const afterRestart = await secondRuntime.runPromise(
				cloudStorageIncarnationId,
			);
			await secondRuntime.dispose();

			expect(new Set(firstIds).size).toBe(1);
			expect(afterRestart).toBe(firstIds[0]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
