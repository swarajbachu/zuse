import { Effect } from "effect";
import { expect, it } from "vitest";
import { closeIndexDb, openIndexDb } from "../../src/db/sqlite.ts";
import { branchExists } from "../../src/manifest/manifest.ts";
import { runMigrations } from "../../src/schema/migrations.ts";
import { indexSnapshot, snapshotManifestKey } from "../../src/snapshot.ts";

it("isolates immutable manifests and resolves static imports without guessing aliases", async () => {
	const db = await Effect.runPromise(openIndexDb(":memory:"));
	try {
		await Effect.runPromise(runMigrations(db));
		const result = await Effect.runPromise(
			indexSnapshot(db, {
				repository: "repo:1",
				sha: "a".repeat(40),
				paths: ["src/a.ts", "src/b.ts"],
				read: async (path) =>
					path === "src/a.ts"
						? 'import { b } from "./b";\nexport { x } from "@app/x";\nexport const a = b;'
						: "export const b = 1;",
			}),
		);
		expect(result.manifest).toBe(snapshotManifestKey("repo:1", "a".repeat(40)));
		expect(result.imports).toContainEqual({
			from: "src/a.ts",
			specifier: "./b",
			to: "src/b.ts",
			line: 1,
		});
		expect(result.imports).toContainEqual({
			from: "src/a.ts",
			specifier: "@app/x",
			to: null,
			line: 2,
		});
		expect(
			await Effect.runPromise(
				branchExists(db, snapshotManifestKey("repo:2", "a".repeat(40))),
			),
		).toBe(false);
	} finally {
		await Effect.runPromise(closeIndexDb(db));
	}
});
it("never publishes a manifest when snapshot reads fail midway", async () => {
	const db = await Effect.runPromise(openIndexDb(":memory:"));
	try {
		await Effect.runPromise(runMigrations(db));
		await expect(
			Effect.runPromise(
				indexSnapshot(db, {
					repository: "repo:1",
					sha: "b".repeat(40),
					paths: ["a.ts", "b.ts"],
					read: async (path) => (path === "a.ts" ? "export const a=1;" : null),
				}),
			),
		).rejects.toBeDefined();
		expect(
			await Effect.runPromise(
				branchExists(db, snapshotManifestKey("repo:1", "b".repeat(40))),
			),
		).toBe(false);
	} finally {
		await Effect.runPromise(closeIndexDb(db));
	}
});
it("refuses to overwrite an immutable manifest with different bytes", async () => {
	const db = await Effect.runPromise(openIndexDb(":memory:"));
	try {
		await Effect.runPromise(runMigrations(db));
		const source = {
			repository: "repo:1",
			sha: "c".repeat(40),
			paths: ["a.ts"],
			read: async () => "export const a=1;",
		};
		await Effect.runPromise(indexSnapshot(db, source));
		await expect(
			Effect.runPromise(
				indexSnapshot(db, { ...source, read: async () => "export const a=2;" }),
			),
		).rejects.toBeDefined();
		await expect(
			Effect.runPromise(indexSnapshot(db, source)),
		).resolves.toHaveProperty("manifest");
	} finally {
		await Effect.runPromise(closeIndexDb(db));
	}
});
