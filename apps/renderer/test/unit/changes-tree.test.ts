import { describe, expect, test } from "vitest";
import {
	buildChangesTree,
	type ChangesTreeFolder,
	filterChangedFiles,
	flattenChangesTree,
} from "../../src/lib/changes-tree.ts";

const file = (path: string, additions = 1, deletions = 0) => ({
	path,
	additions,
	deletions,
});

describe("buildChangesTree", () => {
	test("sorts folders before files and sums folder stats", () => {
		const tree = buildChangesTree([
			file("README.md", 2, 1),
			file("src/b.ts", 3, 1),
			file("src/a.ts", 4, 2),
		]);
		expect(tree.map((node) => [node.type, node.name])).toEqual([
			["folder", "src"],
			["file", "README.md"],
		]);
		const src = tree[0] as ChangesTreeFolder<ReturnType<typeof file>>;
		expect(src).toMatchObject({ additions: 7, deletions: 3, fileCount: 2 });
		expect(src.children.map((node) => node.name)).toEqual(["a.ts", "b.ts"]);
		expect(src.children[0]?.depth).toBe(1);
	});

	test("compacts single-child folder chains", () => {
		const tree = buildChangesTree([
			file("apps/renderer/src/a.ts"),
			file("apps/renderer/src/lib/b.ts"),
		]);
		expect(tree).toHaveLength(1);
		const folder = tree[0] as ChangesTreeFolder<ReturnType<typeof file>>;
		expect(folder.name).toBe("apps/renderer/src");
		expect(folder.path).toBe("apps/renderer/src");
		expect(folder.fileCount).toBe(2);
		expect(folder.children.map((node) => node.path)).toEqual([
			"apps/renderer/src/lib",
			"apps/renderer/src/a.ts",
		]);
	});

	test("flatten skips collapsed folders", () => {
		const tree = buildChangesTree([file("src/a.ts"), file("b.ts")]);
		expect(
			flattenChangesTree(tree, new Set()).map((node) => node.path),
		).toEqual(["src", "src/a.ts", "b.ts"]);
		expect(
			flattenChangesTree(tree, new Set(["src"])).map((node) => node.path),
		).toEqual(["src", "b.ts"]);
	});
});

test("filterChangedFiles matches path substrings case-insensitively", () => {
	const files = [file("src/Button.tsx"), file("docs/readme.md")];
	expect(filterChangedFiles(files, "  ")).toBe(files);
	expect(filterChangedFiles(files, "button").map((f) => f.path)).toEqual([
		"src/Button.tsx",
	]);
	expect(filterChangedFiles(files, "zzz")).toEqual([]);
});
