import { closeIndexDb, openIndexDb, runMigrations } from "@zuse/index";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { type ReviewSource, withIndexedReviewSource } from "../../src/index.ts";

it("uses shared indexed symbol context and import relationships for the pinned side", async () => {
	const db = await Effect.runPromise(openIndexDb(":memory:"));
	try {
		await Effect.runPromise(runMigrations(db));
		const source: ReviewSource = {
			snapshot: {
				repositoryId: 1,
				baseRef: "main",
				baseSha: "a".repeat(40),
				mergeBaseSha: "a".repeat(40),
				headSha: "b".repeat(40),
			},
			contextLimited: false,
			changes: [],
			files: { LEFT: ["a.ts"], RIGHT: ["a.ts", "b.ts"] },
			readFile: async (side, path) =>
				side === "LEFT"
					? "export const oldValue=1;"
					: path === "a.ts"
						? 'import { newValue } from "./b";\nexport const a = newValue;'
						: "export const newValue=2;",
		};
		const indexed = await withIndexedReviewSource(
			source,
			db,
			new AbortController().signal,
		);
		expect(indexed.contextLimited).toBe(false);
		expect(indexed.relatedFiles?.("a.ts", "RIGHT")).toContainEqual({
			path: "b.ts",
			kind: "imports",
			line: 1,
		});
		expect(indexed.relatedFiles?.("b.ts", "RIGHT")).toContainEqual({
			path: "a.ts",
			kind: "imported-by",
			line: 1,
		});
		expect(
			(await indexed.search?.("newValue", "RIGHT", 5))?.some(
				(hit) => hit.location.path === "b.ts",
			),
		).toBe(true);
		expect(await indexed.search?.("newValue", "LEFT", 5)).toEqual([]);
	} finally {
		await Effect.runPromise(closeIndexDb(db));
	}
});
