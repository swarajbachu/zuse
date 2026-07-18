import { describe, expect, test } from "vitest";

import { buildFileTree, flattenFileTree } from "../../../src/lib/file-tree";

describe("mobile file tree", () => {
	test("infers folders and keeps folders before files", () => {
		const tree = buildFileTree([
			"README.md",
			"src/components/Button.tsx",
			"src/app.tsx",
			"public/",
		]);
		expect(tree.map((node) => [node.path, node.kind])).toEqual([
			["public", "directory"],
			["src", "directory"],
			["README.md", "file"],
		]);
		expect(tree[1]?.children.map((node) => node.path)).toEqual([
			"src/components",
			"src/app.tsx",
		]);
	});

	test("expands selected folders and searches through collapsed descendants", () => {
		const tree = buildFileTree([
			"src/components/Button.tsx",
			"src/components/Card.tsx",
			"src/index.ts",
		]);
		expect(
			flattenFileTree({ nodes: tree, expanded: new Set(["src"]) }).map(
				(item) => [item.node.path, item.depth],
			),
		).toEqual([
			["src", 0],
			["src/components", 1],
			["src/index.ts", 1],
		]);
		expect(
			flattenFileTree({
				nodes: tree,
				expanded: new Set(),
				query: "button",
			}).map((item) => item.node.path),
		).toEqual(["src", "src/components", "src/components/Button.tsx"]);
	});
});
